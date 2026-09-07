import type { Category, EntryType } from '../../core/types';

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

export interface CategoryUsage {
  categoryId?: number;
  occurredAt: number;
}

/**
 * 取最近 90 天最常用的分类。频次相同则最近使用优先，仍相同按分类原顺序；
 * 历史不足时按原顺序补齐，不向数据模型增加派生字段。
 */
export function rankFrequentCategories(
  categories: readonly Category[],
  entries: readonly CategoryUsage[],
  options: { now?: number; limit?: number } = {},
): Category[] {
  const now = options.now ?? Date.now();
  const limit = options.limit ?? 7;
  const from = now - NINETY_DAYS_MS;
  const categoryIds = new Set(categories.map((item) => item.id));
  const usage = new Map<number, { count: number; latest: number }>();

  for (const entry of entries) {
    if (entry.categoryId == null || !categoryIds.has(entry.categoryId)) continue;
    if (entry.occurredAt < from || entry.occurredAt >= now + 1) continue;
    const current = usage.get(entry.categoryId) ?? { count: 0, latest: 0 };
    current.count += 1;
    current.latest = Math.max(current.latest, entry.occurredAt);
    usage.set(entry.categoryId, current);
  }

  const sourceOrder = new Map(categories.map((item, index) => [item.id, index]));
  const used = categories
    .filter((item) => usage.has(item.id))
    .sort((a, b) => {
      const ua = usage.get(a.id)!;
      const ub = usage.get(b.id)!;
      return ub.count - ua.count || ub.latest - ua.latest || sourceOrder.get(a.id)! - sourceOrder.get(b.id)!;
    });
  const usedIds = new Set(used.map((item) => item.id));
  const fallback = categories.filter((item) => !usedIds.has(item.id));
  return [...used, ...fallback].slice(0, Math.max(0, limit));
}

export function resolveInitialEntryType(
  presetType?: EntryType,
  lastUsedType?: EntryType | null,
): EntryType {
  return presetType ?? lastUsedType ?? 'expense';
}

export interface RepeatDraftInput {
  type: EntryType;
  amount: number | string;
  categoryId?: number;
  accountId?: number;
  fromId?: number;
  toId?: number;
  loanAccountId?: number;
  loanKind?: 'borrow' | 'lend' | 'repay' | 'collect';
  tagId?: number;
  merchantId?: number;
  occurredAt: number;
  note?: string;
  reimbursePending?: boolean;
  linkLife?: boolean;
}

export interface RepeatDraft extends Omit<RepeatDraftInput, 'amount' | 'note' | 'reimbursePending' | 'linkLife'> {
  amount: '';
  note: '';
  reimbursePending: false;
  linkLife: false;
}

/** “再记一笔”只清空金额和随笔性内容，保留能缩短下一笔路径的业务选择。 */
export function createRepeatDraft(input: RepeatDraftInput): RepeatDraft {
  return {
    type: input.type,
    amount: '',
    categoryId: input.categoryId,
    accountId: input.accountId,
    fromId: input.fromId,
    toId: input.toId,
    loanAccountId: input.loanAccountId,
    loanKind: input.loanKind,
    tagId: input.tagId,
    merchantId: input.merchantId,
    occurredAt: input.occurredAt,
    note: '',
    reimbursePending: false,
    linkLife: false,
  };
}
