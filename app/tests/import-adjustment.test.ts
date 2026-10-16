import 'fake-indexeddb/auto';
import { beforeEach, expect, it } from 'vitest';
import { db } from '../src/core/db';
import { addAccount } from '../src/core/repo/accountRepo';
import { addEntry, importEntriesBatch, softDeleteEntry, restoreEntry, updateEntry } from '../src/core/repo/entryRepo';
import { entryDisplayAmount } from '../src/core/entryAmount';
import { rangeSummary } from '../src/core/repo/statsRepo';
import { summarizeImport } from '../src/features/import/reconciliation';

beforeEach(async () => { await db.delete(); await db.open(); });
it('挖财负数与零金额保持收支与余额方向，删除/恢复可逆；普通新增不能绕过金额规则', async () => {
  const accountId = await addAccount({ name: '虚构现金', group: 'cash', balance: 0 });
  const input = { type: 'expense' as const, amount: -1800, occurredAt: 123, accountId, sourceAdjustment: { source: 'wacai' as const, rowNo: 8 } };
  await expect(addEntry(input)).rejects.toThrow();
  await expect(importEntriesBatch([{ input }], { source: 'wechat', fileName: '虚构', counts: {} })).rejects.toThrow();
  const result = await importEntriesBatch([{ input }, { input: { ...input, type: 'income', amount: -500 } }, { input: { ...input, type: 'income', amount: 0 } }], { source: 'wacai', fileName: '虚构', counts: {} });
  expect((await db.accounts.get(accountId))?.balance).toBe(1300);
  expect(await db.entries.count()).toBe(3);
  expect(await rangeSummary(0, 999)).toEqual({ expense: -1800, income: -500, balance: 1300 });
  const entries = await db.entries.toArray();
  expect(entries.map(entryDisplayAmount)).toEqual([1800, -500, 0]);
  expect(summarizeImport(entries.map(e => ({ type: e.type, amountFen: e.amount })))).toMatchObject({ expense: { count: 1, amount: -1800 }, income: { count: 2, amount: -500 } });
  await expect(updateEntry(result.entryIds[0], { amount: 1800 })).rejects.toThrow();
  await softDeleteEntry(result.entryIds[0]);
  expect((await db.accounts.get(accountId))?.balance).toBe(-500);
  await restoreEntry(result.entryIds[0]);
  expect((await db.accounts.get(accountId))?.balance).toBe(1300);
});
