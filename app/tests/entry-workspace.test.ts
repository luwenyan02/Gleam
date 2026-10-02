import { describe, expect, it } from 'vitest';
import type { Account, AccountGroup, Category, EntryType } from '../src/core/types';
import {
  createRepeatDraft,
  rankFrequentCategories,
  recommendAccountId,
  resolveRecommendedCategoryId,
  resolveRecommendedAccountId,
  resolveInitialEntryType,
  toggleTagSelection,
} from '../src/features/entry/entryWorkspace';

function category(id: number, sortOrder = id): Category {
  return {
    id,
    name: `分类${id}`,
    icon: 'ic-coin',
    kind: 'expense',
    sortOrder,
    createdAt: 1,
    updatedAt: 1,
  };
}

function account(id: number, group: AccountGroup = 'credit', hidden = false): Account {
  return {
    id,
    name: `账户${id}`,
    group,
    balance: 0,
    hidden,
    countInNetWorth: true,
    sortOrder: id,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('快速记账工作台', () => {
  it('常用分类仅统计最近 90 天，按频次和最近使用排序并用原顺序补足', () => {
    const now = new Date('2026-09-05T08:00:00.000Z').getTime();
    const day = 24 * 60 * 60 * 1000;
    const categories = [1, 2, 3, 4, 5].map((id) => category(id));
    const rows = [
      { categoryId: 2, occurredAt: now - day },
      { categoryId: 2, occurredAt: now - 2 * day },
      { categoryId: 3, occurredAt: now - 3 * day },
      { categoryId: 3, occurredAt: now - 4 * day },
      { categoryId: 4, occurredAt: now - 5 * day },
      { categoryId: 1, occurredAt: now - 91 * day },
      { categoryId: 999, occurredAt: now - day },
    ];

    expect(rankFrequentCategories(categories, rows, { now, limit: 4 }).map((item) => item.id))
      .toEqual([2, 3, 4, 1]);
  });

  it('常用分类会让当前记账时段的历史记录优先于纯整体高频', () => {
    const targetAt = new Date(2026, 8, 5, 12, 15).getTime();
    const categories = [1, 2, 3].map((id) => category(id));
    const at = (daysAgo: number, hour: number) => {
      const value = new Date(targetAt);
      value.setDate(value.getDate() - daysAgo);
      value.setHours(hour, 0, 0, 0);
      return value.getTime();
    };
    const rows = [
      { categoryId: 2, occurredAt: at(1, 8) },
      { categoryId: 2, occurredAt: at(2, 8) },
      { categoryId: 2, occurredAt: at(3, 8) },
      { categoryId: 3, occurredAt: at(4, 12) },
      { categoryId: 3, occurredAt: at(5, 13) },
    ];

    expect(rankFrequentCategories(categories, rows, { now: targetAt, targetAt, limit: 3 })
      .map((item) => item.id)).toEqual([3, 2, 1]);
  });

  it('常用分类只使用同类型的有效历史，忽略删除、退款与未来条目', () => {
    const now = new Date(2026, 8, 5, 12, 15).getTime();
    const day = 24 * 60 * 60 * 1000;
    const categories = [1, 2, 3].map((id) => category(id));
    const rows = [
      { type: 'expense' as const, categoryId: 3, occurredAt: now - day, deletedAt: 0 },
      { type: 'income' as const, categoryId: 2, occurredAt: now - day, deletedAt: 0 },
      { type: 'expense' as const, categoryId: 2, occurredAt: now - day, deletedAt: now },
      { type: 'expense' as const, categoryId: 2, occurredAt: now - day, deletedAt: 0, refundFlag: true },
      { type: 'expense' as const, categoryId: 2, occurredAt: now + day, deletedAt: 0 },
    ];

    expect(rankFrequentCategories(categories, rows, {
      now, targetAt: now, entryType: 'expense', limit: 3,
    }).map((item) => item.id)).toEqual([3, 1, 2]);
  });

  it.each([
    [4, 59, '晚餐'], [5, 0, '早餐'], [10, 59, '早餐'], [11, 0, '午餐'],
    [13, 59, '午餐'], [14, 0, '午餐'], [16, 59, '午餐'], [17, 0, '晚餐'],
    [20, 59, '晚餐'], [21, 8, '晚餐'], [21, 59, '晚餐'], [22, 0, '晚餐'],
  ])('无历史时使用账单本地时间 %i:%i 推荐 %s，不取种子首项', (hour, minute, expected) => {
    const categories = ['早餐', '午餐', '晚餐'].map((name, index) => ({ ...category(index + 1), name }));
    const targetAt = new Date(2026, 9, 2, hour, minute).getTime();
    const now = new Date(2026, 9, 3, 8).getTime();
    expect(rankFrequentCategories(categories, [], { now, targetAt, entryType: 'expense' })[0]?.name).toBe(expected);
  });

  it('22 点后可选宵夜时优先宵夜，21:08 仍然晚餐', () => {
    const categories = ['早餐', '午餐', '晚餐', '宵夜'].map((name, index) => ({ ...category(index + 1), name }));
    for (const [hour, expected] of [[21, '晚餐'], [22, '宵夜'], [0, '宵夜']] as const) {
      const targetAt = new Date(2026, 9, 2, hour, 8).getTime();
      expect(rankFrequentCategories(categories, [], { now: targetAt, targetAt })[0]?.name).toBe(expected);
    }
  });

  it('晚间默认不被大量早餐历史压过，同时间段非餐饮习惯仍可优先', () => {
    const categories = ['早餐', '午餐', '晚餐', '地铁'].map((name, index) => ({ ...category(index + 1), name }));
    const now = new Date(2026, 9, 2, 21, 8).getTime();
    const rows = Array.from({ length: 30 }, (_, index) => ({
      type: 'expense' as const, categoryId: 1, occurredAt: new Date(2026, 9, 1 - index, 8).getTime(),
    }));
    expect(rankFrequentCategories(categories, rows, { now, entryType: 'expense' })[0]?.name).toBe('晚餐');
    // 即使历史的早餐记在晚间，也不据此选错餐次。
    rows.push({ type: 'expense', categoryId: 1, occurredAt: new Date(2026, 9, 1, 21).getTime() });
    expect(rankFrequentCategories(categories, rows, { now, entryType: 'expense' })[0]?.name).toBe('晚餐');
    rows.push({ type: 'expense', categoryId: 4, occurredAt: new Date(2026, 9, 1, 21).getTime() });
    expect(rankFrequentCategories(categories, rows, { now, entryType: 'expense' })[0]?.name).toBe('地铁');
  });

  it('收入不使用餐次规则；没有餐次分类时保留原历史排序与回退', () => {
    const now = new Date(2026, 9, 2, 21, 8).getTime();
    const categories = ['早餐', '晚餐'].map((name, index) => ({ ...category(index + 1), name, kind: 'income' as const }));
    expect(rankFrequentCategories(categories, [], { now, entryType: 'income' })[0]?.id).toBe(1);
    expect(rankFrequentCategories([category(1), category(2)], [{ categoryId: 2, occurredAt: now - 1000 }], { now })[0]?.id).toBe(2);
  });

  it('默认账户按同类型同分类的使用次数推荐，次数相同取最近使用', () => {
    const now = new Date(2026, 8, 5, 12, 15).getTime();
    const day = 24 * 60 * 60 * 1000;
    const rows = [
      { type: 'expense' as const, categoryId: 5, accountId: 1, occurredAt: now - 2 * day },
      { type: 'expense' as const, categoryId: 5, accountId: 1, occurredAt: now - 3 * day },
      { type: 'expense' as const, categoryId: 5, accountId: 2, occurredAt: now - day },
      { type: 'expense' as const, categoryId: 5, accountId: 2, occurredAt: now - 4 * day },
    ];

    expect(recommendAccountId([account(1), account(2)], rows, {
      now, entryType: 'expense', categoryId: 5,
    })).toBe(2);
  });

  it('账户推荐剔除无效历史和应收应付账户，冷启动回落最近使用及首个资金账户', () => {
    const now = new Date(2026, 8, 5, 12, 15).getTime();
    const day = 24 * 60 * 60 * 1000;
    const accounts = [
      account(1, 'cash'), account(2, 'credit'), account(3, 'receivable'), account(4, 'credit', true),
    ];
    const invalidRows = [
      { type: 'expense' as const, categoryId: 5, accountId: 3, occurredAt: now - day },
      { type: 'income' as const, categoryId: 5, accountId: 2, occurredAt: now - day },
      { type: 'expense' as const, categoryId: 6, accountId: 2, occurredAt: now - day },
      { type: 'expense' as const, categoryId: 5, accountId: 2, occurredAt: now - day, deletedAt: now },
      { type: 'expense' as const, categoryId: 5, accountId: 2, occurredAt: now - day, refundFlag: true },
      { type: 'expense' as const, categoryId: 5, accountId: 2, occurredAt: now + day },
      { type: 'expense' as const, categoryId: 5, accountId: 4, occurredAt: now - day },
      { type: 'expense' as const, categoryId: 5, accountId: 4, occurredAt: now - 2 * day },
    ];

    expect(recommendAccountId(accounts, invalidRows, {
      now, entryType: 'expense', categoryId: 5, fallbackId: 2,
    })).toBe(2);
    expect(recommendAccountId(accounts, [], {
      now, entryType: 'expense', categoryId: 5, fallbackId: 3,
    })).toBe(1);
  });

  it('显式预设、编辑再记来源或用户手选锁定后，不让推荐覆盖当前账户', () => {
    expect(resolveRecommendedAccountId(1, 2, true)).toBe(1);
    expect(resolveRecommendedAccountId(1, 2, false)).toBe(2);
    expect(resolveRecommendedAccountId(1, undefined, false)).toBe(1);
  });

  it('推荐首项成为默认分类，但历史日期重算不覆盖手选分类', () => {
    const ranked = [category(3), category(2), category(1)];
    expect(resolveRecommendedCategoryId(1, ranked, false)).toBe(3);
    expect(resolveRecommendedCategoryId(1, ranked, true)).toBe(1);
    expect(resolveRecommendedCategoryId(1, [], false)).toBe(1);
  });

  it('显式预设类型优先，否则恢复最近使用类型，最后回落支出', () => {
    expect(resolveInitialEntryType('income', 'loan')).toBe('income');
    expect(resolveInitialEntryType(undefined, 'transfer')).toBe('transfer');
    expect(resolveInitialEntryType(undefined, undefined)).toBe('expense');
  });

  it('再记一笔继承业务选择，清空金额和自由文本', () => {
    const draft = createRepeatDraft({
      type: 'expense' as EntryType,
      amount: 3680,
      categoryId: 12,
      accountId: 3,
      tagIds: [7, 8],
      merchantId: 9,
      occurredAt: 1_777_777,
      note: '客户午餐',
      reimbursePending: true,
      linkLife: true,
    });

    expect(draft).toEqual({
      type: 'expense',
      amount: '',
      categoryId: 12,
      accountId: 3,
      tagIds: [7, 8],
      merchantId: 9,
      occurredAt: 1_777_777,
      note: '',
      reimbursePending: false,
      linkLife: false,
    });
  });

  it('标签多选逐项加入或移除，不产生重复标签', () => {
    expect(toggleTagSelection([7, 8], 9)).toEqual([7, 8, 9]);
    expect(toggleTagSelection([7, 8, 7], 7)).toEqual([8]);
  });
});
