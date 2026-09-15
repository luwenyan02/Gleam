import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/core/db';
import type { Entry, Merchant } from '../src/core/types';
import {
  getEntityInsight,
  rankMerchantSuggestions,
  rankNoteSuggestions,
  type EntityInsightScope,
} from '../src/core/repo/entityInsightsRepo';
import { setSetting } from '../src/core/repo/settingsRepo';

const NOW = new Date(2026, 8, 15, 12).getTime();
const DAY = 86_400_000;

function entry(input: Partial<Entry> & Pick<Entry, 'id' | 'type' | 'amount' | 'occurredAt'>): Entry {
  return {
    reimburseStatus: 'none', deletedAt: 0, createdAt: 1, updatedAt: 1,
    ...input,
  };
}

function merchant(id: number, name: string): Merchant {
  return { id, name, useCount: 0, createdAt: 1, updatedAt: 1 };
}

beforeEach(async () => {
  await db.delete();
  await db.open();
});

afterEach(async () => {
  await db.delete();
});

describe('标签与商家洞察', () => {
  it('标签月详情使用财务月范围并复用报销冲抵口径', async () => {
    await setSetting('accounting.monthStartDay', 10);
    await db.tags.add({ id: 5, name: '出差', color: '#725BE8', createdAt: 1, updatedAt: 1 });
    await db.entries.bulkAdd([
      entry({ id: 1, type: 'expense', amount: 10_000, occurredAt: new Date(2026, 7, 12).getTime(), reimburseStatus: 'done', reimbursedAmount: 4_000 }),
      entry({ id: 2, type: 'income', amount: 2_000, occurredAt: new Date(2026, 8, 11).getTime() }),
      entry({ id: 3, type: 'expense', amount: 9_999, occurredAt: new Date(2026, 8, 10).getTime() }),
    ]);
    await db.entryTags.bulkAdd([
      { entryId: 1, tagId: 5 }, { entryId: 2, tagId: 5 }, { entryId: 3, tagId: 5 },
    ]);

    const result = await getEntityInsight({
      kind: 'tag', id: 5, scope: 'month', now: new Date(2026, 8, 5, 12).getTime(),
    });

    expect(result.range).toEqual({
      from: new Date(2026, 7, 10).getTime(),
      to: new Date(2026, 8, 10).getTime(),
    });
    expect(result.items.map((item) => item.id)).toEqual([1]);
    expect(result.summary).toMatchObject({ expense: 6_000, income: 0, expenseCount: 1, incomeCount: 0 });
    expect(result.totalCount).toBe(1);
    expect(result.entity).toMatchObject({ name: '出差', color: '#725BE8' });
  });

  it('商家自然年与全部范围均返回统一流水，趋势总额与汇总一致', async () => {
    await db.merchants.add(merchant(8, '虚构咖啡馆'));
    await db.entries.bulkAdd([
      entry({ id: 1, type: 'expense', amount: 1200, occurredAt: new Date(2025, 11, 1).getTime(), merchantId: 8 }),
      entry({ id: 2, type: 'expense', amount: 2300, occurredAt: new Date(2026, 2, 1).getTime(), merchantId: 8 }),
      entry({ id: 3, type: 'income', amount: 500, occurredAt: new Date(2026, 3, 1).getTime(), merchantId: 8 }),
      entry({ id: 4, type: 'expense', amount: 700, occurredAt: new Date(2026, 4, 1).getTime(), merchantId: 9 }),
    ]);

    const year = await getEntityInsight({ kind: 'merchant', id: 8, scope: 'year', now: NOW });
    const all = await getEntityInsight({ kind: 'merchant', id: 8, scope: 'all', now: NOW });

    expect(year.items.map((item) => item.id)).toEqual([3, 2]);
    expect(year.summary).toMatchObject({ expense: 2300, income: 500 });
    expect(year.trend.reduce((sum, point) => sum + point.expense, 0)).toBe(year.summary.expense);
    expect(year.trend.reduce((sum, point) => sum + point.income, 0)).toBe(year.summary.income);
    expect(all.items.map((item) => item.id)).toEqual([3, 2, 1]);
  });

  it.each<EntityInsightScope>(['month', 'year', 'all'])('不存在的实体在 %s 范围明确报错', async (scope) => {
    await expect(getEntityInsight({ kind: 'tag', id: 404, scope, now: NOW })).rejects.toThrow('标签不存在');
  });

  it('全部范围包含未来日期账单及更晚到账的报销事件', async () => {
    await setSetting('reimburse.countAsIncome', true);
    await db.merchants.add(merchant(8, '虚构商家'));
    await db.entries.add(entry({
      id: 1, type: 'expense', amount: 1200, merchantId: 8,
      occurredAt: new Date(2026, 11, 1).getTime(), reimburseStatus: 'done',
      reimbursedAmount: 1200, reimburseAccountId: 1,
      reimbursedAt: new Date(2027, 0, 3).getTime(),
    }));
    const all = await getEntityInsight({ kind: 'merchant', id: 8, scope: 'all', now: NOW });
    expect(all.totalCount).toBe(2);
    expect(all.summary).toMatchObject({ expense: 1200, income: 1200 });
    expect(all.trend.reduce((sum, point) => sum + point.income, 0)).toBe(1200);
  });
});

