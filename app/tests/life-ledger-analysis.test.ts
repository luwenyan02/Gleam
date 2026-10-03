import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/core/db';
import type { Entry } from '../src/core/types';
import { setSetting } from '../src/core/repo/settingsRepo';
import {
  approveLifeLedgerReview, consumeLifeLedgerGrant, getLifeLedgerEvidence, getLifeLedgerFollowUps,
  getLifeLedgerReview, isLifeLedgerQuestion, lifeLedgerCategoryShares, lifeLedgerPeriods,
  lifeLedgerReviewCount, lifeLedgerReviewText, suggestLifeLedgerScope, assertLifeLedgerReviewFresh, type LifeLedgerScope,
} from '../src/core/repo/lifeLedgerContextRepo';

// Fictional local-only fixtures. No AI endpoint or credential is used.
const scope: LifeLedgerScope = { month: '2026-09', period: 'calendar', includeIncome: false };
const question = '分析我的支出';
const destination = { baseUrl: 'https://fictional-stage3.invalid/v1', model: 'offline' };
const at = (month: number, day = 10) => new Date(2026, month - 1, day, 12).getTime();
const entry = (id: number, patch: Partial<Entry> = {}): Entry => ({
  id, type: 'expense', amount: 10000, occurredAt: at(9), categoryId: 1, accountId: 1,
  reimburseStatus: 'none', deletedAt: 0, createdAt: 1, updatedAt: 1, ...patch,
});
const category = (id: number, name = `虚构分类${id}`) => ({
  id, kind: 'expense' as const, name, icon: '', sortOrder: id, createdAt: 1, updatedAt: 1,
});
beforeEach(async () => {
  await db.delete(); await db.open();
  await setSetting('reimburse.countAsIncome', false);
  await setSetting('accounting.monthStartDay', 1);
  await db.categories.put(category(1));
});

