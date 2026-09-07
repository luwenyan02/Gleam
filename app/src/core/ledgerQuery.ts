import { formatFen } from './money';
import type { Entry, EntryType } from './types';

export type LedgerQueryField = 'all' | 'category' | 'account' | 'tag' | 'merchant' | 'note' | 'amount';

/** 搜索、报表下钻和账户明细共同使用的内部查询契约。 */
export interface LedgerQuery {
  /** 起点（含）；未设置表示不限。 */
  from?: number;
  /** 终点（不含）；未设置表示不限。 */
  to?: number;
  types?: EntryType[];
  categoryIds?: number[];
  accountIds?: number[];
  tagIds?: number[];
  merchantIds?: number[];
  amountMin?: number;
  amountMax?: number;
  keyword?: string;
  field?: LedgerQueryField;
}

export interface LedgerLookup {
  categoryNames?: ReadonlyMap<number, string>;
  accountNames?: ReadonlyMap<number, string>;
  merchantNames?: ReadonlyMap<number, string>;
  tagNamesByEntry?: ReadonlyMap<number, readonly string[]>;
  tagIdsByEntry?: ReadonlyMap<number, readonly number[]>;
}

export interface LedgerSummary {
  expense: number;
  income: number;
  balance: number;
  expenseCount: number;
  incomeCount: number;
}

export interface LedgerSummaryOptions {
  reimburseMode?: 'raw' | 'offset' | 'income';
  /** 以到账时间落入查询范围的报销收入事件合计。 */
  reimburseIncome?: number;
  reimburseIncomeCount?: number;
}

export type ReportDimension = 'trend' | 'category' | 'account' | 'tag';

/** 报表只持有用户的周期和当前选中项，不复制明细页筛选状态。 */
export interface ReportSelection {
  from: number;
  to: number;
  dimension: ReportDimension;
  selectedIds?: number[];
  types?: EntryType[];
}

function includesAccount(entry: Entry, ids: ReadonlySet<number>): boolean {
  return [entry.accountId, entry.fromAccountId, entry.toAccountId]
    .some((id) => id != null && ids.has(id));
}

function textIncludes(value: string | undefined, keyword: string): boolean {
  return (value ?? '').toLocaleLowerCase('zh-CN').includes(keyword);
}

function matchesKeyword(entry: Entry, query: LedgerQuery, lookup: LedgerLookup): boolean {
  const raw = query.keyword?.trim();
  if (!raw) return true;
  const keyword = raw.toLocaleLowerCase('zh-CN');
  const field = query.field ?? 'all';
  const category = lookup.categoryNames?.get(entry.categoryId ?? -1);
  const accountNames = [entry.accountId, entry.fromAccountId, entry.toAccountId]
    .filter((id): id is number => id != null)
    .map((id) => lookup.accountNames?.get(id) ?? '');
  const tags = lookup.tagNamesByEntry?.get(entry.id) ?? [];
  const merchant = lookup.merchantNames?.get(entry.merchantId ?? -1);
  const amountFen = Number.isFinite(Number(raw)) ? Math.round(Number(raw) * 100) : null;

  if (field === 'category') return textIncludes(category, keyword);
  if (field === 'account') return accountNames.some((name) => textIncludes(name, keyword));
  if (field === 'tag') return tags.some((name) => textIncludes(name, keyword));
  if (field === 'merchant') return textIncludes(merchant, keyword);
  if (field === 'note') return textIncludes(entry.note, keyword);
  if (field === 'amount') return amountFen != null && entry.amount === amountFen;
  return textIncludes(category, keyword)
    || accountNames.some((name) => textIncludes(name, keyword))
    || tags.some((name) => textIncludes(name, keyword))
    || textIncludes(merchant, keyword)
    || textIncludes(entry.note, keyword)
    || formatFen(entry.amount).replace(/,/g, '').includes(raw);
}

