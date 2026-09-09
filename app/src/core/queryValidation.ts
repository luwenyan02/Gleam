import { parseYuanToFen } from './money';

export function expandCategoryIds(ids: readonly number[], categories: readonly { id: number; parentId?: number }[]): number[] {
  const selected = new Set(ids);
  return [...new Set([...ids, ...categories.filter(c => c.parentId != null && selected.has(c.parentId)).map(c => c.id)])];
}

export function parseAmountRange(min: string, max: string): { amountMin?: number; amountMax?: number } {
  const amountMin = min.trim() ? parseYuanToFen(min) : undefined;
  const amountMax = max.trim() ? parseYuanToFen(max) : undefined;
  if (amountMin != null && amountMax != null && amountMin > amountMax) throw new Error('最小金额不能大于最大金额');
  return { amountMin, amountMax };
}

export function validateDateRange(from: number, to: number): void {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) throw new Error('开始日期不能晚于结束日期');
}