describe('bounded local comparison and trend', () => {
  it('retains monthly shape; comparison adds chronological nonrecursive periods', async () => {
    await db.entries.bulkPut([entry(1, { amount: 30000, occurredAt: at(8) }), entry(2, { amount: 20000 }), entry(3, { amount: 5000, refundFlag: true })]);
    const monthly = await getLifeLedgerReview(question, scope);
    expect(monthly.summary.scope).toEqual(scope); expect(monthly.summary).not.toHaveProperty('analysis');
    expect(monthly.summary.categories).toEqual([{ name: '虚构分类1', expenseFen: 15000, count: 2 }]);
    const review = await getLifeLedgerReview(question, { ...scope, analysis: 'compare' });
    expect(review.summary.scope.analysis).toBe('compare');
    expect(lifeLedgerPeriods(review).map(period => period.scope.month)).toEqual(['2026-08', '2026-09']);
    expect(review.summary.analysis?.change).toEqual({ expenseChangeFen: -15000, expenseChangePercent: -50, reason: 'comparable' });
    expect(lifeLedgerPeriods(review)[1]).toEqual(monthly.summary);
    for (const period of lifeLedgerPeriods(review)) {
      expect(period).not.toHaveProperty('analysis'); expect(period.scope).not.toHaveProperty('analysis');
      expect(period.currency).toBe('CNY'); expect(period.unit).toBe('fen');
    }
    expect(lifeLedgerReviewCount(review)).toBe(3);
    expect(lifeLedgerReviewText(review)).toContain('2026-08'); expect(lifeLedgerReviewText(review)).toContain('-50%');
  });

  it('gets exactly six independently bounded months, including empty months and cross-year', async () => {
    const from = new Date(2025, 9, 1).getTime(), middle = new Date(2026, 2, 1).getTime(), to = new Date(2026, 3, 1).getTime();
    await db.entries.bulkPut([
      entry(1, { amount: 111, occurredAt: from - 1 }), entry(2, { amount: 1000, occurredAt: from }),
      entry(3, { amount: 2000, occurredAt: middle - 1 }), entry(4, { amount: 3000, occurredAt: middle }),
      entry(5, { amount: 4000, occurredAt: to - 1 }), entry(6, { amount: 999, occurredAt: to }),
    ]);
    const review = await getLifeLedgerReview(question, { ...scope, month: '2026-03', analysis: 'trend' });
    const periods = lifeLedgerPeriods(review);
    expect(periods.map(period => period.scope.month)).toEqual(['2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03']);
    expect(periods.map(period => period.totals.expenseFen)).toEqual([1000, 0, 0, 0, 2000, 7000]);
    expect(periods[0].range.from).toBe(from); expect(periods[5].range.to).toBe(to);
    expect(periods.every((period, index) => !index || period.range.from === periods[index - 1].range.to)).toBe(true);
    expect(review.summary.analysis?.change).toEqual({ expenseChangeFen: 6000, expenseChangePercent: 600, reason: 'comparable' });
  });

  it('uses financial boundaries and reimbursedAt events in each separate period', async () => {
    await setSetting('accounting.monthStartDay', 20); await setSetting('reimburse.countAsIncome', true);
    const from = new Date(2026, 7, 20).getTime(), middle = new Date(2026, 8, 20).getTime(), to = new Date(2026, 9, 20).getTime();
    await db.entries.bulkPut([
      entry(1, { amount: 6000, occurredAt: from - 1, reimburseStatus: 'done', reimbursedAmount: 500, reimbursedAt: middle, reimburseAccountId: 1 }),
      entry(2, { amount: 1000, occurredAt: from }), entry(3, { amount: 200, refundFlag: true, occurredAt: middle - 1 }),
      entry(4, { amount: 3000, occurredAt: middle }), entry(5, { type: 'income', amount: 7000, occurredAt: to - 1 }), entry(6, { amount: 999, occurredAt: to }),
    ]);
    const review = await getLifeLedgerReview(question, { ...scope, period: 'accounting', includeIncome: true, analysis: 'compare' });
    expect(lifeLedgerPeriods(review).map(period => period.totals.expenseFen)).toEqual([800, 3000]);
    expect(lifeLedgerPeriods(review).map(period => period.income?.incomeFen)).toEqual([0, 7500]);
    expect(lifeLedgerPeriods(review).map(period => [period.range.from, period.range.to])).toEqual([[from, middle], [middle, to]]);
    expect(lifeLedgerReviewCount(review)).toBe(5);
    expect((await getLifeLedgerEvidence(review, { month: '2026-09', type: 'income' })).items.map(row => [row.id, row.kind])).toEqual([[5, 'entry'], [1, 'reimbursement']]);
  });

  it.each([
    ['empty-baseline', [], [entry(3, { amount: 100 })]],
    ['zero-baseline', [entry(1, { amount: 100, occurredAt: at(8) }), entry(2, { amount: 100, refundFlag: true, occurredAt: at(8) })], [entry(3, { amount: 100 })]],
    ['negative-baseline', [entry(1, { amount: 100, refundFlag: true, occurredAt: at(8) })], [entry(3, { amount: 100 })]],
    ['negative-current', [entry(1, { amount: 100, occurredAt: at(8) })], [entry(3, { amount: 100, refundFlag: true })]],
  ] as const)('suppresses misleading percent for %s', async (reason, previous, current) => {
    await db.entries.bulkPut([...previous, ...current]);
    const review = await getLifeLedgerReview(question, { ...scope, analysis: 'compare' });
    expect(review.summary.analysis?.change.reason).toBe(reason); expect(review.summary.analysis?.change.expenseChangePercent).toBeNull();
    expect(lifeLedgerReviewText(review)).toContain('不计算变化百分比');
  });

  it('rounds positive and negative percentages to two decimals', async () => {
    await db.entries.bulkPut([entry(1, { amount: 3, occurredAt: at(8) }), entry(2, { amount: 4 })]);
    expect((await getLifeLedgerReview(question, { ...scope, analysis: 'compare' })).summary.analysis?.change.expenseChangePercent).toBe(33.33);
    await db.entries.update(2, { amount: 2 });
    expect((await getLifeLedgerReview(question, { ...scope, analysis: 'compare' })).summary.analysis?.change.expenseChangePercent).toBe(-33.33);
  });

  it.each([
    [1, Number.MAX_SAFE_INTEGER - 1],
    [10000, 9007199254740001],
    [10000, 8000000000010012],
    [10000, 8000000000010062],
  ])('suppresses a percentage that cannot retain exact rounded decimals (%s → %s)', async (baseline, current) => {
    await db.entries.bulkPut([entry(1, { amount: baseline, occurredAt: at(8) }), entry(2, { amount: current })]);
    const review = await getLifeLedgerReview(question, { ...scope, analysis: 'compare' });
    expect(review.summary.analysis?.change).toEqual({ expenseChangeFen: current - baseline, expenseChangePercent: null, reason: 'unsafe-percentage' });
    expect(lifeLedgerReviewText(review)).toContain('不计算变化百分比');
  });
  it('retains a large percentage when its two-decimal representation is exact', async () => {
    await db.entries.bulkPut([entry(1, { amount: 10000, occurredAt: at(8) }), entry(2, { amount: 9007199254740000 })]);
    expect((await getLifeLedgerReview(question, { ...scope, analysis: 'compare' })).summary.analysis?.change).toEqual({
      expenseChangeFen: 9007199254730000, expenseChangePercent: 90071992547300, reason: 'comparable',
    });
  });
  it.each(['0000-09', '0001-09', '0099-09'])('rejects %s rather than silently substituting a 1900s range', async month => {
    await expect(getLifeLedgerReview(question, { ...scope, month })).rejects.toThrow('有效');
  });
  it('retains four-digit early year keys and rejects an analysis crossing the supported year boundary', async () => {
    const review = await getLifeLedgerReview(question, { ...scope, month: '0100-06', analysis: 'trend' });
    expect(lifeLedgerPeriods(review).map(period => period.scope.month)).toEqual(['0100-01', '0100-02', '0100-03', '0100-04', '0100-05', '0100-06']);
    await expect(getLifeLedgerReview(question, { ...scope, month: '0100-01', analysis: 'compare' })).rejects.toThrow('有效');
  });
  it('rejects unsafe delta even with individually safe period totals', async () => {
    await db.entries.bulkPut([entry(1, { amount: Number.MAX_SAFE_INTEGER, refundFlag: true, occurredAt: at(8) }), entry(2, { amount: Number.MAX_SAFE_INTEGER })]);
    await expect(getLifeLedgerReview(question, { ...scope, analysis: 'compare' })).rejects.toThrow('安全范围');
  });
  it.each(['year', 'all', '', null])('rejects invalid analysis %s', async analysis => {
    await expect(getLifeLedgerReview(question, { ...scope, analysis } as LifeLedgerScope)).rejects.toThrow('有效');
  });
  it('suggests explicit modes locally while preserving selected month and income', async () => {
    expect(await suggestLifeLedgerScope('分析我的2026年9月支出', at(10))).toEqual(scope);
    expect(await suggestLifeLedgerScope('对比我2026年9月收支与上个月', at(10))).toEqual({ ...scope, includeIncome: true, analysis: 'compare' });
    expect(await suggestLifeLedgerScope('分析我的近6个月支出', at(9))).toEqual({ ...scope, analysis: 'trend' });
    expect(await suggestLifeLedgerScope('查看我的支出趋势', at(9))).toEqual({ ...scope, analysis: 'trend' });
    expect(isLifeLedgerQuestion('对比我的本月支出与上月')).toBe(true); expect(isLifeLedgerQuestion('看看近6个月支出趋势')).toBe(true);
    expect(isLifeLedgerQuestion('解释支出趋势的概念')).toBe(false);
  });
  it('keeps this month as the comparison endpoint when the question also mentions last month', async () => {
    expect(await suggestLifeLedgerScope('对比我的本月支出与上月', at(9))).toEqual({ ...scope, analysis: 'compare' });
    expect(await suggestLifeLedgerScope('看看我的近6月支出趋势', at(9))).toEqual({ ...scope, analysis: 'trend' });
  });
  it('returns exactly the other two deterministic modes with anchored scopes and questions', async () => {
    for (const analysis of [undefined, 'compare', 'trend'] as const) {
      const review = await getLifeLedgerReview(question, { ...scope, includeIncome: true, ...(analysis ? { analysis } : {}) });
      const options = getLifeLedgerFollowUps(review);
      expect(options).toHaveLength(2); expect(options).toEqual(getLifeLedgerFollowUps(review));
      expect(options.map(option => option.scope.analysis)).toEqual([undefined, 'compare', 'trend'].filter(mode => mode !== analysis));
      expect(options.every(option => option.scope.month === scope.month && option.scope.includeIncome && option.scope.period === 'calendar')).toBe(true);
      expect(options.every(option => option.question.includes('2026-09') && option.question.includes('收支'))).toBe(true);
    }
  });
});

