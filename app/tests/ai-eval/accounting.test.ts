import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/core/db';
import type { Category, Entry } from '../../src/core/types';
import { addEntry, restoreEntry, softDeleteEntry } from '../../src/core/repo/entryRepo';
import { setSetting } from '../../src/core/repo/settingsRepo';
import { getLifeLedgerReview, lifeLedgerReviewText, type LifeLedgerScope } from '../../src/core/repo/lifeLedgerContextRepo';
import { netWorthTrend, rangeSummary } from '../../src/core/repo/statsRepo';
import { categories, FIXED_NOW, fixtureEntries, GOLDEN, initialAccounts, makeEntry } from './fixture';
import { oracleBalances, oracleRange, oracleSummary } from './oracle';
import { installOfflineOutbound } from './outbound';

const outbound = installOfflineOutbound(import.meta.url);
const question = '分析我的2026年9月消费';
const baseScope: LifeLedgerScope = { month: '2026-09', period: 'calendar', includeIncome: true };
const sum = (values: number[]) => values.reduce((s, v) => s + v, 0);

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(FIXED_NOW);
  await db.delete(); await db.open();
  await db.categories.bulkPut(structuredClone(categories));
});
afterEach(() => { expect(outbound.requests).toHaveLength(0); vi.useRealTimers(); });

async function seedFixture(): Promise<Map<number, number>> {
  await db.accounts.bulkPut(structuredClone(initialAccounts));
  const ids = new Map<number, number>();
  // Production writes are the system under test; expectations never call their helpers.
  for (const row of [...fixtureEntries].sort((a, b) => a.occurredAt - b.occurredAt)) {
    const { id, createdAt: _c, updatedAt: _u, deletedAt, ...input } = row;
    if (input.refundOfEntryId != null) input.refundOfEntryId = ids.get(input.refundOfEntryId)!;
    const actual = await addEntry(input); ids.set(id, actual);
    if (deletedAt) await softDeleteEntry(actual);
  }
  return ids;
}

describe('independent integer-cents oracle', () => {
  it('pins all 18 fictional rows to independently recomputed September figures', () => {
    expect(fixtureEntries).toHaveLength(18);
    for (const mode of ['offset', 'income'] as const) {
      const o = oracleSummary(fixtureEntries, categories, oracleRange('2026-09'), mode, true);
      const g = GOLDEN.september;
      expect(o.totals).toEqual({ grossExpenseFen: g.grossExpenseFen, refundFen: g.refundFen, expenseCount: g.expenseCount, refundCount: g.refundCount,
        expenseFen: g[mode].expenseFen, reimbursementOffsetFen: g[mode].reimbursementOffsetFen });
      expect(o.income).toEqual({ incomeFen: g[mode].incomeFen, reimbursementIncomeFen: g[mode].reimbursementIncomeFen, count: g[mode].incomeCount });
    }
    expect(oracleSummary(fixtureEntries, categories, oracleRange('2026-09'), 'offset', false).categories).toEqual(GOLDEN.septemberCategoriesOffset);
  });
  it('pins independent signed postings and prior-month net assets', () => {
    expect(oracleBalances(initialAccounts, fixtureEntries)).toEqual(GOLDEN.balances);
    expect(sum(Object.values(oracleBalances(initialAccounts, fixtureEntries)))).toBe(GOLDEN.finalNet);
    expect(sum(Object.values(oracleBalances(initialAccounts, fixtureEntries, oracleRange('2026-10').from)))).toBe(GOLDEN.septemberEndNet);
  });
  it('rejects unsafe inputs and exact BigInt sum overflow', () => {
    const range = oracleRange('2026-09');
    expect(() => oracleSummary([makeEntry(1, { amount: 0.1 })], categories, range, 'offset', false)).toThrow('unsafe');
    expect(() => oracleSummary([makeEntry(1, { amount: Number.MAX_SAFE_INTEGER }), makeEntry(2, { amount: 1 })], categories, range, 'offset', false)).toThrow('overflow');
  });
});

const reportCases = [
  { month: '2026-09', period: 'calendar' as const, start: 1 },
  { month: '2026-10', period: 'calendar' as const, start: 1 },
  { month: '2026-09', period: 'accounting' as const, start: 20 },
].flatMap(scope => [false, true].flatMap(includeIncome => [false, true].map(asIncome => ({ ...scope, includeIncome, asIncome }))));

