import type { Account, Category, EntryType } from '../../core/types';

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

export interface CategoryUsage {
  type?: EntryType;
  categoryId?: number;
  occurredAt: number;
  deletedAt?: number;
  refundFlag?: boolean;
}

/** 本地时间粗粒度分段；刻意保持固定、可解释，不做模型推断。 */
function entryTimeSegment(timestamp: number): 'breakfast' | 'lunch' | 'afternoon' | 'dinner' | 'night' {
  const hour = new Date(timestamp).getHours();
  if (hour >= 5 && hour < 11) return 'breakfast';
  if (hour >= 11 && hour < 14) return 'lunch';
  if (hour >= 14 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 21) return 'dinner';
  return 'night';
}

/**
 * 取最近 90 天同类型的常用分类：每次使用计 1 分，与草稿处于同时间段再加 2 分；
 * 同分依次比较同段次数、总次数、最近使用和分类原顺序，历史不足时按原顺序补齐。
 */
export function rankFrequentCategories(
  categories: readonly Category[],
  entries: readonly CategoryUsage[],
  options: { now?: number; targetAt?: number; entryType?: EntryType; limit?: number } = {},
): Category[] {
  const now = options.now ?? Date.now();
  const targetSegment = entryTimeSegment(options.targetAt ?? now);
  const limit = options.limit ?? 7;
  const from = now - NINETY_DAYS_MS;
  const categoryIds = new Set(categories.map((item) => item.id));
  const usage = new Map<number, { count: number; sameSegmentCount: number; latest: number }>();

  for (const entry of entries) {
    if (options.entryType != null && entry.type !== options.entryType) continue;
    if (entry.deletedAt != null && entry.deletedAt !== 0) continue;
    if (entry.refundFlag) continue;
    if (entry.categoryId == null || !categoryIds.has(entry.categoryId)) continue;
    if (entry.occurredAt < from || entry.occurredAt >= now + 1) continue;
    const current = usage.get(entry.categoryId) ?? { count: 0, sameSegmentCount: 0, latest: 0 };
    current.count += 1;
    if (entryTimeSegment(entry.occurredAt) === targetSegment) current.sameSegmentCount += 1;
    current.latest = Math.max(current.latest, entry.occurredAt);
    usage.set(entry.categoryId, current);
  }

  const sourceOrder = new Map(categories.map((item, index) => [item.id, index]));
  const used = categories
    .filter((item) => usage.has(item.id))
    .sort((a, b) => {
      const ua = usage.get(a.id)!;
      const ub = usage.get(b.id)!;
      const scoreA = ua.count + ua.sameSegmentCount * 2;
      const scoreB = ub.count + ub.sameSegmentCount * 2;
      return scoreB - scoreA
        || ub.sameSegmentCount - ua.sameSegmentCount
        || ub.count - ua.count
        || ub.latest - ua.latest
        || sourceOrder.get(a.id)! - sourceOrder.get(b.id)!;
    });
  const usedIds = new Set(used.map((item) => item.id));
  const fallback = categories.filter((item) => !usedIds.has(item.id));
  return [...used, ...fallback].slice(0, Math.max(0, limit));
}

export interface AccountUsage {
  type: EntryType;
  categoryId?: number;
  accountId?: number;
  occurredAt: number;
  deletedAt?: number;
  refundFlag?: boolean;
}

/**
 * 从最近 90 天同类型、同分类历史中推荐资金账户：次数优先，次数相同取最近使用；
 * 没有匹配历史时回落最近使用账户，再回落账户原顺序。应收应付账户不参与推荐。
 */
export function recommendAccountId(
  accounts: readonly Account[],
  entries: readonly AccountUsage[],
  options: { now?: number; entryType: EntryType; categoryId?: number; fallbackId?: number | null },
): number | undefined {
  const now = options.now ?? Date.now();
  const from = now - NINETY_DAYS_MS;
  const fundingAccounts = accounts.filter((account) => !account.hidden && account.group !== 'receivable');
  const accountIds = new Set(fundingAccounts.map((account) => account.id));
  const usage = new Map<number, { count: number; latest: number }>();

  if (options.categoryId != null) {
    for (const entry of entries) {
      if (entry.type !== options.entryType || entry.categoryId !== options.categoryId) continue;
      if (entry.deletedAt != null && entry.deletedAt !== 0) continue;
      if (entry.refundFlag || entry.accountId == null || !accountIds.has(entry.accountId)) continue;
      if (entry.occurredAt < from || entry.occurredAt >= now + 1) continue;
      const current = usage.get(entry.accountId) ?? { count: 0, latest: 0 };
      current.count += 1;
      current.latest = Math.max(current.latest, entry.occurredAt);
      usage.set(entry.accountId, current);
    }
  }

  const recommended = fundingAccounts
    .filter((account) => usage.has(account.id))
    .sort((a, b) => {
      const ua = usage.get(a.id)!;
      const ub = usage.get(b.id)!;
      return ub.count - ua.count || ub.latest - ua.latest;
    })[0];
  if (recommended) return recommended.id;
  if (options.fallbackId != null && accountIds.has(options.fallbackId)) return options.fallbackId;
  return fundingAccounts[0]?.id;
}

/** 推荐只改写系统默认值；显式来源或本次会话中的手选结果保持不动。 */
export function resolveRecommendedAccountId(
  currentId: number | undefined,
  recommendedId: number | undefined,
  preserveCurrent: boolean,
): number | undefined {
  return preserveCurrent ? currentId : recommendedId ?? currentId;
}

/** 推荐分类首项可更新系统默认值，但编辑、模板和用户手选结果保持不动。 */
export function resolveRecommendedCategoryId(
  currentId: number | undefined,
  rankedCategories: readonly Category[],
  preserveCurrent: boolean,
): number | undefined {
  return preserveCurrent ? currentId : rankedCategories[0]?.id ?? currentId;
}

export function resolveInitialEntryType(
  presetType?: EntryType,
  lastUsedType?: EntryType | null,
): EntryType {
  return presetType ?? lastUsedType ?? 'expense';
}

/** 多选标签按点击顺序保存；点已选标签即移除，同时清理历史重复关联。 */
export function toggleTagSelection(tagIds: readonly number[], tagId: number): number[] {
  const selected = [...new Set(tagIds)];
  return selected.includes(tagId)
    ? selected.filter((id) => id !== tagId)
    : [...selected, tagId];
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
  tagIds?: number[];
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
    tagIds: input.tagIds ? [...new Set(input.tagIds)] : undefined,
    merchantId: input.merchantId,
    occurredAt: input.occurredAt,
    note: '',
    reimbursePending: false,
    linkLife: false,
  };
}
