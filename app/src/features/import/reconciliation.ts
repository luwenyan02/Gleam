import type { Entry } from '../../core/types';
import { formatFen } from '../../core/money';
import type { WacaiParseResult, WacaiRow } from './wacai';
import { saveBlobFile } from '../backup/download';
import type { ImportBalanceCheck } from '../../core/repo/importSaveRepo';

export const IMPORT_TYPES = ['expense', 'income', 'transfer', 'loan'] as const;
export const IMPORT_TYPE_NAMES = { expense: '支出', income: '收入', transfer: '转账', loan: '借贷' };
export function summarizeImport(rows: readonly { type: Entry['type']; amountFen: number }[]) {
  const summary = Object.fromEntries(IMPORT_TYPES.map(type => [type, { count: 0, amount: 0 }])) as Record<Entry['type'], { count: number; amount: number }>;
  for (const row of rows) { summary[row.type].count++; summary[row.type].amount += row.amountFen; }
  return summary;
}

function dateText(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

/** 核对文件只在设备本地生成；金额字符串避免 Excel 浮点显示误差。 */
export async function exportImportReconciliation(result: WacaiParseResult, imported: readonly WacaiRow[], saved: readonly Entry[], balances: readonly ImportBalanceCheck[]): Promise<void> {
  const XLSX = await import('xlsx');
  const wb = XLSX.utils.book_new();
  const expected = summarizeImport(result.rows);
  const actual = summarizeImport(saved.map(e => ({ type: e.type, amountFen: e.amount })));
  const overview: unknown[][] = [['类型', '原文件有效笔数', '实际导入笔数', '原文件有效金额(元)', '实际导入金额(元)', '差额(元)'],
    ...IMPORT_TYPES.map(type => [IMPORT_TYPE_NAMES[type], expected[type].count, actual[type].count, formatFen(expected[type].amount), formatFen(actual[type].amount), formatFen(actual[type].amount - expected[type].amount)]),
    ['异常未导入行', result.issues.length], ['说明', '退款/收入冲回按原始负数计算；转账、借贷不计入收支。账户余额从零计算流水净变动，导出文件不含期初余额。']];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(overview), '核对汇总');
  const byRow = new Map(imported.map((row, i) => [row.rowNo, saved[i]]));
  const detail: unknown[][] = [['原表行号', '导入状态', '拾光账单ID', '原日期时间', '类型', '原分类', '账户', '对方账户', '原有效金额(元)', '入库金额(元)'],
    ...result.rows.map(row => {
      const entry = byRow.get(row.rowNo);
      return [row.rowNo, entry ? '已导入' : '疑似重复跳过', entry?.id ?? '', dateText(row.occurredAt), IMPORT_TYPE_NAMES[row.type], row.categoryKey ?? row.loanKind ?? '', row.accountName ?? row.fromAccountName ?? '', row.loanAccountName ?? row.toAccountName ?? '', formatFen(row.amountFen), entry ? formatFen(entry.amount) : ''];
    }), ...result.issues.map(issue => [issue.rowNo, `格式异常：${issue.message}`])];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(detail), '逐笔核对');
  const monthly = new Map<string, { type: Entry['type']; amountFen: number }[]>();
  for (const entry of saved) {
    const month = dateText(entry.occurredAt).slice(0, 7);
    const rows = monthly.get(month) ?? [];
    rows.push({ type: entry.type, amountFen: entry.amount }); monthly.set(month, rows);
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['自然月', '支出笔数', '支出净额(元)', '收入笔数', '收入净额(元)', '转账笔数', '转账金额(元)', '借贷笔数', '借贷金额(元)'],
    ...[...monthly.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, rows]) => {
      const totals = summarizeImport(rows);
      return [month, ...IMPORT_TYPES.flatMap(type => [totals[type].count, formatFen(totals[type].amount)])];
    }),
  ]), '按月核对');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['账户', '导入前拾光余额(元)', '本次流水净变动(元)', '导入后拾光余额(元)', '说明'],
    ...balances.map(account => [account.name, formatFen(account.before), formatFen(account.change), formatFen(account.after), '挖财期初余额未提供，请与挖财账户余额另行核对']),
  ]), '账户核对');
  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name];
    const columns = XLSX.utils.decode_range(sheet['!ref']!).e.c + 1;
    sheet['!cols'] = Array.from({ length: columns }, (_, i) => ({ wch: i === 0 ? 22 : 26 }));
    sheet['!autofilter'] = { ref: sheet['!ref']! };
  }
  const bytes = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  await saveBlobFile(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), '挖财导入核对.xlsx');
}