describe('accounting and report consistency', () => {
  it.each(reportCases)('$month $period includeIncome=$includeIncome reimbursementIncome=$asIncome', async ({ month, period, start, includeIncome, asIncome }) => {
    await seedFixture();
    await setSetting('accounting.monthStartDay', start); await setSetting('reimburse.countAsIncome', asIncome);
    const range = oracleRange(month, start);
    const expected = oracleSummary(fixtureEntries, categories, range, asIncome ? 'income' : 'offset', includeIncome);
    const review = await getLifeLedgerReview(question, { month, period, includeIncome });
    expect(review.summary.range).toMatchObject(range);
    expect(review.summary.scope).toEqual({ month, period, includeIncome });
    expect(review.summary).toMatchObject(expected);
    expect(review.summary.currency).toBe('CNY'); expect(review.summary.unit).toBe('fen');
    expect(review.summary.reimbursementMode).toBe(asIncome ? 'income' : 'offset');
    if (!includeIncome) expect(review.summary).not.toHaveProperty('income');
    expect(sum(review.summary.categories.map(c => c.expenseFen))).toBe(review.summary.totals.expenseFen);
    // Cross-component consistency is supplemental, never the correctness oracle.
    const report = await rangeSummary(range.from, range.to);
    expect(report.expense).toBe(expected.totals.expenseFen);
    expect(report.income).toBe(oracleSummary(fixtureEntries, categories, range, asIncome ? 'income' : 'offset', true).income!.incomeFen);
    if (month === '2026-10') expect(review.summary.totals).toMatchObject(GOLDEN.october);
    if (period === 'accounting') expect(review.summary.totals).toMatchObject(GOLDEN.fiscalSeptember);
  });
  it('real repository writes preserve principal, credit repayments, refunds and balances', async () => {
    await seedFixture();
    expect(Object.fromEntries((await db.accounts.toArray()).map(a => [a.id, a.balance]))).toEqual(GOLDEN.balances);
    expect(await netWorthTrend(1, '2026-09')).toEqual([{ month: '2026-09', net: GOLDEN.septemberEndNet }]);
    expect(await netWorthTrend(1, '2026-10')).toEqual([{ month: '2026-10', net: GOLDEN.finalNet }]);
  });
  it('deleting an expense excludes its linked refund; restoring replays both once', async () => {
    const ids = await seedFixture();
    await softDeleteEntry(ids.get(2)!); await softDeleteEntry(ids.get(2)!);
    expect((await getLifeLedgerReview(question, baseScope)).summary.totals.expenseFen).toBe(GOLDEN.afterDeleteLunch);
    expect((await db.entries.get(ids.get(4)!))!.deletedAt).toBeGreaterThan(0);
    const afterDelete = fixtureEntries.map(row => [2, 4].includes(row.id) ? { ...row, deletedAt: FIXED_NOW } : row);
    expect(Object.fromEntries((await db.accounts.toArray()).map(a => [a.id, a.balance]))).toEqual(oracleBalances(initialAccounts, afterDelete));
    await restoreEntry(ids.get(2)!); await restoreEntry(ids.get(2)!);
    expect((await getLifeLedgerReview(question, baseScope)).summary.totals.expenseFen).toBe(GOLDEN.september.offset.expenseFen);
    expect((await db.entries.get(ids.get(4)!))!.deletedAt).toBe(0);
    expect(Object.fromEntries((await db.accounts.toArray()).map(a => [a.id, a.balance]))).toEqual(GOLDEN.balances);
  });
  it.each(['empty', 'principal-only'] as const)('%s data produces explicit zeros without a model request', async kind => {
    if (kind === 'principal-only') await db.entries.bulkPut(fixtureEntries.filter(r => r.type === 'loan' || r.type === 'transfer'));
    const review = await getLifeLedgerReview(question, baseScope);
    expect(review.summary.totals).toEqual({ expenseFen: 0, grossExpenseFen: 0, refundFen: 0, reimbursementOffsetFen: 0, expenseCount: 0, refundCount: 0 });
    expect(review.summary.categories).toEqual([]);
    expect(review.summary.income).toEqual({ incomeFen: 0, reimbursementIncomeFen: 0, count: 0 });
  });
  it('one-cent precision and preview formatting never round or double-subtract refunds', async () => {
    await seedFixture();
    const review = await getLifeLedgerReview(question, baseScope);
    const preview = lifeLedgerReviewText(review);
    expect(preview).toContain('净支出 ¥119.56'); expect(preview).toContain('原始支出 ¥338.01');
    expect(preview).toContain('冲抵 ¥68.45'); expect(preview).toContain('冲抵 ¥150.00');
    expect(review.summary.totals.expenseFen).toBe(33801 - 6845 - 15000);
  });
});