describe('记账轻量联想', () => {
  const entries = [
    entry({ id: 1, type: 'expense', amount: 100, categoryId: 1, merchantId: 2, note: '工作午餐', occurredAt: NOW - DAY }),
    entry({ id: 2, type: 'expense', amount: 100, categoryId: 1, merchantId: 2, note: '工作午餐', occurredAt: NOW - 2 * DAY }),
    entry({ id: 3, type: 'expense', amount: 100, categoryId: 2, merchantId: 1, note: '咖啡', occurredAt: NOW - 3 * DAY }),
    entry({ id: 4, type: 'expense', amount: 100, categoryId: 2, merchantId: 1, note: '咖啡', occurredAt: NOW - 4 * DAY }),
    entry({ id: 5, type: 'expense', amount: 100, categoryId: 2, merchantId: 1, note: '咖啡', occurredAt: NOW - 5 * DAY }),
    entry({ id: 6, type: 'income', amount: 100, categoryId: 1, merchantId: 1, note: '工资', occurredAt: NOW - DAY }),
    entry({ id: 7, type: 'expense', amount: 100, categoryId: 1, merchantId: 3, note: '过期备注', occurredAt: NOW - 91 * DAY }),
    entry({ id: 8, type: 'expense', amount: 100, categoryId: 1, merchantId: 3, note: '已删除', occurredAt: NOW - DAY, deletedAt: NOW }),
  ];

  it('按当前类型与分类优先、频次和最近使用排序，忽略 90 天外及无效账单', () => {
    const shops = [merchant(1, '咖啡店'), merchant(2, '食堂'), merchant(3, '旧商家')];
    expect(rankMerchantSuggestions(shops, entries, {
      now: NOW, type: 'expense', categoryId: 1,
    }).map((item) => item.id)).toEqual([2, 1, 3]);
    expect(rankNoteSuggestions(entries, {
      now: NOW, type: 'expense', categoryId: 1,
    }).map((item) => item.text)).toEqual(['工作午餐', '咖啡']);
  });

  it('联想只返回候选，不改写当前显式商家或备注', () => {
    const selectedMerchantId = 99;
    const typedNote = '用户正在输入';
    rankMerchantSuggestions([merchant(1, '咖啡店')], entries, { now: NOW, type: 'expense', categoryId: 1 });
    rankNoteSuggestions(entries, { now: NOW, type: 'expense', categoryId: 1 });
    expect(selectedMerchantId).toBe(99);
    expect(typedNote).toBe('用户正在输入');
  });
});
