import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/core/db';
import type { Entry } from '../src/core/types';
import { getEarliestEntryDate, listEntries } from '../src/core/repo/entryRepo';
import { listEntryTagLinks } from '../src/core/repo/tagRepo';
import { loadReportStats, rangeSummary, categoryBreakdown, accountRanking, tagRanking, merchantRanking, incomeCategoryBreakdown } from '../src/core/repo/statsRepo';
import { setSetting } from '../src/core/repo/settingsRepo';

const row = (id: number, patch: Partial<Entry> = {}): Entry => ({ id, type: 'expense', amount: 1000, occurredAt: 100,
  accountId: 1, categoryId: 2, merchantId: 1, deletedAt: 0, reimburseStatus: 'none', createdAt: 1, updatedAt: 1, ...patch });

beforeEach(async () => {
  await db.delete(); await db.open();
  await db.categories.bulkPut([
    { id: 1, name: '虚构大类', kind: 'expense' as const },
    { id: 2, name: '虚构小类', kind: 'expense' as const, parentId: 1 },
    { id: 3, name: '虚构收入', kind: 'income' as const },
  ].map(c => ({ ...c, icon: 'ic-coin', sortOrder: c.id, createdAt: 1, updatedAt: 1 })));
  await db.entries.bulkPut([
    row(1), row(2, { occurredAt: 200, amount: 200, refundFlag: true }),
    row(3, { type: 'income', categoryId: 3, occurredAt: 210, amount: 3000 }),
    row(4, { occurredAt: 50, amount: 600, reimburseStatus: 'done', reimbursedAmount: 400, reimbursedAt: 250, reimburseAccountId: 2 }),
    row(5, { occurredAt: 300, amount: 500, merchantId: 2, reimburseStatus: 'done', reimbursedAmount: 100, reimbursedAt: 350, reimburseAccountId: 2 }),
    row(6, { type: 'transfer', occurredAt: 100, fromAccountId: 1, toAccountId: 2 }),
    row(7, { occurredAt: 160, deletedAt: 1 }), row(8, { occurredAt: 400 }),
    row(9, { type: 'loan', loanKind: 'collect', occurredAt: 180, fromAccountId: 2, toAccountId: 1 }),
    row(10, { amount: 0, occurredAt: 180 }),
  ]);
  await db.entryTags.bulkPut([{ id: 1, entryId: 1, tagId: 1 }, { id: 2, entryId: 1, tagId: 2 },
    { id: 3, entryId: 2, tagId: 1 }, { id: 4, entryId: 4, tagId: 2 }, { id: 5, entryId: 5, tagId: 1 }]);
});

describe('页面查询结果保持一致', () => {
  it('最早时间排除回收站；空账本无日期', async () => {
    await db.entries.put(row(11, { occurredAt: 1, deletedAt: 1 }));
    expect(await getEarliestEntryDate()).toBe(50);
    await db.entries.clear(); expect(await getEarliestEntryDate()).toBeUndefined();
  });
  it('普通查询仍按时间和同时间主键倒序，空筛选与限制语义不变', async () => {
    expect((await listEntries({ from: 100, to: 200 })).map(e => e.id)).toEqual([10, 9, 6, 1]);
    expect((await listEntries({ limit: 2 })).map(e => e.id)).toEqual([8, 5]);
    expect(await listEntries({ categoryIds: [] })).toEqual([]);
    expect(await listEntries({ accountIds: [] })).toEqual([]);
  });
  it('报销候选按时间排序后限制，保留时间边界、类型和账户组合筛选', async () => {
    await db.entries.bulkPut([row(12, { occurredAt: 300, reimburseStatus: 'done' }), row(13, { occurredAt: 300, reimburseStatus: 'done', deletedAt: 1 })]);
    expect((await listEntries({ reimburseStatus: 'done', type: 'expense', from: 50, to: 400, limit: 2 })).map(e => e.id)).toEqual([12, 5]);
    expect((await listEntries({ reimburseStatus: 'done', from: 50, to: 300, accountIds: [1], categoryIds: [2] })).map(e => e.id)).toEqual([4]);
    expect(await listEntries({ reimburseStatus: 'pending' })).toEqual([]);
    expect((await listEntries({ reimburseStatus: 'none', from: 100, to: 200 })).map(e => e.id)).toEqual([10, 9, 6, 1]);
  });
  it('批量标签只取选中流水，重复 id 不重复关联；未传范围时保留全部关联', async () => {
    expect((await listEntryTagLinks([1, 1, 5])).map(l => l.id)).toEqual([1, 2, 5]);
    expect(await listEntryTagLinks([])).toEqual([]);
    expect(await listEntryTagLinks()).toHaveLength(5);
    const ids = Array.from({ length: 270 }, (_, i) => 270 - i);
    expect(await listEntryTagLinks(ids)).toEqual(await listEntryTagLinks());
  });
  for (const asIncome of [false, true]) it(`报表同一快照保留退款、零额、转账、借贷、跨期报销及各维度口径（计收入=${asIncome}）`, async () => {
    await setSetting('reimburse.countAsIncome', asIncome);
    const from = 100, to = 400, buckets = [{ from: 100, to: 200 }, { from: 200, to: 300 }, { from: 300, to: 400 }];
    const before = await db.entries.toArray();
    const data = await loadReportStats(from, to, buckets);
    expect(data.summary).toEqual(asIncome ? { expense: 1300, income: 3500, balance: 2200 } : { expense: 1200, income: 3000, balance: 1800 });
    expect(data.categories).toEqual([{ categoryId: 1, amount: asIncome ? 1300 : 1200 }]);
    expect(data.accounts).toEqual([{ accountId: 1, amount: asIncome ? 1300 : 1200 }]);
    expect(data.tags).toEqual([{ tagId: 1, amount: asIncome ? 1300 : 1200 }, { tagId: 2, amount: 1000 }]);
    expect(data.incomes).toEqual([{ categoryId: 3, amount: 3000 }]);
    expect(data.merchants).toEqual([{ merchantId: 1, amount: 800 }, { merchantId: 2, amount: asIncome ? 500 : 400 }]);
    expect(data.summary).toEqual(await rangeSummary(from, to));
    expect(data.categories).toEqual(await categoryBreakdown(from, to));
    expect(data.accounts).toEqual(await accountRanking(from, to));
    expect(data.tags).toEqual(await tagRanking(from, to));
    expect(data.incomes).toEqual(await incomeCategoryBreakdown(from, to));
    expect(data.merchants).toEqual(await merchantRanking(from, to));
    expect(data.trend).toEqual(await Promise.all(buckets.map(b => rangeSummary(b.from, b.to))));
    expect(await db.entries.toArray()).toEqual(before);
  });
});
