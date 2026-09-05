import { describe, expect, it } from 'vitest';
import type { Category, EntryType } from '../src/core/types';
import {
  createRepeatDraft,
  rankFrequentCategories,
  resolveInitialEntryType,
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
      tagId: 7,
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
      tagId: 7,
      merchantId: 9,
      occurredAt: 1_777_777,
      note: '',
      reimbursePending: false,
      linkLife: false,
    });
  });
});
