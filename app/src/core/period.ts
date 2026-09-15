/**
 * 财务月纯计算。财务月键仍使用 YYYY-MM，表示该周期起始日所在月份。
 * 只允许 1–28，确保每个自然月都存在该日期，不需要月末钳制规则。
 */

export interface TimeRange {
  from: number;
  to: number;
}

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function validateAccountingMonthStartDay(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 28) {
    throw new Error('财务月起始日须为 1–28 的整数');
  }
  return value;
}

function parseMonth(month: string): { year: number; monthIndex: number } {
  const match = MONTH_RE.exec(month);
  if (!match) throw new Error('月份无效');
  return { year: Number(match[1]), monthIndex: Number(match[2]) - 1 };
}

export function monthKey(year: number, monthIndex: number): string {
  const normalized = new Date(year, monthIndex, 1);
  return `${normalized.getFullYear()}-${String(normalized.getMonth() + 1).padStart(2, '0')}`;
}

export function shiftMonthKey(month: string, offset: number): string {
  if (!Number.isSafeInteger(offset)) throw new Error('月份偏移无效');
  const parsed = parseMonth(month);
  return monthKey(parsed.year, parsed.monthIndex + offset);
}

export function accountingMonthForTimestamp(timestamp: number, startDay: number): string {
  validateAccountingMonthStartDay(startDay);
  if (!Number.isFinite(timestamp)) throw new Error('时间无效');
  const date = new Date(timestamp);
  const offset = date.getDate() < startDay ? -1 : 0;
  return monthKey(date.getFullYear(), date.getMonth() + offset);
}

export function accountingMonthRangeForStartDay(month: string, startDay: number): TimeRange {
  validateAccountingMonthStartDay(startDay);
  const parsed = parseMonth(month);
  return {
    from: new Date(parsed.year, parsed.monthIndex, startDay).getTime(),
    to: new Date(parsed.year, parsed.monthIndex + 1, startDay).getTime(),
  };
}

export function formatAccountingRange(range: TimeRange): string {
  const from = new Date(range.from);
  const to = new Date(range.to);
  to.setDate(to.getDate() - 1);
  const text = (date: Date) => `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
  return `${text(from)} – ${text(to)}`;
}

export function accountingRangeProgress(range: TimeRange, timestamp = Date.now()): {
  elapsedDays: number;
  totalDays: number;
  remainingDays: number;
  percent: number;
} {
  const start = new Date(range.from);
  const end = new Date(range.to);
  const today = new Date(timestamp);
  start.setHours(0, 0, 0, 0);
  end.setHours(0, 0, 0, 0);
  today.setHours(0, 0, 0, 0);
  const dayNumber = (date: Date) => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000;
  const totalDays = Math.max(1, dayNumber(end) - dayNumber(start));
  const elapsedDays = Math.max(0, Math.min(totalDays, dayNumber(today) - dayNumber(start) + 1));
  return {
    elapsedDays,
    totalDays,
    remainingDays: Math.max(1, totalDays - Math.max(1, elapsedDays) + 1),
    percent: (elapsedDays / totalDays) * 100,
  };
}
