import 'fake-indexeddb/auto';
import { beforeEach, expect, it } from 'vitest';
import { db, stamp } from '../src/core/db';
import type { Account, Entry } from '../src/core/types';
import { netWorthTrend } from '../src/core/repo/statsRepo';

beforeEach(async () => { await db.delete(); await db.open(); });

it('历史净资产使用所选月末且排除后续月份的收支', async () => {
  await db.accounts.put(stamp({ id: 1, name: '虚构现金', group: 'cash', balance: 13000,
    hidden: false, countInNetWorth: true, sortOrder: 1 }) as Account);
  for (const [id, occurredAt, amount, type] of [
    [1, new Date(2025, 10, 10).getTime(), 10000, 'income'],
    [2, new Date(2025, 11, 1).getTime(), 2000, 'expense'],
    [3, new Date(2026, 0, 1).getTime(), 5000, 'income'],
  ] as const) {
    await db.entries.put(stamp({ id, occurredAt, amount, type, accountId: 1,
      deletedAt: 0, reimburseStatus: 'none' }) as Entry);
  }
  expect(await netWorthTrend(2, '2025-12')).toEqual([
    { month: '2025-11', net: 10000 }, { month: '2025-12', net: 8000 },
  ]);
});

it('拒绝非法或未来月份', async () => {
  await expect(netWorthTrend(6, '2025-13')).rejects.toThrow();
  await expect(netWorthTrend(6, '9999-01')).rejects.toThrow();
});
