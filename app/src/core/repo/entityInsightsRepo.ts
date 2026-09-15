import { db } from '../db';
import type { Entry, EntryType, Merchant, Tag } from '../types';
import type { LedgerItem } from '../ledgerEvents';
import { summarizeLedgerEntries, type LedgerSummary } from '../ledgerQuery';
import { ledgerEntriesInRange } from './statsRepo';
import { accountingMonthRange, getAccountingMonth } from './periodRepo';
import { getSetting } from './settingsRepo';

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

export type EntityInsightKind = 'tag' | 'merchant';
export type EntityInsightScope = 'month' | 'year' | 'all';

export interface EntityInsightPoint extends LedgerSummary {
  key: string;
  label: string;
}

export interface EntityInsight {
  kind: EntityInsightKind;
  entity: Tag | Merchant;
  scope: EntityInsightScope;
  range: { from: number; to: number };
  summary: LedgerSummary;
  totalCount: number;
  items: LedgerItem[];
  trend: EntityInsightPoint[];
}

function naturalYearRange(timestamp: number): { from: number; to: number } {
  const date = new Date(timestamp);
  return {
    from: new Date(date.getFullYear(), 0, 1).getTime(),
    to: new Date(date.getFullYear() + 1, 0, 1).getTime(),
  };
}

async function scopeRange(scope: EntityInsightScope, now: number): Promise<{ from: number; to: number }> {
  if (scope === 'month') return accountingMonthRange(await getAccountingMonth(now));
  if (scope === 'year') return naturalYearRange(now);
  let first = now;
  let last = now;
  await db.entries.each((entry) => {
    if (entry.deletedAt !== 0) return;
    for (const timestamp of [entry.occurredAt, entry.reimbursedAt]) {
      if (timestamp == null || !Number.isFinite(timestamp)) continue;
      first = Math.min(first, timestamp);
      last = Math.max(last, timestamp);
    }
  });
  return { from: new Date(new Date(first).getFullYear(), 0, 1).getTime(), to: nextLocalDay(last) };
}

function nextLocalDay(timestamp: number): number {
  const date = new Date(timestamp);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
}

function bucketRanges(scope: EntityInsightScope, range: { from: number; to: number }): Array<{ key: string; label: string; from: number; to: number }> {
  const result: Array<{ key: string; label: string; from: number; to: number }> = [];
  if (scope === 'month') {
    let cursor = range.from;
    while (cursor < range.to) {
      const date = new Date(cursor);
      const to = Math.min(nextLocalDay(cursor), range.to);
      result.push({
        key: `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`,
        label: `${date.getMonth() + 1}/${date.getDate()}`,
        from: cursor,
        to,
      });
      cursor = to;
    }
    return result;
  }
  if (scope === 'year') {
    const year = new Date(range.from).getFullYear();
    return Array.from({ length: 12 }, (_, index) => ({
      key: `${year}-${String(index + 1).padStart(2, '0')}`,
      label: `${index + 1}月`,
      from: new Date(year, index, 1).getTime(),
      to: new Date(year, index + 1, 1).getTime(),
    }));
  }
  const firstYear = new Date(range.from).getFullYear();
  const lastYear = new Date(Math.max(range.from, range.to - 1)).getFullYear();
  for (let year = firstYear; year <= lastYear; year += 1) {
    result.push({
      key: String(year), label: `${year}年`,
      from: Math.max(range.from, new Date(year, 0, 1).getTime()),
      to: Math.min(range.to, new Date(year + 1, 0, 1).getTime()),
    });
  }
  return result;
}

function summarize(items: readonly LedgerItem[], countAsIncome: boolean): LedgerSummary {
  return summarizeLedgerEntries(items, { reimburseMode: countAsIncome ? 'income' : 'offset' });
}

