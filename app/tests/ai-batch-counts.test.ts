import 'fake-indexeddb/auto';
import { beforeEach, expect, it, vi } from 'vitest';
import { softDeleteEntry } from '../src/core/repo/entryRepo';
import { db } from '../src/core/db';
import { countAiBatchEntries, listAiBatchEntries, listAiBatches } from '../src/core/repo/aiRepo';

beforeEach(async () => { await db.delete(); await db.open(); });
it('空批次不读取流水，只统计指定批次的未删除流水', async () => {
  await db.entries.bulkPut(Array.from({length: 100}, (_, i) => ({id: i + 1, type: 'expense' as const,
    amount: 100, occurredAt: 1, deletedAt: i === 1 ? 10 : 0, importBatchId: i < 3 ? 7 : 8,
    reimburseStatus: 'none' as const, createdAt: 1, updatedAt: 1})));
  const read = vi.spyOn(IDBObjectStore.prototype, 'getAll');
  try {
    expect(await countAiBatchEntries([])).toEqual(new Map());
    expect(await countAiBatchEntries([7, 9])).toEqual(new Map([[7, 2], [9, 0]]));
    expect(read.mock.contexts.filter(store => store.name === 'entries')).toHaveLength(0);
  } finally { read.mockRestore(); }
});

it('最近批次跳过普通导入，撤销只读取指定批次的有效流水', async () => {
  await db.importBatches.bulkPut(Array.from({length: 8}, (_, i) => ({id: i + 1, source: i % 2 ? 'ai' as const : 'alipay' as const,
    createdAt: i + 1, updatedAt: i + 1, counts: {expense: 1, income: 0, transfer: 0, loan: 0}, fileName: '虚构导入'})));
  expect((await listAiBatches()).map(b => b.id)).toEqual([8, 6, 4]);
  expect(await listAiBatches(0)).toEqual([]);
  const row = {type: 'expense' as const, amount: 100, occurredAt: 1, reimburseStatus: 'none' as const, createdAt: 1, updatedAt: 1};
  await db.entries.bulkPut([{...row, id: 1, importBatchId: 8, deletedAt: 0}, {...row, id: 2, importBatchId: 8, deletedAt: 2}, {...row, id: 3, importBatchId: 6, deletedAt: 0}]);
  expect((await listAiBatchEntries(8)).map(e => e.id)).toEqual([1]);
});

it('撤销流水只查关联退款，不扫描无关账单，已有退款仍联动删除', async () => {
  const row = {type: 'expense' as const, amount: 100, occurredAt: 1, reimburseStatus: 'none' as const, createdAt: 1, updatedAt: 1, deletedAt: 0};
  await db.entries.bulkPut([{...row, id: 1}, {...row, id: 2, refundFlag: true, refundOfEntryId: 1}, {...row, id: 3}]);
  const cursor = vi.spyOn(IDBObjectStore.prototype, 'openCursor');
  const read = vi.spyOn(IDBObjectStore.prototype, 'getAll');
  try {
    await softDeleteEntry(1);
    expect(cursor.mock.contexts.filter(store => store.name === 'entries')).toHaveLength(0);
    expect(read.mock.contexts.filter(store => store.name === 'entries')).toHaveLength(0);
    expect((await db.entries.get(1))!.deletedAt).toBeGreaterThan(0);
    expect((await db.entries.get(2))!.deletedAt).toBeGreaterThan(0);
    expect((await db.entries.get(3))!.deletedAt).toBe(0);
  } finally { cursor.mockRestore(); read.mockRestore(); }
});