/** 对已经载入内存的账单应用统一筛选；结果按发生时间倒序。 */
export function filterLedgerEntries<T extends Entry>(
  entries: readonly T[],
  query: LedgerQuery = {},
  lookup: LedgerLookup = {},
): T[] {
  const typeSet = query.types?.length ? new Set(query.types) : null;
  const categorySet = query.categoryIds?.length ? new Set(query.categoryIds) : null;
  const accountSet = query.accountIds?.length ? new Set(query.accountIds) : null;
  const tagSet = query.tagIds?.length ? new Set(query.tagIds) : null;
  const merchantSet = query.merchantIds?.length ? new Set(query.merchantIds) : null;

  return entries.filter((entry) => {
    if (entry.deletedAt !== 0) return false;
    if (query.from != null && entry.occurredAt < query.from) return false;
    if (query.to != null && entry.occurredAt >= query.to) return false;
    if (typeSet && !typeSet.has(entry.type)) return false;
    if (categorySet && (entry.categoryId == null || !categorySet.has(entry.categoryId))) return false;
    if (accountSet && !includesAccount(entry, accountSet)) return false;
    if (tagSet) {
      const entryTags = lookup.tagIdsByEntry?.get(entry.id) ?? [];
      if (!entryTags.some((id) => tagSet.has(id))) return false;
    }
    if (merchantSet && (entry.merchantId == null || !merchantSet.has(entry.merchantId))) return false;
    if (query.amountMin != null && entry.amount < query.amountMin) return false;
    if (query.amountMax != null && entry.amount > query.amountMax) return false;
    return matchesKeyword(entry, query, lookup);
  }).sort((a, b) => b.occurredAt - a.occurredAt || b.id - a.id);
}

/** 对筛选结果做统一收支汇总；退款冲抵支出，转账和借贷不计收支。 */
export function summarizeLedgerEntries(
  entries: readonly Entry[],
  options: LedgerSummaryOptions = {},
): LedgerSummary {
  let expense = 0;
  let income = 0;
  let expenseCount = 0;
  let incomeCount = 0;
  for (const entry of entries) {
    if (entry.type === 'expense') {
      expense += entry.refundFlag ? -entry.amount : entry.amount;
      if (options.reimburseMode === 'offset' && entry.reimburseStatus === 'done') {
        expense -= entry.reimbursedAmount ?? 0;
      }
      expenseCount += 1;
    } else if (entry.type === 'income') {
      income += entry.amount;
      incomeCount += 1;
    }
  }
  if (options.reimburseMode === 'income' && options.reimburseIncome) {
    income += options.reimburseIncome;
    incomeCount += options.reimburseIncomeCount ?? 0;
  }
  return { expense, income, balance: income - expense, expenseCount, incomeCount };
}

function localDayKey(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** 将统一结果集按本地自然日分组，组和组内均为倒序。 */
export function groupLedgerEntries<T extends Entry>(entries: readonly T[]): { day: string; entries: T[] }[] {
  const groups = new Map<string, T[]>();
  for (const entry of [...entries].sort((a, b) => b.occurredAt - a.occurredAt || b.id - a.id)) {
    const day = localDayKey(entry.occurredAt);
    const rows = groups.get(day);
    if (rows) rows.push(entry);
    else groups.set(day, [entry]);
  }
  return [...groups].map(([day, groupedEntries]) => ({ day, entries: groupedEntries }));
}

export function reportSelectionToLedgerQuery(selection: ReportSelection): LedgerQuery {
  const query: LedgerQuery = { from: selection.from, to: selection.to };
  if (selection.types?.length) query.types = [...selection.types];
  if (selection.dimension === 'category') {
    query.types = selection.types?.length ? [...selection.types] : ['expense'];
    if (selection.selectedIds?.length) query.categoryIds = [...selection.selectedIds];
  } else if (selection.dimension === 'account') {
    query.types = selection.types?.length ? [...selection.types] : ['expense'];
    if (selection.selectedIds?.length) query.accountIds = [...selection.selectedIds];
  } else if (selection.dimension === 'tag') {
    query.types = selection.types?.length ? [...selection.types] : ['expense'];
    if (selection.selectedIds?.length) query.tagIds = [...selection.selectedIds];
  }
  return query;
}

export interface RankLike {
  id: number;
  name: string;
  amount: number;
}

/** 图表最多直接展示前五项，其余汇总为“其他”。 */
export function collapseRankRows<T extends RankLike>(rows: readonly T[]): Array<T | { id: 'other'; name: '其他'; amount: number }> {
  if (rows.length <= 5) return [...rows];
  return [
    ...rows.slice(0, 5),
    { id: 'other', name: '其他', amount: rows.slice(5).reduce((sum, row) => sum + row.amount, 0) },
  ];
}
