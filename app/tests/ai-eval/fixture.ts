import type { Account, Category, Entry } from '../../src/core/types';

/** Fictional fixture with independently checked deterministic constants. No user data. */
export const ORACLE_VERSION = 'synthetic-ledger-v2';
export const FIXED_NOW = Date.parse('2026-10-10T12:00:00+08:00');
export const localNoon = (month: number, day: number) => new Date(2026, month - 1, day, 12).getTime();
export const initialAccounts: Account[] = [
  [1, 'cash', 100000], [2, 'debit', 500000], [3, 'receivable', 0],
  [4, 'receivable', 0], [5, 'credit', -20000],
].map(([id, group, balance]) => ({ id: Number(id), group: group as Account['group'], balance: Number(balance),
  name: `PRIVATE_ACCOUNT_${id}`, note: `PRIVATE_ACCOUNT_NOTE_${id}`, hidden: false, countInNetWorth: true,
  sortOrder: Number(id), createdAt: 1, updatedAt: 1 }));
export const categories: Category[] = [
  { id: 1, name: '餐饮' }, { id: 2, name: '午餐', parentId: 1 }, { id: 3, name: '咖啡', parentId: 1 },
  { id: 4, name: '工作' }, { id: 5, name: '差旅', parentId: 4 }, { id: 6, name: '交通' },
].map(c => ({ ...c, kind: 'expense', icon: '', sortOrder: c.id, createdAt: 1, updatedAt: 1 }));
export const makeEntry = (id: number, patch: Partial<Entry> = {}): Entry => ({
  id, type: 'expense', amount: 100, accountId: 1, occurredAt: localNoon(9, 10),
  reimburseStatus: 'none', deletedAt: 0, createdAt: 1, updatedAt: 1, ...patch,
});
const principal = (id: number, month: number, day: number, amount: number, fromAccountId: number, toAccountId: number, loanKind?: Entry['loanKind']) => makeEntry(id, {
  type: loanKind ? 'loan' : 'transfer', amount, accountId: undefined, occurredAt: localNoon(month, day), fromAccountId, toAccountId, loanKind,
});
export const fixtureEntries: Entry[] = [
  makeEntry(1, { occurredAt: localNoon(8, 31), amount: 30000, accountId: 2, categoryId: 5, reimburseStatus: 'done', reimbursedAmount: 18000, reimbursedAt: localNoon(9, 5), reimburseAccountId: 2 }),
  makeEntry(2, { occurredAt: localNoon(9, 2), amount: 12345, categoryId: 2, note: 'PRIVATE_NOTE_LUNCH', merchantId: 901 }),
  makeEntry(3, { occurredAt: localNoon(9, 3), amount: 1255, accountId: 5, categoryId: 3 }),
  makeEntry(4, { occurredAt: localNoon(9, 10), amount: 2345, categoryId: 2, refundFlag: true, refundOfEntryId: 2 }),
  makeEntry(5, { occurredAt: localNoon(9, 12), amount: 20000, accountId: 2, categoryId: 5, reimburseStatus: 'done', reimbursedAmount: 15000, reimbursedAt: localNoon(10, 5), reimburseAccountId: 2 }),
  makeEntry(6, { occurredAt: localNoon(9, 15), type: 'income', amount: 300000, accountId: 2 }),
  principal(7, 9, 16, 10000, 2, 1), principal(8, 9, 17, 40000, 2, 3, 'lend'),
  principal(9, 9, 18, 10000, 3, 2, 'collect'), principal(10, 9, 19, 25000, 4, 2, 'borrow'),
  principal(11, 9, 20, 5000, 2, 4, 'repay'), principal(12, 9, 21, 10000, 2, 5),
  makeEntry(13, { occurredAt: localNoon(9, 22), type: 'income', amount: 101, note: '余额对账调整' }),
  makeEntry(14, { occurredAt: localNoon(9, 23), amount: 201, note: '余额对账调整' }),
  makeEntry(15, { occurredAt: localNoon(9, 24), amount: 77777, deletedAt: localNoon(9, 25) }),
  makeEntry(16, { occurredAt: localNoon(10, 1), amount: 8888 }),
  makeEntry(17, { occurredAt: localNoon(9, 25), amount: 4500, accountId: 2, categoryId: 6, refundFlag: true, refundOfEntryId: 18 }),
  makeEntry(18, { occurredAt: localNoon(8, 25), amount: 5000, accountId: 2, categoryId: 6 }),
];

/** Independently recomputed constants, distinct from both production and the executable oracle. */
export const GOLDEN = {
  september: { grossExpenseFen: 33801, refundFen: 6845, expenseCount: 4, refundCount: 2,
    offset: { expenseFen: 11956, reimbursementOffsetFen: 15000, incomeFen: 300101, reimbursementIncomeFen: 0, incomeCount: 2 },
    income: { expenseFen: 26956, reimbursementOffsetFen: 0, incomeFen: 318101, reimbursementIncomeFen: 18000, incomeCount: 3 } },
  october: { expenseFen: 8888, grossExpenseFen: 8888, refundFen: 0, expenseCount: 1, refundCount: 0 },
  fiscalSeptember: { expenseFen: 4589, grossExpenseFen: 9089, refundFen: 4500, expenseCount: 2, refundCount: 1 },
  septemberCategoriesOffset: [
    { name: '餐饮', expenseFen: 11255, count: 3 }, { name: '工作', expenseFen: 5000, count: 1 },
    { name: '交通', expenseFen: -4500, count: 1 }, { name: '未分类', expenseFen: 201, count: 1 },
  ],
  balances: { 1: 91012, 2: 752500, 3: 30000, 4: -20000, 5: -11255 },
  finalNet: 842257, septemberEndNet: 836145, afterDeleteLunch: 1956,
} as const;
