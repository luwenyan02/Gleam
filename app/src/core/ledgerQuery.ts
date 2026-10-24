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

export type ReportDimension = 'trend' | 'category' | 'account' | 'tag' | 'income' | 'merchant';

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

/** Prepare one query once; repeated account/category names share normalization. */
function keywordMatcher(query: LedgerQuery, lookup: LedgerLookup): (entry: Entry) => boolean {
  const raw = query.keyword?.trim();
  if (!raw) return () => true;
  const keyword = raw.toLocaleLowerCase('zh-CN');
  const field = query.field ?? 'all';
  const normalizedNames = new Map<string, string>();
  const nameIncludes = (value = '') => {
    let normalized = normalizedNames.get(value);
    if (normalized === undefined) {
      normalized = value.toLocaleLowerCase('zh-CN');
      normalizedNames.set(value, normalized);
    }
    return normalized.includes(keyword);
  };
  const noteIncludes = (entry: Entry) => (entry.note ?? '').toLocaleLowerCase('zh-CN').includes(keyword);
  const categoryIncludes = (entry: Entry) => nameIncludes(lookup.categoryNames?.get(entry.categoryId ?? -1));
  const accountIncludes = (entry: Entry) => [entry.accountId, entry.fromAccountId, entry.toAccountId]
    .some(id => id != null && nameIncludes(lookup.accountNames?.get(id)));
  const tagIncludes = (entry: Entry) => (lookup.tagNamesByEntry?.get(entry.id) ?? []).some(nameIncludes);
  const merchantIncludes = (entry: Entry) => nameIncludes(lookup.merchantNames?.get(entry.merchantId ?? -1));
  if (field === 'category') return categoryIncludes;
  if (field === 'account') return accountIncludes;
  if (field === 'tag') return tagIncludes;
  if (field === 'merchant') return merchantIncludes;
  if (field === 'note') return noteIncludes;
  if (field === 'amount') {
    const amountFen = Number.isFinite(Number(raw)) ? Math.round(Number(raw) * 100) : null;
    return entry => amountFen != null && entry.amount === amountFen;
  }
  // Formatted amounts contain only digits, a decimal point and an optional minus.
  const canMatchAmount = /^[\d.-]+$/.test(raw);
  const amounts = new Map<number, string>();
  const amountIncludes = (amount: number) => {
    if (!canMatchAmount) return false;
    let text = amounts.get(amount);
    if (text === undefined) { text = formatFen(amount).replace(/,/g, ''); amounts.set(amount, text); }
    return text.includes(raw);
  };
  return entry => categoryIncludes(entry) || accountIncludes(entry) || tagIncludes(entry)
    || merchantIncludes(entry) || noteIncludes(entry) || amountIncludes(entry.amount);
}

/** 对已经载入内存的账单应用统一筛选；结果按发生时间倒序。 */
export function filterLedgerEntries<T extends Entry>(
  entries: readonly T[],
  query: LedgerQuery = {},
  lookup: LedgerLookup = {},
): T[] {
  const matchesKeyword = keywordMatcher(query, lookup);
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
    return matchesKeyword(entry);
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
  } else if (selection.dimension === 'income') {
    query.types = ['income'];
    if (selection.selectedIds?.length) query.categoryIds = [...selection.selectedIds];
  } else if (selection.dimension === 'merchant') {
    query.types = selection.types?.length ? [...selection.types] : ['expense'];
    if (selection.selectedIds?.length) query.merchantIds = [...selection.selectedIds];
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
