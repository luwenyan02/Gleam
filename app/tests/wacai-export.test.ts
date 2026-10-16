import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { parseWacaiFile } from '../src/features/import/wacai';

const headers = ['日期时间', '类型', '类别', '金额', '币种', '收付款人', '收付账户', '参与人', '标签', '商家', '属性', '备注'];
function exportFile(rows: unknown[][], count = rows.length): File {
  const wb = XLSX.utils.book_new();
  const grid = [['挖财记账导出明细'], ['操作人：虚构用户'], ['导出账本：虚构账本'], ['账单时间：虚构范围'], [`总笔数：${count}笔`], ['挖财记账账单明细列表'], headers, ...rows];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(grid), 'Sheet0');
  return new File([XLSX.write(wb, { type: 'array', bookType: 'xlsx' })], '虚构挖财导出.xlsx');
}
const row = (amount = 18, type = '支出', attr = '') => ['2026-10-15 18:28:38', type, '餐饮/晚餐', amount, '人民币', '', '虚构现金', '自己', '', '', attr, ''];

describe('挖财官方导出布局', () => {
  it('跳过导出说明并保留真实行号与秒数', async () => {
    const result = await parseWacaiFile(exportFile([row()]));
    expect(result.issues).toEqual([]);
    expect(result.rows[0].rowNo).toBe(8);
    expect(new Date(result.rows[0].occurredAt).getSeconds()).toBe(38);
  });
  it('导出声明笔数与数据不符时拒绝导入', async () => {
    await expect(parseWacaiFile(exportFile([row()], 2))).rejects.toThrow('总笔数');
  });
  it('保留负数退款、收入冲回及零金额收入，不虚构原账单关联', async () => {
    const result = await parseWacaiFile(exportFile([row(-18, '支出', '退款'), row(-5, '收入', '退款'), row(0, '收入')]));
    expect(result.issues).toEqual([]);
    expect(result.rows.map(r => r.amountFen)).toEqual([-1800, -500, 0]);
    expect(result.counts).toEqual({ expense: 1, income: 2, transfer: 0, loan: 0 });
  });
});
