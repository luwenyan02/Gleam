import type { Entry } from '../../core/types';
import { summarizeLedgerEntries, type LedgerSummary, type LedgerSummaryOptions } from '../../core/ledgerQuery';
import { accountingMonthForTimestamp, accountingMonthRangeForStartDay, shiftMonthKey, type TimeRange } from '../../core/period';

export interface HomeMonthSummary extends TimeRange, LedgerSummary { month: string }

export function homeTimelineWindow(month: string, startDay: number, count: number) {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('月份数量无效');
  const periods = Array.from({ length: count }, (_, i) => {
    const key = shiftMonthKey(month, -i);
    return { month: key, ...accountingMonthRangeForStartDay(key, startDay) };
  });
  return { periods, from: periods.at(-1)!.from, to: periods[0].to };
}

export function homeMonthSummaries(entries: readonly Entry[], periods: readonly (TimeRange & { month: string })[], startDay: number, options: LedgerSummaryOptions): HomeMonthSummary[] {
  const groups = new Map<string, Entry[]>();
  for (const entry of entries) {
    if (entry.deletedAt !== 0) continue;
    const key = accountingMonthForTimestamp(entry.occurredAt, startDay);
    const rows = groups.get(key) ?? [];
    rows.push(entry); groups.set(key, rows);
  }
  return periods.map(period => ({ ...period, ...summarizeLedgerEntries(groups.get(period.month) ?? [], options) }));
}

/** 按实际显示位置选择摘要月份，兼容首页自定义模块排序。 */
export function visibleHomeMonth(rows: readonly { month: string; top: number; bottom: number }[], edge: number, fallback: string): string {
  const visible = rows.filter(row => row.bottom > edge).sort((a, b) => a.top - b.top);
  return visible[0]?.month ?? [...rows].sort((a, b) => b.bottom - a.bottom)[0]?.month ?? fallback;
}
