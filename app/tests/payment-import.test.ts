import { describe, expect, it } from 'vitest';
import { parsePaymentFile } from '../src/features/import/payment';

function csvFile(lines: string[], name: string): File {
  return new File([`\uFEFF${lines.join('\r\n')}`], name, { type: 'text/csv' });
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
});