const boundaryCases = ['2024-02', '2025-02', '2026-03', '2026-11', '2026-12'].flatMap(month => [1, 20, 28].map(start => ({ month, start })));
describe('local half-open periods and DST', () => {
  it.each(boundaryCases)('$month start=$start handles 1 ms, leap/year and offset boundaries', async ({ month, start }) => {
    const range = oracleRange(month, start);
    await setSetting('accounting.monthStartDay', start); await setSetting('reimburse.countAsIncome', true);
    const rows = [
      makeEntry(1, { amount: 10001, occurredAt: range.from }), makeEntry(2, { amount: 9999, occurredAt: range.from - 1 }),
      makeEntry(3, { amount: 101, occurredAt: range.to - 1, refundFlag: true }), makeEntry(4, { amount: 9998, occurredAt: range.to, refundFlag: true }),
      makeEntry(5, { amount: 1000, occurredAt: range.from - 10000, reimburseStatus: 'done', reimbursedAmount: 321, reimbursedAt: range.from, reimburseAccountId: 1 }),
      makeEntry(6, { amount: 1000, occurredAt: range.from - 10000, reimburseStatus: 'done', reimbursedAmount: 654, reimbursedAt: range.to - 1, reimburseAccountId: 1 }),
      makeEntry(7, { amount: 1000, occurredAt: range.from - 10000, reimburseStatus: 'done', reimbursedAmount: 987, reimbursedAt: range.to, reimburseAccountId: 1 }),
    ];
    await db.entries.bulkPut(rows);
    const { summary } = await getLifeLedgerReview(question, { month, period: 'accounting', includeIncome: true });
    expect(summary.range).toMatchObject(range);
    expect(summary).toMatchObject(oracleSummary(rows, categories, range, 'income', true));
    expect(summary.totals).toEqual({ expenseFen: 9900, grossExpenseFen: 10001, refundFen: 101, reimbursementOffsetFen: 0, expenseCount: 1, refundCount: 1 });
    expect(summary.income).toEqual({ incomeFen: 975, reimbursementIncomeFen: 975, count: 2 });
    if (start === 1) {
      const natural = await getLifeLedgerReview(question, { month, period: 'calendar', includeIncome: true });
      expect(natural.summary.totals).toEqual(summary.totals); expect(natural.summary.range).toEqual(summary.range);
    }
  });
  it.each(['2026-03', '2026-11'])('%s uses local midnight despite variable DST elapsed hours', async month => {
    const { from, to } = oracleRange(month);
    const nominalDays = month.endsWith('03') ? 31 : 30;
    const offsetChange = (new Date(to).getTimezoneOffset() - new Date(from).getTimezoneOffset()) * 60000;
    expect(to - from).toBe(nominalDays * 86400000 + offsetChange);
    if (process.env.TZ === 'America/New_York') expect(offsetChange).toBe(month.endsWith('03') ? -3600000 : 3600000);
    const review = await getLifeLedgerReview(question, { ...baseScope, month });
    expect(new Date(review.summary.range.from).getHours()).toBe(0); expect(new Date(review.summary.range.to).getHours()).toBe(0);
  });
});