/** 标签/商家详情共用的统一账务查询；只读，不建立第二套统计口径。 */
export async function getEntityInsight(input: {
  kind: EntityInsightKind;
  id: number;
  scope: EntityInsightScope;
  now?: number;
}): Promise<EntityInsight> {
  const now = input.now ?? Date.now();
  const entity = input.kind === 'tag' ? await db.tags.get(input.id) : await db.merchants.get(input.id);
  if (!entity) throw new Error(input.kind === 'tag' ? '标签不存在' : '商家不存在');
  const range = await scopeRange(input.scope, now);
  const countAsIncome = await getSetting('reimburse.countAsIncome');
  let items = await ledgerEntriesInRange(range.from, range.to, countAsIncome);

  if (input.kind === 'merchant') {
    items = items.filter((item) => item.merchantId === input.id);
  } else {
    const ids = [...new Set(items.map((item) => item.id))];
    const linked = ids.length
      ? await db.entryTags.where('entryId').anyOf(ids).filter((row) => row.tagId === input.id).toArray()
      : [];
    const linkedIds = new Set(linked.map((row) => row.entryId));
    items = items.filter((item) => linkedIds.has(item.id));
  }

  const summary = summarize(items, countAsIncome);
  const trend = bucketRanges(input.scope, range).map((bucket) => {
    const pointSummary = summarize(items.filter((item) => item.occurredAt >= bucket.from && item.occurredAt < bucket.to), countAsIncome);
    return { key: bucket.key, label: bucket.label, ...pointSummary };
  });
  return {
    kind: input.kind,
    entity,
    scope: input.scope,
    range,
    summary,
    totalCount: items.length,
    items,
    trend,
  };
}

interface SuggestionOptions {
  now?: number;
  type: EntryType;
  categoryId?: number;
  limit?: number;
}

function validSuggestionRows(entries: readonly Entry[], options: SuggestionOptions): Entry[] {
  const now = options.now ?? Date.now();
  const from = now - NINETY_DAYS_MS;
  return entries.filter((entry) => entry.type === options.type
    && entry.deletedAt === 0 && !entry.refundFlag
    && entry.occurredAt >= from && entry.occurredAt <= now);
}

interface SuggestionUsage { categoryCount: number; count: number; latest: number }

function addUsage(usage: Map<number, SuggestionUsage>, id: number, entry: Entry, categoryId?: number): void {
  const current = usage.get(id) ?? { categoryCount: 0, count: 0, latest: 0 };
  current.count += 1;
  if (categoryId != null && entry.categoryId === categoryId) current.categoryCount += 1;
  current.latest = Math.max(current.latest, entry.occurredAt);
  usage.set(id, current);
}

/** 最近 90 天商家候选：同类型内，同分类命中优先，再按频次与最近使用排序。 */
export function rankMerchantSuggestions(
  merchants: readonly Merchant[],
  entries: readonly Entry[],
  options: SuggestionOptions,
): Merchant[] {
  const usage = new Map<number, SuggestionUsage>();
  for (const entry of validSuggestionRows(entries, options)) {
    if (entry.merchantId != null) addUsage(usage, entry.merchantId, entry, options.categoryId);
  }
  const sourceOrder = new Map(merchants.map((item, index) => [item.id, index]));
  return [...merchants].sort((a, b) => {
    const left = usage.get(a.id) ?? { categoryCount: 0, count: 0, latest: 0 };
    const right = usage.get(b.id) ?? { categoryCount: 0, count: 0, latest: 0 };
    return right.categoryCount - left.categoryCount
      || right.count - left.count
      || right.latest - left.latest
      || (sourceOrder.get(a.id) ?? 0) - (sourceOrder.get(b.id) ?? 0);
  }).slice(0, Math.max(0, options.limit ?? merchants.length));
}

export interface NoteSuggestion {
  text: string;
  categoryCount: number;
  count: number;
  latest: number;
}

/** 最近 90 天备注候选；仅返回候选值，调用方必须由用户点击后才写入输入框。 */
export function rankNoteSuggestions(entries: readonly Entry[], options: SuggestionOptions): NoteSuggestion[] {
  const usage = new Map<string, NoteSuggestion>();
  for (const entry of validSuggestionRows(entries, options)) {
    const text = entry.note?.trim();
    if (!text) continue;
    const current = usage.get(text) ?? { text, categoryCount: 0, count: 0, latest: 0 };
    current.count += 1;
    if (options.categoryId != null && entry.categoryId === options.categoryId) current.categoryCount += 1;
    current.latest = Math.max(current.latest, entry.occurredAt);
    usage.set(text, current);
  }
  return [...usage.values()].sort((a, b) => b.categoryCount - a.categoryCount
    || b.count - a.count || b.latest - a.latest || a.text.localeCompare(b.text, 'zh-CN'))
    .slice(0, Math.max(0, options.limit ?? 8));
}
