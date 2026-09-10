import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { parsePaymentFile } from '../src/features/import/payment';

function csvFile(lines: string[], name: string): File {
  return new File([`\uFEFF${lines.join('\r\n')}`], name, { type: 'text/csv' });
}

function utf16LeFile(content: string, name: string): File {
  const bytes = new Uint8Array(2 + content.length * 2);
  bytes[0] = 0xff;
  bytes[1] = 0xfe;
  for (let index = 0; index < content.length; index++) {
    const code = content.charCodeAt(index);
    bytes[2 + index * 2] = code & 0xff;
    bytes[3 + index * 2] = code >> 8;
  }
  return new File([bytes], name, { type: 'text/csv' });
}

describe('微信与支付宝本地账单解析', () => {
  it('微信只把明确成功的收支转成草稿，退款、中性交易和失败交易进入异常列表', async () => {
    const file = csvFile([
      '微信支付账单明细,,,,,,,,,,',
      '微信昵称：[虚构用户],,,,,,,,,,',
      '起始时间：[2026-09-01 00:00:00],,,,,,,,,,',
      '终止时间：[2026-09-09 23:59:59],,,,,,,,,,',
      '共5笔记录,,,,,,,,,,',
      ',,,,,,,,,,',
      '交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,商户单号,备注',
      '2026-09-01 12:30:12,商户消费,虚构小馆,虚构午餐,支出,¥28.50,零钱,支付成功,wx-fiction-1,m-fiction-1,工作餐',
      '2026-09-02 08:10:00,红包,虚构好友,虚构红包,收入,¥8.88,/,已存入零钱,wx-fiction-2,,',
      '2026-09-03 09:00:00,零钱提现,腾讯财付通,零钱提现,/,¥100.00,零钱,提现已到账,wx-fiction-3,,',
      '2026-09-04 10:00:00,商户消费,虚构商店,虚构退款商品,支出,¥20.00,零钱,已全额退款,wx-fiction-4,,',
      '2026-09-05 11:00:00,商户消费,虚构商店,虚构失败商品,支出,¥18.00,零钱,支付失败,wx-fiction-5,,',
    ], '微信支付账单(20260909).csv');

    const result = await parsePaymentFile(file, 'wechat');

    expect(result.source).toBe('wechat');
    expect(result.counts).toEqual({ expense: 1, income: 1, transfer: 0, loan: 0 });
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({
      rowNo: 8,
      source: 'wechat',
      type: 'expense',
      amountFen: 2850,
      accountName: '微信零钱',
      categoryKey: '其他/微信支付',
      merchant: '虚构小馆',
      externalId: 'wx-fiction-1',
    });
    expect(result.rows[0]?.note).toContain('商品：虚构午餐');
    expect(result.rows[1]).toMatchObject({ type: 'income', amountFen: 888, accountName: '微信零钱' });
    expect(result.issues).toHaveLength(3);
    expect(result.issues.map((issue) => issue.message).join('\n')).toContain('中性');
    expect(result.issues.map((issue) => issue.message).join('\n')).toContain('退款');
    expect(result.issues.map((issue) => issue.message).join('\n')).toContain('失败');
  });

  it('支付宝兼容本地导出的新表头，退款金额和不计收支不会误记为普通收支', async () => {
    const file = csvFile([
      '支付宝交易记录明细查询,,,,,,,,,,,',
      '账号：[fiction@example.invalid],,,,,,,,,,,',
      '交易时间,交易分类,交易对方,对方账号,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号,商家订单号,备注,成功退款（元）',
      '2026-09-01 13:20:10,餐饮美食,虚构面馆,,虚构晚餐,支出,32.10,余额,交易成功,ali-fiction-1,m-fiction-1,聚餐,0.00',
      '2026-09-02 09:12:00,其他,虚构公司,,虚构补贴,收入,66.00,余额宝,交易成功,ali-fiction-2,,补贴,0.00',
      '2026-09-03 08:00:00,转账充值,虚构银行,,余额宝转入,不计收支,100.00,银行卡,交易成功,ali-fiction-3,,,0.00',
      '2026-09-04 08:00:00,日用百货,虚构商店,,虚构部分退款,支出,40.00,花呗,交易成功,ali-fiction-4,,,5.00',
      '2026-09-05 08:00:00,日用百货,虚构商店,,虚构关闭交易,支出,12.00,花呗,交易关闭,ali-fiction-5,,,0.00',
    ], '支付宝交易明细(20260909).csv');

    const result = await parsePaymentFile(file, 'alipay');

    expect(result.source).toBe('alipay');
    expect(result.counts).toEqual({ expense: 1, income: 1, transfer: 0, loan: 0 });
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({
      rowNo: 4,
      source: 'alipay',
      type: 'expense',
      amountFen: 3210,
      accountName: '支付宝余额',
      categoryKey: '其他/支付宝账单',
      merchant: '虚构面馆',
      externalId: 'ali-fiction-1',
    });
    expect(result.rows[1]).toMatchObject({
      type: 'income', amountFen: 6600, accountName: '余额宝', categoryKey: '其他收入',
    });
    expect(result.issues).toHaveLength(3);
    expect(result.issues.map((issue) => issue.message).join('\n')).toContain('不计收支');
    expect(result.issues.map((issue) => issue.message).join('\n')).toContain('退款');
    expect(result.issues.map((issue) => issue.message).join('\n')).toContain('交易关闭');
  });

  it('微信兼容制表符分隔、带逗号及换行的引号字段', async () => {
    const content = [
      '微信支付账单明细',
      '交易时间\t交易类型\t交易对方\t商品\t收/支\t金额(元)\t支付方式\t当前状态\t交易单号\t备注',
      '2026-09-06 12:30:00\t商户消费\t"虚构,小馆"\t"虚构午餐\n套餐"\t支出\t18.60\t零钱通\t支付成功\twx-tab-fiction\t"备注,含逗号"',
    ].join('\r\n');

    const result = await parsePaymentFile(new File([`\uFEFF${content}`], '微信支付账单.txt'), 'wechat');

    expect(result.issues).toEqual([]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      type: 'expense', amountFen: 1860, merchant: '虚构,小馆', accountName: '微信零钱通',
      externalId: 'wx-tab-fiction',
    });
    expect(result.rows[0]?.note).toContain('虚构午餐\n套餐');
    expect(result.rows[0]?.note).toContain('备注,含逗号');
  });

  it('支付宝兼容 UTF-16LE 编码及旧版等价表头', async () => {
    const content = [
      '支付宝交易记录',
      '交易创建时间,类型,收付款人,商品名称,收支,金额（元）,付款方式,状态,交易号,备注',
      '2026/09/07 08:05:06,餐饮,虚构早餐铺,虚构早餐,支出,9.90,余额,交易成功,ali-utf16-fiction,晨间消费',
    ].join('\r\n');

    const result = await parsePaymentFile(utf16LeFile(content, '支付宝交易记录.csv'), 'alipay');

    expect(result.issues).toEqual([]);
    expect(result.rows).toEqual([
      expect.objectContaining({
        type: 'expense', amountFen: 990, merchant: '虚构早餐铺', accountName: '支付宝余额',
        externalId: 'ali-utf16-fiction',
      }),
    ]);
  });

  it('微信 Excel 文件兼容数值日期和本地工作表', async () => {
    const serial = (Date.UTC(2026, 8, 8, 14, 20) - Date.UTC(1899, 11, 30)) / 86_400_000;
    const sheet = XLSX.utils.aoa_to_sheet([
      ['微信支付账单明细'],
      ['交易时间', '交易类型', '交易对方', '商品', '收/支', '金额(元)', '支付方式', '当前状态', '交易单号'],
      [serial, '商户消费', '虚构文具店', '虚构笔记本', '支出', 12.34, '零钱', '支付成功', 'wx-xlsx-fiction'],
    ]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, '账单明细');
    const file = new File(
      [XLSX.write(workbook, { type: 'array', bookType: 'xlsx' })],
      '微信支付账单.xlsx',
      { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
    );

    const result = await parsePaymentFile(file, 'wechat');

    expect(result.issues).toEqual([]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ amountFen: 1234, merchant: '虚构文具店', externalId: 'wx-xlsx-fiction' });
    expect(new Date(result.rows[0]!.occurredAt)).toEqual(new Date(2026, 8, 8, 14, 20));
  });
});
