import 'fake-indexeddb/auto';
import { beforeEach, expect, it } from 'vitest';
import { db } from '../src/core/db';
import { restoreAll } from '../src/core/repo/backupRepo';
import { restoredEntryRange, restoreFailureMessage } from '../src/features/backup/restoreStatus';

beforeEach(async () => {
  await db.transaction('rw', db.tables, async () => {
    for (const table of db.tables) await table.clear();
  });
});

it('reports bounded write progress and commits every restored record', async () => {
  const rows = Array.from({ length: 2505 }, (_, i) => ({ id: i + 1, amount: 100, occurredAt: i, deletedAt: 0 }));
  const steps: number[] = [];
  await restoreAll({ entries: rows }, progress => steps.push(progress.completed));
  expect(await db.entries.count()).toBe(2505);
  expect(steps[0]).toBe(0);
  expect(steps.at(-1)).toBe(2505);
  expect(steps.filter(n => n > 0 && n < 2505).length).toBeGreaterThan(1);
  expect(steps.every((n, i) => !i || n >= steps[i - 1])).toBe(true);
});

it('rolls back all tables if a later write batch fails', async () => {
  await db.entries.add({ id: 77, amount: 88 } as never);
  await db.accounts.add({ id: 77, name: '原账户' } as never);
  const entries = Array.from({ length: 2001 }, (_, i) => ({ id: i === 2000 ? 1 : i + 1, amount: 100 }));
  await expect(restoreAll({ entries, accounts: [{ id: 1, name: '替换账户' }] })).rejects.toThrow();
  expect(await db.entries.toArray()).toEqual([{ id: 77, amount: 88 }]);
  expect(await db.accounts.toArray()).toEqual([{ id: 77, name: '原账户' }]);
});

it('a failed progress renderer does not abort a valid restore', async () => {
  await expect(restoreAll({ entries: [{ id: 1 }] }, () => { throw new Error('UI detached'); })).resolves.toBeUndefined();
  expect(await db.entries.count()).toBe(1);
});

it('finds a large restored ledger date range without argument expansion', () => {
  const start = new Date(2024, 0, 1).getTime();
  const end = new Date(2026, 9, 24).getTime();
  const entries = Array.from({ length: 200000 }, (_, id) => ({ occurredAt: id % 2 ? start : end, deletedAt: 0 }));
  entries.push({ occurredAt: new Date(2000, 0, 1).getTime(), deletedAt: 1 });
  expect(restoredEntryRange(entries)).toBe('2024-01-01 ~ 2026-10-24');
  expect(restoredEntryRange([])).toBe('无账单');
  expect(restoredEntryRange([{ occurredAt: NaN, deletedAt: 0 }])).toBe('无账单');
});

it('does not claim restore was unexecuted after its transaction committed', () => {
  expect(restoreFailureMessage(false).title).toBe('恢复未完成');
  expect(restoreFailureMessage(false).message).toContain('原数据未被替换');
  expect(restoreFailureMessage(true).title).toBe('数据已恢复');
  expect(restoreFailureMessage(true).message).toContain('请勿重复恢复');
});
