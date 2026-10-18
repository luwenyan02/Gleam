import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { db } from '../src/core/db';
import { accountFlows, accountStatement } from '../src/core/ledgerEvents';
import { getAccountViewData } from '../src/core/repo/accountViewRepo';
import type { Entry } from '../src/core/types';

const stamp = { createdAt: 1, updatedAt: 2 };
const entry = (id: number, patch: Partial<Entry> = {}): Entry => ({ ...stamp, id,
  type: 'expense', amount: 100, accountId: 1, categoryId: 2, occurredAt: id * 1000,
  deletedAt: 0, reimburseStatus: 'none', ...patch });
const account = (id: number) => ({ ...stamp, id, name: `虚构账户${id}`, group: 'cash' as const,
  balance: 12345, hidden: id === 2, sortOrder: id });
beforeEach(async () => { await db.delete(); await db.open(); });
afterEach(() => vi.restoreAllMocks());

it('按账户各侧及报销到账读取，去重并保留全部资金事件及余额口径', async () => {
  await db.accounts.bulkPut([account(1), account(2), account(3)]);
  const source = [entry(1), entry(2, { type: 'income' }), entry(3, { refundFlag: true }),
    entry(4, { type: 'transfer', accountId: undefined, fromAccountId: 1, toAccountId: 2 }),
    entry(5, { type: 'transfer', accountId: undefined, fromAccountId: 2, toAccountId: 1 }),
    entry(6, { type: 'loan', loanKind: 'lend', accountId: undefined, fromAccountId: 1, toAccountId: 3 }),
    entry(7, { type: 'loan', loanKind: 'borrow', accountId: undefined, fromAccountId: 3, toAccountId: 1 }),
    entry(8, { type: 'loan', loanKind: 'repay', accountId: undefined, fromAccountId: 1, toAccountId: 3 }),
    entry(9, { type: 'loan', loanKind: 'collect', accountId: undefined, fromAccountId: 3, toAccountId: 1 }),
    entry(10, { type: 'transfer', accountId: undefined, toAccountId: 1, note: '余额对账调整' }),
    entry(11, { accountId: 2, reimburseStatus: 'done', reimbursedAmount: 50, reimbursedAt: 15000, reimburseAccountId: 1 }),
    entry(12, { reimburseStatus: 'done', reimbursedAmount: 80, reimbursedAt: 15000, reimburseAccountId: 1 }),
    entry(13, { type: 'transfer', fromAccountId: 1, toAccountId: 1 }),
    entry(14, { amount: 0 }), entry(15, { amount: -20 }), entry(16, { deletedAt: 5 }),
    entry(17, { accountId: 2 }), entry(18, { accountId: 2, reimburseStatus: 'pending', reimburseAccountId: 1 })];
  await db.entries.bulkPut(source);
  const before = await db.entries.toArray();
  const data = (await getAccountViewData(1))!;
  expect(new Set(data.entries.map(e => e.id)).size).toBe(data.entries.length);
  expect(data.entries.some(e => e.deletedAt !== 0)).toBe(false);
  expect(accountStatement(accountFlows(data.entries, 1), data.account.balance))
    .toEqual(accountStatement(accountFlows(source, 1), 12345));
  expect(await db.entries.toArray()).toEqual(before);
  expect((await db.accounts.get(1))!.balance).toBe(12345);
});

it('分类父级和双侧隐藏账户按实际关联读取，不加载无关资料', async () => {
  await db.accounts.bulkPut([account(1), account(2), account(999)]);
  await db.categories.bulkPut([
    { ...stamp, id: 1, name: '虚构交通', kind: 'expense', icon: 'ic-bus', sortOrder: 1 },
    { ...stamp, id: 2, parentId: 1, name: '虚构公交', kind: 'expense', icon: 'ic-bus', sortOrder: 2 },
    { ...stamp, id: 999, name: '无关分类', kind: 'expense', icon: 'ic-bowl', sortOrder: 999 },
  ]);
  await db.entries.put(entry(1, { type: 'transfer', accountId: undefined, fromAccountId: 1, toAccountId: 2 }));
  const data = (await getAccountViewData(1))!;
  expect(data.categories.map(c => c.id).sort()).toEqual([1, 2]);
  expect(data.accounts.map(a => a.id).sort()).toEqual([1, 2]);
  expect(data.accounts.find(a => a.id === 2)!.hidden).toBe(true);
});

it('空账户、缺失关联与不存在的账户正常返回，不为不存在的账户读流水', async () => {
  await db.accounts.put(account(1));
  expect(await getAccountViewData(1)).toMatchObject({ account: { id: 1 }, entries: [], categories: [] });
  await db.entries.put(entry(1, { categoryId: 999, fromAccountId: 999 }));
  expect((await getAccountViewData(1))!.categories).toEqual([]);
  const query = vi.spyOn(db.entries, 'where');
  expect(await getAccountViewData(999)).toBeUndefined();
  expect(query).not.toHaveBeenCalled();
});

it('保留原有全账查询的时间边界：包含纪元零点，排除负时间及无效时间', async () => {
  await db.accounts.put(account(1));
  await db.entries.bulkPut([entry(1, { occurredAt: 0 }), entry(2, { occurredAt: -1 }),
    entry(3, { occurredAt: Infinity }), entry(4, { occurredAt: NaN }),
    entry(5, { occurredAt: -1000, reimburseStatus: 'done', reimbursedAmount: 50,
      reimbursedAt: 1000, reimburseAccountId: 1 })]);
  const data = (await getAccountViewData(1))!;
  expect(data.entries.map(e => e.id)).toEqual([1]);
  expect(await db.entries.count()).toBe(5);
});

it('v5 升级后历史转账、借贷及异账户报销立即可查，记录与余额原样保留', async () => {
  const schema = db.tables.map(table => ({ name: table.name,
    spec: [table.schema.primKey.src, ...table.schema.indexes.filter(index =>
      !['fromAccountId', 'toAccountId', 'reimburseAccountId'].includes(index.name)).map(index => index.src)].join(',') }));
  await db.delete();
  const legacy = new Dexie('GleamDB');
  legacy.version(5).stores(Object.fromEntries(schema.map(table => [table.name, table.spec])));
  await legacy.open();
  await legacy.table('accounts').put(account(1));
  const entries = [entry(1, { type: 'transfer', accountId: undefined, fromAccountId: 1, toAccountId: 2 }),
    entry(2, { type: 'loan', accountId: undefined, fromAccountId: 3, toAccountId: 1, loanKind: 'borrow' }),
    entry(3, { accountId: 2, reimburseStatus: 'done', reimbursedAmount: 50, reimbursedAt: 6000, reimburseAccountId: 1 })];
  await legacy.table('entries').bulkPut(entries);
  legacy.close();
  await db.open();
  const data = (await getAccountViewData(1))!;
  expect(data.entries.map(e => e.id).sort()).toEqual([1, 2, 3]);
  expect(await db.entries.toArray()).toEqual(entries);
  expect(data.account.balance).toBe(12345);
});
