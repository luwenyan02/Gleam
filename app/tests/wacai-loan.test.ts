import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { formatWacaiPair, parseWacaiFile, type WacaiRow } from '../src/features/import/wacai';
import { wacaiLoanAccountText } from '../src/features/backup/excel';
import { buildAccountPlans } from '../src/features/import/accountMapping';
import type { Account, AccountGroup } from '../src/core/types';

const HEADERS = [
  '日期时间', '类型', '类别', '金额', '币种', '收付款人',
  '收付账户', '参与人', '标签', '商家', '属性', '备注',
];

function fileOf(rows: unknown[][]): File {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([HEADERS, ...rows]), 'sheet1');
  const bytes = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
  return new File([bytes], '虚构借贷账单.xlsx', {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

function loanRow(category: string, payee: string, account: string, amount = 100): unknown[] {
  return ['2026-09-01 08:30', '借贷', category, amount, '人民币', payee, account, '自己', '', '', '', ''];
}

function sides(row: WacaiRow): Pick<WacaiRow, 'loanKind' | 'accountName' | 'loanAccountName' | 'fromAccountName' | 'toAccountName'> {
  return {
    loanKind: row.loanKind,
    accountName: row.accountName,
    loanAccountName: row.loanAccountName,
    fromAccountName: row.fromAccountName,
    toAccountName: row.toAccountName,
  };
}

function parsedRow(fields: Partial<WacaiRow>): WacaiRow {
  return {
    rowNo: 2, type: 'transfer', occurredAt: 1, amountFen: 100,
    tags: [], reimburseDone: false, note: '', ...fields,
  };
}

function account(id: number, name: string, group: AccountGroup): Account {
  return {
    id, name, group, balance: 0, hidden: false, countInNetWorth: true,
    sortOrder: id, createdAt: 1, updatedAt: 1,
  };
}

describe('挖财借贷解析为应收应付双账户', () => {
  it('解析四类“收付账户单值 + 收付款人双边”格式', async () => {
    const result = await parseWacaiFile(fileOf([
      loanRow('借出', '自己:-100.00, 张三:+100.00', '现金'),
      loanRow('还款', '自己:-100.00, 银行:+100.00', '储蓄卡'),
      loanRow('借入', '李四:-100.00, 自己:+100.00', '微信'),
      loanRow('收款', '王五:-100.00, 自己:+100.00', '支付宝'),
    ]));

    expect(result.issues).toEqual([]);
    expect(result.rows.map(sides)).toEqual([
      { loanKind: 'lend', accountName: '现金', loanAccountName: '张三', fromAccountName: '现金', toAccountName: '张三' },
      { loanKind: 'repay', accountName: '储蓄卡', loanAccountName: '银行', fromAccountName: '储蓄卡', toAccountName: '银行' },
      { loanKind: 'borrow', accountName: '微信', loanAccountName: '李四', fromAccountName: '李四', toAccountName: '微信' },
      { loanKind: 'collect', accountName: '支付宝', loanAccountName: '王五', fromAccountName: '王五', toAccountName: '支付宝' },
    ]);
    expect(result.accountNames).toEqual(expect.arrayContaining([
      '现金', '张三', '储蓄卡', '银行', '微信', '李四', '支付宝', '王五',
    ]));
  });

  it('解析四类“收付账户双边”格式', async () => {
    const result = await parseWacaiFile(fileOf([
      loanRow('借出', '', '现金:-100.00, 张三:+100.00'),
      loanRow('还款', '', '储蓄卡:-100.00, 银行:+100.00'),
      loanRow('借入', '', '李四:-100.00, 微信:+100.00'),
      loanRow('收款', '', '王五:-100.00, 支付宝:+100.00'),
    ]));

    expect(result.issues).toEqual([]);
    expect(result.rows.map(sides)).toEqual([
      { loanKind: 'lend', accountName: '现金', loanAccountName: '张三', fromAccountName: '现金', toAccountName: '张三' },
      { loanKind: 'repay', accountName: '储蓄卡', loanAccountName: '银行', fromAccountName: '储蓄卡', toAccountName: '银行' },
      { loanKind: 'borrow', accountName: '微信', loanAccountName: '李四', fromAccountName: '李四', toAccountName: '微信' },
      { loanKind: 'collect', accountName: '支付宝', loanAccountName: '王五', fromAccountName: '王五', toAccountName: '支付宝' },
    ]);
  });

  it('拒绝与借贷类别方向不符的双腿符号', async () => {
    const result = await parseWacaiFile(fileOf([
      loanRow('借出', '张三:-100.00, 自己:+100.00', '现金'),
    ]));

    expect(result.rows).toEqual([]);
    expect(result.issues[0]?.message).toContain('方向');
  });

  it('拒绝缺少对方或多个对方的模糊借贷行', async () => {
    const result = await parseWacaiFile(fileOf([
      loanRow('借入', '自己:+100.00', '现金'),
      loanRow('借出', '', '现金:-100.00, 张三:+50.00, 李四:+50.00'),
    ]));

    expect(result.rows).toEqual([]);
    expect(result.issues).toHaveLength(2);
    expect(result.issues.map((issue) => issue.message).join('\n')).not.toContain('未指明对象');
  });

  it('外币借贷以原币金额互校双腿，两种格式仍按现有汇率折算', async () => {
    const single = loanRow('借出', '自己:-10.00, 张三:+10.00', '现金', 10);
    single[4] = '美元';
    const double = loanRow('借入', '', '李四:-10.00, 储蓄卡:+10.00', 10);
    double[4] = '美元';

    const result = await parseWacaiFile(fileOf([single, double]));

    expect(result.issues).toEqual([]);
    expect(result.rows).toHaveLength(2);
    expect(result.rows.map((row) => row.amountFen)).toEqual([7140, 7140]);
    expect(result.rows.map((row) => [row.accountName, row.loanAccountName])).toEqual([
      ['现金', '张三'], ['储蓄卡', '李四'],
    ]);
    expect(result.rows.every((row) => row.note.includes('按导入时参考汇率 7.14 折算'))).toBe(true);
  });

  it('不改变普通支出的单账户解析', async () => {
    const result = await parseWacaiFile(fileOf([
      ['2026-09-01 09:00', '支出', '餐饮/早餐', 18.5, '人民币', '', '现金', '自己', '', '', '', ''],
    ]));

    expect(result.issues).toEqual([]);
    expect(result.rows[0]).toMatchObject({ type: 'expense', amountFen: 1850, accountName: '现金' });
  });

  it('导出的四类借贷双账户可被再次读回', async () => {
    const names = new Map([[1, '现金'], [2, '张三']]);
    const categories = [
      ['借出', 'lend'], ['还款', 'repay'], ['借入', 'borrow'], ['收款', 'collect'],
    ] as const;
    const file = fileOf(categories.map(([category, loanKind]) => loanRow(
      category,
      '',
      wacaiLoanAccountText({
        type: 'loan', loanKind,
        fromAccountId: loanKind === 'lend' || loanKind === 'repay' ? 1 : 2,
        toAccountId: loanKind === 'lend' || loanKind === 'repay' ? 2 : 1,
      }, names, '100.00'),
    )));

    const result = await parseWacaiFile(file);
    expect(result.issues).toEqual([]);
    expect(result.rows.map((row) => [row.loanKind, row.accountName, row.loanAccountName])).toEqual([
      ['lend', '现金', '张三'], ['repay', '现金', '张三'],
      ['borrow', '现金', '张三'], ['collect', '现金', '张三'],
    ]);
  });

  it('导出并读回含冒号、逗号和引号的借贷账户原名', async () => {
    const names = new Map([[1, '现"金,备用'], [2, '张三：房租']]);
    const accountText = wacaiLoanAccountText({
      type: 'loan', loanKind: 'lend', fromAccountId: 1, toAccountId: 2,
    }, names, '100.00');
    const result = await parseWacaiFile(fileOf([
      loanRow('借出', '', accountText),
    ]));

    expect(accountText).toBe('"现\\"金,备用":-100.00, "张三：房租":+100.00');
    expect(result.issues).toEqual([]);
    expect(result.rows[0]).toMatchObject({
      accountName: '现"金,备用', loanAccountName: '张三：房租',
      fromAccountName: '现"金,备用', toAccountName: '张三：房租',
    });
  });

  it('兼容未加引号但名称含中文冒号的旧双账户格式', async () => {
    const result = await parseWacaiFile(fileOf([
      loanRow('借出', '', '现金:-100.00, 张三：房租:+100.00'),
    ]));

    expect(result.issues).toEqual([]);
    expect(result.rows[0]).toMatchObject({ accountName: '现金', loanAccountName: '张三：房租' });
  });

  it('普通转账也可读回特殊账户原名', async () => {
    const pairText = `${formatWacaiPair('现金,备用', '-25.00')}, ${formatWacaiPair('张三：房租', '+25.00')}`;
    const result = await parseWacaiFile(fileOf([
      ['2026-09-01 09:00', '转账', '转账', 25, '人民币', '', pairText, '', '', '', '', ''],
    ]));

    expect(result.issues).toEqual([]);
    expect(result.rows[0]).toMatchObject({
      type: 'transfer', fromAccountName: '现金,备用', toAccountName: '张三：房租',
    });
  });

  it('单资金账户名含中英文冒号时仍按payee解析两种方向', async () => {
    const result = await parseWacaiFile(fileOf([
      loanRow('借出', '自己:-100.00，张三:+100.00', '招行：工资卡'),
      loanRow('借入', '李四：-100.00, 自己：+100.00', 'Wallet:Salary'),
    ]));

    expect(result.issues).toEqual([]);
    expect(result.rows.map((row) => [row.loanKind, row.accountName, row.loanAccountName])).toEqual([
      ['lend', '招行：工资卡', '张三'], ['borrow', 'Wallet:Salary', '李四'],
    ]);
  });

  it('有payee时仍拒绝金额不等或多方的明显损坏双账户', async () => {
    const result = await parseWacaiFile(fileOf([
      loanRow('借出', '自己:-100.00, 张三:+100.00', '现金:-90.00, 张三:+90.00'),
      loanRow('借出', '自己:-100.00, 张三:+100.00', '现金:-100.00, 张三:+50.00, 李四:+50.00'),
    ]));

    expect(result.rows).toEqual([]);
    expect(result.issues).toHaveLength(2);
    expect(result.issues[0]?.message).toContain('双腿金额');
    expect(result.issues[1]?.message).toContain('转出方和一个转入方');
  });
});

describe('挖财账户映射角色约束', () => {
  it('普通转账可复用已有应收应付账户', () => {
    const plans = buildAccountPlans([
      parsedRow({ type: 'transfer', fromAccountName: '现金', toAccountName: '张三' }),
    ], [account(1, '现金', 'cash'), account(2, '张三', 'receivable')]);

    expect(plans.find((plan) => plan.name === '张三')).toMatchObject({
      role: 'general', matchedId: 2, choice: 2, ambiguous: false,
    });
  });

  it('借贷对方与普通转账同名时共用一个应收应付映射', () => {
    const rows = [
      parsedRow({ type: 'transfer', fromAccountName: '现金', toAccountName: '张三' }),
      parsedRow({ type: 'loan', loanKind: 'lend', accountName: '现金', loanAccountName: '张三' }),
    ];
    const newPlans = buildAccountPlans(rows, [account(1, '现金', 'cash')]);
    const sharedNew = newPlans.filter((plan) => plan.name === '张三');
    expect(sharedNew).toHaveLength(1);
    expect(sharedNew[0]).toMatchObject({ role: 'loan', group: 'receivable', choice: 'auto' });
    expect(sharedNew[0].usages).toEqual(expect.arrayContaining(['general', 'loan']));

    const existingPlans = buildAccountPlans(rows, [
      account(1, '现金', 'cash'), account(2, '张三', 'receivable'),
    ]);
    expect(existingPlans.filter((plan) => plan.name === '张三')).toMatchObject([
      { role: 'loan', matchedId: 2, choice: 2 },
    ]);
  });

  it('借贷资金侧不能匹配或新建为应收应付账户', () => {
    const plans = buildAccountPlans([
      parsedRow({ type: 'loan', loanKind: 'lend', accountName: '应收专户', loanAccountName: '张三' }),
    ], [account(9, '应收专户', 'receivable')]);

    expect(plans.find((plan) => plan.role === 'fund')).toMatchObject({
      name: '应收专户', matchedId: undefined, choice: 'auto', group: 'other',
    });
  });

  it('普通用途同名普通账户与应收应付账户时要求用户选择', () => {
    const plans = buildAccountPlans([
      parsedRow({ type: 'transfer', fromAccountName: '现金', toAccountName: '张三' }),
    ], [account(1, '张三', 'debit'), account(2, '张三', 'receivable')]);

    expect(plans.find((plan) => plan.name === '张三')).toMatchObject({
      role: 'general', matchedId: undefined, choice: undefined, ambiguous: true,
    });
  });

  it('借贷对方与普通转账同名且本地跨分组重名时保留普通用途选择', () => {
    const plans = buildAccountPlans([
      parsedRow({ type: 'loan', loanKind: 'lend', accountName: '现金', loanAccountName: '张三' }),
      parsedRow({ type: 'transfer', fromAccountName: '现金', toAccountName: '张三' }),
    ], [
      account(1, '现金', 'cash'), account(2, '张三', 'debit'), account(3, '张三', 'receivable'),
    ]);
    const sameName = plans.filter((plan) => plan.name === '张三');

    expect(sameName).toHaveLength(2);
    expect(sameName.find((plan) => plan.role === 'loan')).toMatchObject({
      usages: ['loan'], matchedId: 3, choice: 3,
    });
    expect(sameName.find((plan) => plan.role === 'general')).toMatchObject({
      usages: ['general'], matchedId: undefined, choice: undefined, ambiguous: true,
    });
  });

  it('借贷资金侧与普通转账同名且本地跨分组重名时也保留普通选择', () => {
    const plans = buildAccountPlans([
      parsedRow({ type: 'loan', loanKind: 'lend', accountName: '现金', loanAccountName: '张三' }),
      parsedRow({ type: 'transfer', fromAccountName: '储蓄卡', toAccountName: '现金' }),
    ], [
      account(1, '现金', 'cash'), account(2, '现金', 'receivable'), account(3, '张三', 'receivable'),
    ]);
    const sameName = plans.filter((plan) => plan.name === '现金');

    expect(sameName).toHaveLength(2);
    expect(sameName.find((plan) => plan.role === 'fund')).toMatchObject({ matchedId: 1, choice: 1 });
    expect(sameName.find((plan) => plan.role === 'general')).toMatchObject({
      matchedId: undefined, choice: undefined, ambiguous: true,
    });
  });
});
