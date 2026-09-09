import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { parseWacaiFile } from '../src/features/import/wacai';

const HEADERS = [
  '日期时间', '类型', '类别', '金额', '币种', '收付款人',
  '收付账户', '参与人', '标签', '商家', '属性', '备注',
];

function fileOf(rows: unknown[][]): File {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([HEADERS, ...rows]), '虚构安全测试');
  const bytes = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
  return new File([bytes], '虚构导入安全测试.xlsx', {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

describe('挖财导入安全回归', () => {
  it('外币总额分摊时将“自己”份额按同一币种汇率折算', async () => {
    const result = await parseWacaiFile(fileOf([
      ['2026-09-02 09:00', '支出', '旅行/餐饮', 10, '美元', '', '虚构现金', '自己:4.00, 同事:6.00', '', '', '', ''],
    ]));

    expect(result.issues).toEqual([]);
    expect(result.rows[0]?.amountFen).toBe(2856);
  });

  it('不可能的日历日期进入预检错误而不自动滚动到下月', async () => {
    const result = await parseWacaiFile(fileOf([
      ['2026-02-30 09:00', '支出', '餐饮/早餐', 10, '人民币', '', '虚构现金', '自己', '', '', '', ''],
    ]));

    expect(result.rows).toEqual([]);
    expect(result.issues[0]?.message).toContain('日期时间');
  });

  it('拒绝三条账户腿的转账而不静默丢弃额外腿', async () => {
    const result = await parseWacaiFile(fileOf([
      ['2026-09-03 09:00', '转账', '转账', 100, '人民币', '', '虚构现金:-100.00, 虚构卡A:+100.00, 虚构卡B:+100.00', '', '', '', '', ''],
    ]));

    expect(result.rows).toEqual([]);
    expect(result.issues[0]?.message).toContain('转账');
  });

  it('退款缺少原支出关联时进入异常待处理且默认不导入', async () => {
    const result = await parseWacaiFile(fileOf([
      ['2026-09-03 10:00', '支出', '购物/日用', 88, '人民币', '', '虚构现金', '自己', '', '', '退款', '虚构退款'],
    ]));

    expect(result.rows).toEqual([]);
    expect(result.counts.expense).toBe(0);
    expect(result.issues).toEqual([
      expect.objectContaining({ rowNo: 2, message: expect.stringContaining('退款') }),
    ]);
    expect(result.issues[0]?.message).toContain('无法关联原支出');
  });
});