describe('category conservation and numerical safety', () => {
  it('parent/child, unknown ids and equal names remain correctly grouped', async () => {
    const extra: Category[] = [{ id: 7, name: '餐饮', kind: 'expense', icon: '', sortOrder: 7, createdAt: 1, updatedAt: 1 }];
    await db.categories.bulkPut(extra);
    const rows = [makeEntry(1, { categoryId: 2, amount: 101 }), makeEntry(2, { categoryId: 3, amount: 202 }), makeEntry(3, { categoryId: 7, amount: 404 }), makeEntry(4, { categoryId: 999, amount: 505 }), makeEntry(5, { amount: 606 })];
    await db.entries.bulkPut(rows);
    const { summary } = await getLifeLedgerReview(question, baseScope);
    expect(summary).toMatchObject(oracleSummary(rows, [...categories, ...extra], oracleRange('2026-09'), 'offset', true));
    expect(summary.categories.filter(c => c.name === '餐饮')).toHaveLength(2);
    expect(summary.categories.find(c => c.name === '未分类')).toEqual({ name: '未分类', expenseFen: 1111, count: 2 });
  });
  it.each([12, 13, 20])('%i categories keep totals/counts with explicit overflow group and clipped names', async count => {
    const cats: Category[] = Array.from({ length: count }, (_, i) => ({ id: 20 + i, name: `分类${i}${'长'.repeat(90)}`, kind: 'expense', icon: '', sortOrder: i, createdAt: 1, updatedAt: 1 }));
    const rows = cats.map((c, i) => makeEntry(i + 1, { categoryId: c.id, amount: (i + 1) * 101, refundFlag: i === 1 }));
    await db.categories.bulkPut(cats); await db.entries.bulkPut(rows);
    const { summary } = await getLifeLedgerReview(question, baseScope);
    expect(summary).toMatchObject(oracleSummary(rows, cats, oracleRange('2026-09'), 'offset', true));
    expect(summary.categories).toHaveLength(Math.min(count, 13));
    expect(sum(summary.categories.map(c => c.expenseFen))).toBe(summary.totals.expenseFen);
    expect(sum(summary.categories.map(c => c.count))).toBe(count);
    expect(summary.categories.every(c => c.name.length <= 80)).toBe(true);
    if (count > 12) expect(summary.categories.at(-1)!.name).toBe('其他分类（合并）');
  });
  it.each([0.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY])('rejects corrupt amount %s before constructing the review', async amount => {
    await db.entries.put(makeEntry(1, { amount }));
    await expect(getLifeLedgerReview(question, baseScope)).rejects.toThrow('安全范围');
  });
  it('accepts one safe maximum but rejects cumulative overflow', async () => {
    await db.entries.put(makeEntry(1, { amount: Number.MAX_SAFE_INTEGER }));
    expect((await getLifeLedgerReview(question, baseScope)).summary.totals.expenseFen).toBe(Number.MAX_SAFE_INTEGER);
    await db.entries.put(makeEntry(2, { amount: 1 }));
    await expect(getLifeLedgerReview(question, baseScope)).rejects.toThrow('安全范围');
  });
  it('conservatively rejects gross-plus-reimbursement overflow even when the net would be safe', async () => {
    const rows = [makeEntry(1, { amount: Number.MAX_SAFE_INTEGER, reimburseStatus: 'done', reimbursedAmount: 1, reimbursedAt: FIXED_NOW, reimburseAccountId: 1 })];
    expect(oracleSummary(rows, categories, oracleRange('2026-09'), 'offset', true).totals.expenseFen).toBe(Number.MAX_SAFE_INTEGER - 1);
    await db.entries.bulkPut(rows);
    // Current production guard intentionally rejects the intermediate validation sum.
    // Record the conservative boundary, do not misreport it as an exact oracle match.
    await expect(getLifeLedgerReview(question, baseScope)).rejects.toThrow('安全范围');
  });
  it('validates fractional reimbursement and income sum independently', async () => {
    await db.entries.put(makeEntry(1, { reimburseStatus: 'done', reimbursedAmount: 0.5, reimbursedAt: FIXED_NOW, reimburseAccountId: 1 }));
    await expect(getLifeLedgerReview(question, baseScope)).rejects.toThrow('安全范围');
    await db.entries.clear();
    await db.entries.bulkPut([makeEntry(1, { type: 'income', amount: Number.MAX_SAFE_INTEGER }), makeEntry(2, { type: 'income', amount: 1 })]);
    await expect(getLifeLedgerReview(question, baseScope)).rejects.toThrow('安全范围');
  });
});