describe('local category shares and evidence integrity', () => {
  it('computes shares without changing monthly JSON, suppressing negatives', async () => {
    await db.categories.put(category(2)); await db.entries.bulkPut([entry(1, { amount: 100 }), entry(2, { amount: 300, categoryId: 2 })]);
    const review = await getLifeLedgerReview(question, scope), serialized = JSON.stringify(review);
    expect(lifeLedgerCategoryShares(review.summary)).toEqual([75, 25]); expect(JSON.stringify(review)).toBe(serialized);
    await db.entries.update(1, { refundFlag: true });
    expect(lifeLedgerCategoryShares((await getLifeLedgerReview(question, scope)).summary)).toEqual([null, null]);
  });
  it('suppresses shares when a negative is hidden inside collapsed other', async () => {
    await db.categories.bulkPut(Array.from({ length: 14 }, (_, i) => category(i + 1)));
    await db.entries.bulkPut(Array.from({ length: 14 }, (_, i) => entry(i + 1, { categoryId: i + 1, amount: i < 12 ? 100 : i === 12 ? 2 : 1, refundFlag: i === 13 })));
    const review = await getLifeLedgerReview(question, scope);
    expect(review.summary.categories.at(-1)?.expenseFen).toBe(1); expect(lifeLedgerCategoryShares(review.summary)).toEqual(Array(13).fill(null));
  });
  it('resolves duplicate names, parent/child identities, unknowns and collapsed other by category index', async () => {
    await db.categories.bulkPut([category(1, '同名'), category(2, '同名'), { ...category(3, '子类'), parentId: 1 }, ...Array.from({ length: 12 }, (_, i) => category(i + 4))]);
    await db.entries.bulkPut([
      entry(1, { amount: 10000, categoryId: 3, note: 'PRIVATE_LOCAL_ONLY' }), entry(2, { amount: 9000, categoryId: 2 }),
      ...Array.from({ length: 12 }, (_, i) => entry(i + 3, { amount: 8000 - i * 100, categoryId: i + 4 })),
      entry(30, { amount: 1, categoryId: 999 }), entry(31, { amount: 2, categoryId: undefined }),
    ]);
    const review = await getLifeLedgerReview(question, scope);
    expect((await getLifeLedgerEvidence(review, { month: scope.month, type: 'expense', categoryIndex: 0 })).items.map(row => row.id)).toEqual([1]);
    expect((await getLifeLedgerEvidence(review, { month: scope.month, type: 'expense', categoryIndex: 1 })).items.map(row => row.id)).toEqual([2]);
    const other = await getLifeLedgerEvidence(review, { month: scope.month, type: 'expense', categoryIndex: 12 });
    expect(other.items.map(row => row.id)).toEqual([31, 30, 14, 13]); expect(other.label).toContain('其他分类（合并）'); expect(other.summary).toEqual(review.summary);
    expect((await getLifeLedgerEvidence(review, { month: scope.month, type: 'expense' })).items).toHaveLength(16);
    for (const token of ['PRIVATE_LOCAL_ONLY', 'accountId', 'categoryId', 'occurredAt', 'items', 'fingerprint']) expect(JSON.stringify(review)).not.toContain(token);
  });
  it.each(['same-net-amounts', 'identity', 'timestamp', 'category', 'note', 'child-label'] as const)('rejects stale %s changes even with identical totals', async change => {
    await db.categories.put({ ...category(2, '旧子分类'), parentId: 1 });
    await db.entries.bulkPut([entry(1, { amount: 100, categoryId: 2 }), entry(2, { amount: 200, categoryId: 2 })]);
    const review = await getLifeLedgerReview(question, scope), grant = approveLifeLedgerReview(review, destination);
    if (change === 'same-net-amounts') { await db.entries.update(1, { amount: 120 }); await db.entries.update(2, { amount: 180 }); }
    if (change === 'identity') { await db.entries.delete(1); await db.entries.put(entry(3, { amount: 100, categoryId: 2 })); }
    if (change === 'timestamp') await db.entries.update(1, { occurredAt: at(9, 11) });
    if (change === 'category') await db.entries.update(1, { categoryId: 1 });
    if (change === 'note') await db.entries.update(1, { note: '更改的本机证据备注' });
    if (change === 'child-label') await db.categories.update(2, { name: '新子分类' });
    expect(await getLifeLedgerReview(question, scope)).toEqual(review);
    await expect(assertLifeLedgerReviewFresh(review)).rejects.toThrow('重新确认');
    await expect(getLifeLedgerEvidence(review, { month: scope.month, type: 'expense' })).rejects.toThrow('重新确认');
    await expect(consumeLifeLedgerGrant(grant, question, destination)).rejects.toThrow('重新确认');
  });
  it('allows out-of-scope edits and transfers; rejects restored reviews and unapproved evidence scope', async () => {
    await db.entries.put(entry(1)); const review = await getLifeLedgerReview(question, scope);
    await db.entries.bulkPut([entry(2, { type: 'income' }), entry(3, { type: 'transfer' }), entry(4, { occurredAt: at(8) })]);
    expect((await getLifeLedgerEvidence(review, { month: scope.month, type: 'expense' })).items.map(row => row.id)).toEqual([1]);
    await expect(getLifeLedgerEvidence(structuredClone(review), { month: scope.month, type: 'expense' })).rejects.toThrow('重新确认');
    for (const selection of [
      { month: '2026-08', type: 'expense' as const }, { month: scope.month, type: 'income' as const },
      { month: scope.month, type: 'expense' as const, categoryIndex: -1 }, { month: scope.month, type: 'expense' as const, categoryIndex: 1 },
    ]) await expect(getLifeLedgerEvidence(review, selection)).rejects.toThrow('范围');
  });
  it('preserves the grant clone private snapshot without serialized IDs or original-object mutation leaks', async () => {
    await db.entries.put(entry(1)); const review = await getLifeLedgerReview(question, scope), grant = approveLifeLedgerReview(review, destination);
    review.summary.scope.month = '2026-08'; const approved = await consumeLifeLedgerGrant(grant, question, destination);
    expect((await getLifeLedgerEvidence(approved, { month: scope.month, type: 'expense' })).items.map(row => row.id)).toEqual([1]);
    expect(Object.keys(approved)).toEqual(['question', 'summary']);
  });
});
