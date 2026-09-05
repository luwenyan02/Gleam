import { describe, expect, it } from 'vitest';
import type { Entry } from '../src/core/types';
import {
  collapseRankRows,
  filterLedgerEntries,
  groupLedgerEntries,
  reportSelectionToLedgerQuery,
  summarizeLedgerEntries,
  type LedgerLookup,
} from '../src/core/ledgerQuery';

function entry(patch: Partial<Entry> & Pick<Entry, 'id' | 'type' | 'amount' | 'occurredAt'>): Entry {
  return {
    categoryId: undefined,
    accountId: undefined,
    reimburseStatus: 'none',
    deletedAt: 0,
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

const rows = [
  entry({ id: 1, type: 'expense', amount: 1_000, occurredAt: 10, categoryId: 1, accountId: 1, merchantId: 2, note: '客户午餐' }),
  entry({ id: 2, type: 'income', amount: 3_000, occurredAt: 20, categoryId: 2, accountId: 2, note: '九月工资' }),
  entry({ id: 3, type: 'expense', amount: 200, occurredAt: 30, categoryId: 1, accountId: 1, refundFlag: true }),
  entry({ id: 4, type: 'transfer', amount: 500, occurredAt: 40, fromAccountId: 1, toAccountId: 2 }),
];

const lookup: LedgerLookup = {
  categoryNames: new Map([[1, '餐饮'], [2, '工资']]),
  accountNames: new Map([[1, '现金'], [2, '工资卡']]),
  merchantNames: new Map([[2, '暖食堂']]),
  tagNamesByEntry: new Map([[1, ['出差']]]),
  tagIdsByEntry: new Map([[1, [8]]]),
};

describe('统一账单查询', () => {
  it('时间范围采用 [from, to)，并可叠加分类、账户、标签、商家和金额范围', () => {
    const result = filterLedgerEntries(rows, {
      from: 10,
      to: 30,
      types: ['expense'],
      categoryIds: [1],
      accountIds: [1],
      tagIds: [8],
      merchantIds: [2],
      amountMin: 900,
      amountMax: 1_100,
    }, lookup);

    expect(result.map((item) => item.id)).toEqual([1]);
  });

  it('全部字段关键词可命中分类、账户、标签、商家、备注与金额', () => {
    for (const keyword of ['餐饮', '现金', '出差', '暖食堂', '客户午餐', '10.00']) {
      expect(filterLedgerEntries(rows, { keyword, field: 'all' }, lookup).map((item) => item.id))
        .toContain(1);
    }
  });

  it('汇总与分组复用同一结果集，退款冲抵支出且转账不计收支', () => {
    const summary = summarizeLedgerEntries(rows);
    expect(summary).toEqual({ expense: 800, income: 3_000, balance: 2_200, expenseCount: 2, incomeCount: 1 });
    expect(groupLedgerEntries(rows).map((group) => group.day)).toEqual(['1970-01-01']);
  });

  it('报销口径可在冲抵支出与计入收入之间切换', () => {
    const reimbursed = entry({
      id: 5,
      type: 'expense',
      amount: 1_000,
      occurredAt: 50,
      reimburseStatus: 'done',
      reimbursedAmount: 400,
      reimbursedAt: 60,
    });
    expect(summarizeLedgerEntries([reimbursed], { reimburseMode: 'offset' }).expense).toBe(600);
    expect(summarizeLedgerEntries([reimbursed], { reimburseMode: 'income', reimburseIncome: 400 })).toMatchObject({
      expense: 1_000,
      income: 400,
      balance: -600,
    });
  });

  it('报表选择只描述周期、维度和选中项，并可转换为账单查询', () => {
    expect(reportSelectionToLedgerQuery({
      from: 100,
      to: 200,
      dimension: 'category',
      selectedIds: [3, 4],
    })).toEqual({ from: 100, to: 200, types: ['expense'], categoryIds: [3, 4] });
  });

  it('图表最多保留前五项，其余合并为其他', () => {
    const ranked = Array.from({ length: 7 }, (_, index) => ({ id: index + 1, name: `项目${index + 1}`, amount: 700 - index * 100 }));
    expect(collapseRankRows(ranked)).toEqual([
      ...ranked.slice(0, 5),
      { id: 'other', name: '其他', amount: 300 },
    ]);
  });
});
