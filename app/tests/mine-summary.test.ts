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

it('同一天的大账本按日期跳过索引键，不逐条触发游标回调', async () => {
  const at = new Date(2026, 9, 18, 8).getTime();
  await db.entries.bulkPut(Array.from({ length: 300 }, (_, index) => ({
    id: index + 1, type: 'expense' as const, amount: 100, occurredAt: at + index,
    deletedAt: 0, reimburseStatus: 'none' as const, createdAt: 1, updatedAt: 1,
  })));
  const advance = vi.spyOn(IDBCursor.prototype, 'continue');
  try {
    expect(await getMineEntrySummary()).toEqual({ days: 1, count: 300, pendingCount: 0, pendingAmount: 0 });
    expect(advance.mock.calls.length).toBeLessThan(5);
  } finally { advance.mockRestore(); }
});

it('不依赖应用事件，其他原生连接的新增、软删除、恢复与替换立即可见', async () => {
  const write = async (action: (store: IDBObjectStore) => void) => {
    const connection = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(db.name); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try {
      const transaction = connection.transaction('entries', 'readwrite'); action(transaction.objectStore('entries'));
      await new Promise<void>((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error); });
    } finally { connection.close(); }
  };
  const entry: Entry = { id: 1, type: 'expense', amount: 100, occurredAt: Date.now(), deletedAt: 0,
    reimburseStatus: 'pending', createdAt: 1, updatedAt: 1 };
  expect((await getMineEntrySummary()).count).toBe(0);
  await write(store => { store.put(entry); });
  expect(await getMineEntrySummary()).toEqual({ days: 1, count: 1, pendingCount: 1, pendingAmount: 100 });
  await write(store => { store.put({ ...entry, deletedAt: 1 }); });
  expect((await getMineEntrySummary()).count).toBe(0);
  await write(store => { store.put({ ...entry, amount: 200 }); });
  expect((await getMineEntrySummary()).pendingAmount).toBe(200);
  await write(store => { store.clear(); store.put({ ...entry, id: 2, reimburseStatus: 'none' }); });
  expect(await getMineEntrySummary()).toEqual({ days: 1, count: 1, pendingCount: 0, pendingAmount: 0 });
});

it('改变本地时区后重新计算自然日，包括夏令时边界', async () => {
  const original = process.env.TZ;
  const entry = (id: number, occurredAt: number): Entry => ({ id, occurredAt, type: 'expense', amount: 1,
    deletedAt: 0, reimburseStatus: 'none', createdAt: 1, updatedAt: 1 });
  try {
    process.env.TZ = 'UTC';
    await db.entries.bulkPut([entry(1, Date.parse('2026-03-08T06:30:00Z')), entry(2, Date.parse('2026-03-09T03:30:00Z'))]);
    expect((await getMineEntrySummary()).days).toBe(2);
    process.env.TZ = 'America/New_York';
    expect((await getMineEntrySummary()).days).toBe(1);
  } finally { if (original === undefined) delete process.env.TZ; else process.env.TZ = original; }
});

it('秋季夏令时的两次凌晨仍为同一天，负时间维持原先排除规则', async () => {
  const original = process.env.TZ;
  const entry = (id: number, occurredAt: number): Entry => ({ id, occurredAt, type: 'expense', amount: 10,
    deletedAt: 0, reimburseStatus: 'pending', createdAt: 1, updatedAt: 1 });
  try {
    process.env.TZ = 'America/New_York';
    await db.entries.bulkPut([
      entry(1, -1), entry(2, Date.parse('2026-11-01T05:30:00Z')),
      entry(3, Date.parse('2026-11-01T06:30:00Z')), entry(4, Date.parse('2026-11-02T04:30:00Z')),
      entry(5, Date.parse('2026-11-02T05:30:00Z')),
    ]);
    expect(await getMineEntrySummary()).toEqual({ days: 2, count: 4, pendingCount: 4, pendingAmount: 40 });
  } finally { if (original === undefined) delete process.env.TZ; else process.env.TZ = original; }
});

it('离开页面可中断日期统计，不继续占用后台游标', async () => {
  await db.entries.bulkPut(Array.from({length: 100}, (_, i) => ({id: i + 1, type: 'expense' as const,
    amount: 1, occurredAt: new Date(2020, 0, i + 1).getTime(), deletedAt: 0,
    reimburseStatus: 'none' as const, createdAt: 1, updatedAt: 1})));
  await expect(getMineEntrySummary(() => false)).rejects.toMatchObject({name: 'AbortError'});
  expect((await getMineEntrySummary()).days).toBe(100);
});

it('跨多年分段仍按本地自然日去重，包含分段交界与夏令时', async () => {
  const original = process.env.TZ;
  const entries: Entry[] = Array.from({ length: 700 }, (_, i) => ({ id: i + 1, type: 'expense',
    amount: 1, occurredAt: Date.parse('2020-01-01T00:00:00Z') + Math.floor(i / 2) * 86400000 * 7 + i % 2 * 3600000,
    deletedAt: i % 11 === 0 ? 1 : 0, reimburseStatus: 'none', createdAt: 1, updatedAt: 1 }));
  await db.entries.bulkPut(entries);
  try {
    for (const zone of ['UTC', 'Asia/Shanghai', 'America/New_York']) {
      process.env.TZ = zone;
      const live = entries.filter(e => e.deletedAt === 0);
      const days = new Set(live.map(e => { const d = new Date(e.occurredAt); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; })).size;
      expect(await getMineEntrySummary()).toEqual({ days, count: live.length, pendingCount: 0, pendingAmount: 0 });
    }
    let steps = 0;
    await expect(getMineEntrySummary(() => ++steps < 12)).rejects.toMatchObject({ name: 'AbortError' });
    expect(await db.entries.count()).toBe(entries.length);
    expect((await getMineEntrySummary()).count).toBe(entries.filter(e => e.deletedAt === 0).length);
  } finally { if (original === undefined) delete process.env.TZ; else process.env.TZ = original; }
});
