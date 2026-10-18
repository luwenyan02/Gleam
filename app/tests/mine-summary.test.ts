import 'fake-indexeddb/auto';
import { beforeEach, expect, it, vi } from 'vitest';
import { db } from '../src/core/db';
import type { Entry } from '../src/core/types';
import { getMineEntrySummary } from '../src/core/repo/mineRepo';

beforeEach(async () => { await db.delete(); await db.open(); });

it('按有效账单的自然日统计天数，待报销只包含未删除支出', async () => {
  const stamp = { createdAt: 1, updatedAt: 1 };
  const at = new Date(2026, 9, 18, 8).getTime();
  const entry = (id: number, patch: Partial<Entry> = {}): Entry => ({ ...stamp, id,
    type: 'expense', amount: 1234, occurredAt: at, deletedAt: 0, reimburseStatus: 'none', ...patch });
  await db.entries.bulkPut([
    entry(1, { reimburseStatus: 'pending' }), entry(2, { occurredAt: at + 1000 }),
    entry(3, { occurredAt: new Date(2026, 9, 19, 0).getTime(), type: 'transfer' }),
    entry(4, { deletedAt: 1, reimburseStatus: 'pending' }),
    entry(5, { type: 'income', reimburseStatus: 'pending' }),
    entry(6, { amount: -200, reimburseStatus: 'pending' }),
  ]);
  // 头部只需日期索引键，不能反序列化全部账单值。
  const collection = Object.getPrototypeOf(db.entries.toCollection());
  const toArray = vi.spyOn(collection, 'toArray');
  try {
    expect(await getMineEntrySummary()).toEqual({ days: 2, count: 5, pendingCount: 2, pendingAmount: 1034 });
    expect(toArray).toHaveBeenCalledTimes(1); // 仅待报销候选需要账单值。
  } finally { toArray.mockRestore(); }
});

it('空账本的统计为零', async () => {
  expect(await getMineEntrySummary()).toEqual({ days: 0, count: 0, pendingCount: 0, pendingAmount: 0 });
});
