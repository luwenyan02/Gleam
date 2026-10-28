import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { db } from '../src/core/db';
import type { Entry } from '../src/core/types';
import { listRefunds } from '../src/core/repo/entryRepo';
import { getEntryViewData } from '../src/core/repo/entryViewRepo';

const stamp = { createdAt: 1, updatedAt: 2 };
const entry = (patch: Partial<Entry> = {}): Entry => ({ ...stamp, id: 1, type: 'expense', amount: 10000, occurredAt: 1000, deletedAt: 0, reimburseStatus: 'none', ...patch });
beforeEach(async () => { await db.delete(); await db.open(); });
afterEach(() => vi.restoreAllMocks());

it('只读取当前账单的分类父级、账户、商家、标签、来源及有序凭证，保留隐藏账户', async () => {
  await db.entries.put(entry({ categoryId: 2, accountId: 1, merchantId: 1, importBatchId: 1 }));
  await db.categories.bulkPut([
    { ...stamp, id: 1, name: '交通', kind: 'expense', icon: 'ic-bus', sortOrder: 1 },
    { ...stamp, id: 2, name: '公交', kind: 'expense', parentId: 1, icon: 'ic-bus', sortOrder: 2 },
  ]);
  await db.accounts.put({ ...stamp, id: 1, name: '虚构隐藏账户', group: 'cash', hidden: true, balance: 100, sortOrder: 1 });
  await db.merchants.put({ ...stamp, id: 1, name: '虚构商家', useCount: 1 });
  await db.tags.bulkPut([{ ...stamp, id: 1, name: 'B' }, { ...stamp, id: 2, name: 'A' }]);
  await db.entryTags.bulkPut([{ id: 1, entryId: 1, tagId: 1 }, { id: 2, entryId: 1, tagId: 2 }, { id: 3, entryId: 1, tagId: 999 }, { id: 4, entryId: 1, tagId: 1 }]);
  await db.importBatches.put({ ...stamp, id: 1, source: 'wacai', fileName: 'fictional.xlsx', counts: {} });
  for (const id of [1, 2]) await db.attachments.put({ ...stamp, id, blob: new Blob(['fictional']), mime: 'image/png', size: 9 });
  await db.entryAttachments.bulkPut([{ id: 1, entryId: 1, attachmentId: 1, sortOrder: 2 }, { id: 2, entryId: 1, attachmentId: 2, sortOrder: 1 }]);
  // 详情不允许退回遍历账本、全部商家或全部标签的读取方式。
  vi.spyOn(db.entries, 'filter').mockImplementation(() => { throw new Error('不应扫描整本账'); });
  vi.spyOn(db.merchants, 'toArray').mockImplementation(() => { throw new Error('不应读取全部商家'); });
  vi.spyOn(db.tags, 'toArray').mockImplementation(() => { throw new Error('不应读取全部标签'); });
  const data = (await getEntryViewData(1))!;
  expect(data.category?.name).toBe('公交'); expect(data.categoryParent?.name).toBe('交通');
  expect(data.accounts.map(account => account.name)).toEqual(['虚构隐藏账户']);
  expect(data.merchant?.name).toBe('虚构商家'); expect(data.tags.map(tag => tag.name)).toEqual(['A', 'B']);
  expect(data.batch?.fileName).toBe('fictional.xlsx'); expect(data.receipts.map(receipt => receipt.id)).toEqual([2, 1]);
});

it('退款索引只取当前原单的有效退款，保留负额冲回且按时间倒序', async () => {
  await db.entries.bulkPut([entry(), entry({ id: 2, refundFlag: true, refundOfEntryId: 1, amount: 1500 }),
    entry({ id: 3, refundFlag: true, refundOfEntryId: 1, amount: -500, occurredAt: 2000 }),
    entry({ id: 4, refundFlag: true, refundOfEntryId: 1, amount: 999, deletedAt: 2 }),
    entry({ id: 5, refundFlag: true, refundOfEntryId: 999, amount: 888 }), entry({ id: 6, refundOfEntryId: 1, amount: 777 })]);
  const data = (await getEntryViewData(1))!;
  expect(data.refunds.map(row => row.id)).toEqual([3, 2]);
  expect(data.entry.amount - data.refunds.reduce((sum, row) => sum + row.amount, 0)).toBe(9000);
  const refund = (await getEntryViewData(2))!;
  expect(refund.original?.id).toBe(1); expect(refund.refunds).toEqual([]);
});

it('转账及借贷仅读取实际两侧账户，不重复加载同一账户', async () => {
  await db.accounts.bulkPut([1, 2, 3].map(id => ({ ...stamp, id, name: `虚构账户${id}`, group: 'cash' as const, hidden: false, balance: 100, sortOrder: id })));
  await db.entries.put(entry({ type: 'transfer', fromAccountId: 1, toAccountId: 2 }));
  expect((await getEntryViewData(1))!.accounts.map(account => account.id)).toEqual([1, 2]);
  await db.entries.put(entry({ type: 'loan', loanKind: 'collect', accountId: 1, fromAccountId: 1, toAccountId: 3 }));
  expect((await getEntryViewData(1))!.accounts.map(account => account.id)).toEqual([1, 3]);
});

it('缺失关联资料保留账单，删除或不存在的账单不再加载关联资料', async () => {
  await db.entries.put(entry({ categoryId: 999, accountId: 999, merchantId: 999, importBatchId: 999 }));
  expect(await getEntryViewData(1)).toMatchObject({ entry: { id: 1 }, category: undefined, merchant: undefined, accounts: [], tags: [], receipts: [] });
  await db.entries.update(1, { deletedAt: 2 });
  const lookups = vi.spyOn(db.accounts, 'bulkGet');
  expect(await getEntryViewData(1)).toBeUndefined(); expect(await getEntryViewData(999)).toBeUndefined(); expect(lookups).not.toHaveBeenCalled();
});

it('从 v4 升级只补退款关联索引，原账单、余额及历史记录逐条保持不变', async () => {
  const schema = Object.fromEntries(db.tables.map(table => [table.name, [table.schema.primKey.src, ...table.schema.indexes.filter(index => !['refundOfEntryId', 'fromAccountId', 'toAccountId', 'reimburseAccountId'].includes(index.name)).map(index => index.src)].join(',')]));
  await db.delete();
  const legacy = new Dexie('GleamDB'); legacy.version(4).stores(schema); await legacy.open();
  const entries = [entry(), entry({ id: 2, refundFlag: true, refundOfEntryId: 1, amount: 500 }), entry({ id: 3, deletedAt: 99 })];
  const account = { ...stamp, id: 1, name: '虚构账户', group: 'cash', hidden: false, balance: 12345, sortOrder: 1 };
  await legacy.table('entries').bulkPut(entries); await legacy.table('accounts').put(account); legacy.close();
  await db.open();
  expect(db.verno).toBe(7); expect(db.entries.schema.idxByName.refundOfEntryId).toBeDefined();
  expect(await db.entries.toArray()).toEqual(entries); expect(await db.accounts.get(1)).toEqual(account);
  expect((await listRefunds(1)).map(row => row.id)).toEqual([2]);
});
