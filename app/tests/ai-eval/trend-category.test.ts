import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/core/db';
import type { Category, Entry } from '../../src/core/types';
import { secretStore } from '../../src/core/secretStore';
import { getSetting, setSetting } from '../../src/core/repo/settingsRepo';
import { continueLifeChat, type LifeAiInput } from '../../src/core/repo/lifeAiRepo';
import {
  approveLifeLedgerReview, getLifeLedgerEvidence, getLifeLedgerFollowUps, getLifeLedgerReview,
  lifeLedgerCategoryShares, lifeLedgerPeriods, lifeLedgerReviewCount, lifeLedgerReviewText,
  revokeLifeLedgerGrant, type LifeLedgerGrant, type LifeLedgerReview, type LifeLedgerScope,
} from '../../src/core/repo/lifeLedgerContextRepo';
import { categories, FIXED_NOW, fixtureEntries, makeEntry } from './fixture';
import { oracleChange, oracleMonths, oraclePercent, oracleRange, oracleSummary } from './oracle';
import { installOfflineOutbound } from './outbound';

// Every row, destination, key and private sentinel in this file is fictional.
const outbound = installOfflineOutbound(import.meta.url);
const question = '分析我的 2026 年 9 月支出变化';
const baseScope: LifeLedgerScope = { month: '2026-09', period: 'calendar', includeIncome: false };
const destination = { baseUrl: 'https://fictional-trend.invalid/v1', model: 'fictional-trend-eval' };
const endpoint = `${destination.baseUrl}/chat/completions`;
const kinds = ['compare', 'trend'] as const;
const response = () => new Response(JSON.stringify({ choices: [{ message: { content: 'FICTIONAL TRANSPORT RESPONSE; no model-quality claim.' } }] }), { headers: { 'Content-Type': 'application/json' } });
const input = (grant: LifeLedgerGrant, patch: Partial<LifeAiInput> = {}): LifeAiInput => ({ body: '', messages: [{ role: 'user', content: question }], ledgerGrant: grant, expectedDestination: destination, ...patch });
const sortedIds = (rows: { id: number }[]) => rows.map(row => row.id).sort((a, b) => a - b);
const numericSum = (values: number[]) => Number(values.reduce((sum, value) => sum + BigInt(value), 0n));

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(FIXED_NOW);
  await db.delete(); await db.open();
  await db.categories.bulkPut(structuredClone(categories));
  await setSetting('accounting.monthStartDay', 1);
  await setSetting('reimburse.countAsIncome', false);
  await setSetting('ai.baseUrl', destination.baseUrl);
  await setSetting('ai.model', destination.model);
  await setSetting('life.aiEnabled', true);
  await secretStore.set('ai.apiKey', 'fictional-offline-placeholder');
});
afterEach(async () => { await secretStore.remove('ai.apiKey'); vi.useRealTimers(); vi.restoreAllMocks(); });

function checkAggregates(review: LifeLedgerReview, rows: readonly Entry[], cats: readonly Category[], start = 1, asIncome = false): void {
  const { summary } = review;
  const scope = summary.scope;
  const months = oracleMonths(scope.month, scope.analysis === 'compare' ? 2 : scope.analysis === 'trend' ? 6 : 1);
  const expected = months.map(month => oracleSummary(rows, cats, oracleRange(month, start), asIncome ? 'income' : 'offset', scope.includeIncome));
  const actual = scope.analysis ? summary.analysis!.periods : [summary];
  expect(actual.map(period => period.scope.month)).toEqual(months);
  for (const [index, month] of months.entries()) {
    const period = actual[index];
    expect(period).not.toHaveProperty('analysis');
    expect(period.scope).toEqual({ month, period: scope.period, includeIncome: scope.includeIncome });
    expect(period.range).toMatchObject(oracleRange(month, start));
    expect(period).toMatchObject(expected[index]);
    expect(period.currency).toBe('CNY'); expect(period.unit).toBe('fen');
    expect(period.reimbursementMode).toBe(asIncome ? 'income' : 'offset');
    if (!scope.includeIncome) expect(period).not.toHaveProperty('income');
    expect(numericSum(period.categories.map(category => category.expenseFen))).toBe(period.totals.expenseFen);
    expect(numericSum(period.categories.map(category => category.count))).toBe(period.totals.expenseCount + period.totals.refundCount);
  }
  if (scope.analysis) {
    expect(summary.analysis!.kind).toBe(scope.analysis);
    expect(summary.analysis!.change).toEqual(oracleChange(expected[0], expected.at(-1)!));
    expect(summary).toMatchObject(expected.at(-1)!);
  }
  expect(lifeLedgerPeriods(review)).toEqual(actual);
  const count = expected.reduce((sum, item) => sum + item.totals.expenseCount + item.totals.refundCount + (item.income?.count ?? 0), 0);
  expect(lifeLedgerReviewCount(review)).toBe(count);
  expect(outbound.requests).toHaveLength(0);
}

/** Verify no attempted writes, including transient create/delete, as well as final equality. */
async function readOnly<T>(operation: () => Promise<T>): Promise<T> {
  const before = await Promise.all(db.tables.map(table => table.toArray()));
  const attempted: string[] = [];
  const hooks = db.tables.map(table => {
    const creating = () => { attempted.push(`${table.name}:creating`); };
    const updating = () => { attempted.push(`${table.name}:updating`); };
    const deleting = () => { attempted.push(`${table.name}:deleting`); };
    table.hook('creating', creating); table.hook('updating', updating); table.hook('deleting', deleting);
    return { table, creating, updating, deleting };
  });
  try { return await operation(); }
  finally {
    for (const { table, creating, updating, deleting } of hooks) {
      table.hook('creating').unsubscribe(creating); table.hook('updating').unsubscribe(updating); table.hook('deleting').unsubscribe(deleting);
    }
    expect(attempted).toEqual([]);
    expect(await Promise.all(db.tables.map(table => table.toArray()))).toEqual(before);
  }
}

describe('verified analysis independent monthly aggregates', () => {
  const cases = kinds.flatMap(analysis => [false, true].flatMap(includeIncome => [false, true].flatMap(asIncome => [1, 20].map(start => ({ analysis, includeIncome, asIncome, start })))));
  it.each(cases)('$analysis income=$includeIncome reimbursementIncome=$asIncome fiscalStart=$start has exact chronology, counts and cents', async ({ analysis, includeIncome, asIncome, start }) => {
    await db.entries.bulkPut(structuredClone(fixtureEntries));
    await setSetting('reimburse.countAsIncome', asIncome); await setSetting('accounting.monthStartDay', start);
    const scope: LifeLedgerScope = { ...baseScope, analysis, includeIncome, period: start === 1 ? 'calendar' : 'accounting' };
    await readOnly(async () => {
      const review = await getLifeLedgerReview(question, scope);
      expect(review.summary.scope).toEqual(scope);
      checkAggregates(review, fixtureEntries, categories, start, asIncome);
    });
  });

  it('omitted analysis preserves the original monthly summary shape and does not widen its data scope', async () => {
    await db.entries.bulkPut(structuredClone(fixtureEntries));
    const review = await getLifeLedgerReview(question, baseScope);
    expect(review.summary).not.toHaveProperty('analysis');
    expect(review.summary.scope).toEqual(baseScope);
    checkAggregates(review, fixtureEntries, categories);
    expect(JSON.stringify(review)).not.toContain('2026-08');
  });

  it.each(['monthly', 'year', 'all', '', 6, null])('rejects invalid explicit analysis %s rather than silently widening/reinterpreting it', async analysis => {
    await expect(getLifeLedgerReview(question, { ...baseScope, analysis } as unknown as LifeLedgerScope)).rejects.toThrow();
    expect(outbound.requests).toHaveLength(0);
  });

  it('trend changes compare the first and last periods, not the prior period or sum', async () => {
    const amounts = [20000, 90000, 10, 33333, 70000, 30000];
    const rows = oracleMonths('2026-09', 6).map((month, i) => makeEntry(i + 1, { amount: amounts[i], occurredAt: oracleRange(month).from }));
    await db.entries.bulkPut(rows);
    const review = await getLifeLedgerReview(question, { ...baseScope, analysis: 'trend' });
    checkAggregates(review, rows, categories);
    expect(review.summary.analysis!.change).toEqual({ expenseChangeFen: 10000, expenseChangePercent: 50, reason: 'comparable' });
  });
});

describe('verified analysis half-open calendar and accounting boundaries', () => {
  const cases = ['2024-03', '2026-01', '2026-03', '2026-11', '2026-12'].flatMap(month => [1, 20, 28].flatMap(start => kinds.map(analysis => ({ month, start, analysis }))));
  it.each(cases)('$analysis ending $month fiscalStart=$start isolates every month across leap/year/DST boundaries', async ({ month, start, analysis }) => {
    const months = oracleMonths(month, analysis === 'compare' ? 2 : 6);
    let id = 0;
    const rows = months.flatMap((key, index) => {
      const range = oracleRange(key, start);
      return [
        makeEntry(++id, { occurredAt: range.from, amount: 10001 + index, categoryId: 2 }),
        makeEntry(++id, { occurredAt: range.from - 1, amount: 203 + index, categoryId: 3 }),
        makeEntry(++id, { occurredAt: range.to - 1, amount: 31 + index, refundFlag: true, categoryId: 6 }),
        makeEntry(++id, { occurredAt: range.to, amount: 401 + index, categoryId: 5 }),
        makeEntry(++id, { occurredAt: range.from, type: 'income', amount: 502 + index }),
        makeEntry(++id, { occurredAt: range.from - 10000, amount: 601 + index, reimburseStatus: 'done', reimbursedAmount: 71 + index, reimbursedAt: range.to - 1, reimburseAccountId: 1 }),
        makeEntry(++id, { occurredAt: range.from, amount: 900001, type: 'loan', loanKind: 'lend', fromAccountId: 1, toAccountId: 2 }),
        makeEntry(++id, { occurredAt: range.to - 1, amount: 900002, type: 'transfer', fromAccountId: 1, toAccountId: 2 }),
        makeEntry(++id, { occurredAt: range.from, amount: 900003, deletedAt: 1 }),
      ];
    });
    await db.entries.bulkPut(rows); await setSetting('accounting.monthStartDay', start); await setSetting('reimburse.countAsIncome', true);
    const review = await getLifeLedgerReview(question, { month, period: 'accounting', includeIncome: true, analysis });
    expect(review.summary.scope).toEqual({ month, period: 'accounting', includeIncome: true, analysis });
    checkAggregates(review, rows, categories, start, true);
    const periods = review.summary.analysis!.periods;
    for (let index = 0; index < periods.length; index++) {
      const period = periods[index];
      expect(new Date(period.range.from).getDate()).toBe(start);
      expect(new Date(period.range.from).getHours()).toBe(0);
      expect(new Date(period.range.to).getHours()).toBe(0);
      if (index) expect(period.range.from).toBe(periods[index - 1].range.to);
    }
    if (process.env.TZ === 'America/New_York' && start === 1 && ['2026-03', '2026-11'].includes(month)) {
      const range = periods.at(-1)!.range;
      expect((range.to - range.from) / 3600000).toBe(month.endsWith('03') ? 743 : 721);
    }
  });
});

describe('verified analysis percentage reasons and exact independent rounding', () => {
  const cases = [
    { name: 'empty baseline', before: [], after: [100], reason: 'empty-baseline', percent: null },
    { name: 'empty baseline before negative current', before: [], after: [-100], reason: 'empty-baseline', percent: null },
    { name: 'zero baseline with real transactions', before: [100, -100], after: [100], reason: 'zero-baseline', percent: null },
    { name: 'zero baseline before negative current', before: [100, -100], after: [-100], reason: 'zero-baseline', percent: null },
    { name: 'negative baseline', before: [-100], after: [200], reason: 'negative-baseline', percent: null },
    { name: 'negative baseline and current', before: [-100], after: [-50], reason: 'negative-baseline', percent: null },
    { name: 'negative current', before: [100], after: [-200], reason: 'negative-current', percent: null },
    { name: 'empty current means full decrease', before: [100], after: [], reason: 'comparable', percent: -100 },
    { name: 'increase one third', before: [3], after: [4], reason: 'comparable', percent: 33.33 },
    { name: 'decrease one third', before: [3], after: [2], reason: 'comparable', percent: -33.33 },
    { name: 'positive exact half tie', before: [20000], after: [20001], reason: 'comparable', percent: 0.01 },
    { name: 'negative exact half tie', before: [20000], after: [19999], reason: 'comparable', percent: -0.01 },
    { name: 'unchanged cents', before: [33333], after: [33333], reason: 'comparable', percent: 0 },
  ].flatMap(test => kinds.map(analysis => ({ ...test, analysis })));
  it.each(cases)('$analysis $name has an explicit reason and never fabricates a percent', async ({ analysis, before, after, reason, percent }) => {
    const months = oracleMonths(baseScope.month, analysis === 'compare' ? 2 : 6);
    const signed = (amount: number, occurredAt: number, index: number) => makeEntry(index, { amount: Math.abs(amount), refundFlag: amount < 0, occurredAt });
    const rows = [...before.map((amount, i) => signed(amount, oracleRange(months[0]).from, i + 1)), ...after.map((amount, i) => signed(amount, oracleRange(months.at(-1)!).from, i + 101))];
    await db.entries.bulkPut(rows);
    const review = await getLifeLedgerReview(question, { ...baseScope, analysis });
    checkAggregates(review, rows, categories);
    const change = review.summary.analysis!.change;
    expect(change.reason).toBe(reason); expect(change.expenseChangePercent).toBe(percent);
    expect(change.expenseChangeFen).toBe(numericSum(after) - numericSum(before));
    expect(JSON.stringify(change)).not.toMatch(/NaN|Infinity/);
  });

  it.each(['income', 'loan', 'transfer'] as const)('%s-only baseline remains empty for expense change even when income is authorized', async type => {
    const rows = [makeEntry(1, { type, amount: 100, occurredAt: oracleRange('2026-08').from, fromAccountId: 1, toAccountId: 2 }), makeEntry(2, { amount: 100 })];
    await db.entries.bulkPut(rows);
    const review = await getLifeLedgerReview(question, { ...baseScope, includeIncome: true, analysis: 'compare' });
    checkAggregates(review, rows, categories);
    expect(review.summary.analysis!.change.reason).toBe('empty-baseline');
  });

  it('rejects unsafe signed difference even when each monthly amount is safe', async () => {
    await db.entries.bulkPut([makeEntry(1, { amount: Number.MAX_SAFE_INTEGER, occurredAt: oracleRange('2026-08').from, refundFlag: true }), makeEntry(2, { amount: 1 })]);
    await expect(getLifeLedgerReview(question, { ...baseScope, analysis: 'compare' })).rejects.toThrow('安全范围');
    expect(outbound.requests).toHaveLength(0);
  });

  it.each([0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])('rejects unsafe amount %s in an earlier trend period before any model request', async amount => {
    await db.entries.put(makeEntry(1, { amount, occurredAt: oracleRange('2026-04').from }));
    await expect(getLifeLedgerReview(question, { ...baseScope, analysis: 'trend' })).rejects.toThrow('安全范围');
    expect(outbound.requests).toHaveLength(0);
  });

  it('retains a safe monetary change but suppresses a percentage whose two decimals cannot be exact', async () => {
    const rows = [makeEntry(1, { amount: 1, occurredAt: oracleRange('2026-08').from }), makeEntry(2, { amount: Number.MAX_SAFE_INTEGER })];
    await db.entries.bulkPut(rows);
    const review = await getLifeLedgerReview(question, { ...baseScope, analysis: 'compare' });
    const change = review.summary.analysis!.change;
    expect(change.expenseChangeFen).toBe(Number.MAX_SAFE_INTEGER - 1);
    expect(change.expenseChangePercent).toBeNull();
    expect(change.reason).toBe('unsafe-percentage');
    checkAggregates(review, rows, categories);
  });
});

describe('verified category evidence stays local and conserves independent rows', () => {
  it.each([undefined, ...kinds].flatMap(analysis => [false, true].map(asIncome => ({ analysis, asIncome }))))('mode=$analysis reimbursementIncome=$asIncome returns every authorized period with independent expense/income evidence', async ({ analysis, asIncome }) => {
    const selected = { ...baseScope, month: '2026-10', includeIncome: true, ...(analysis ? { analysis } : {}) };
    await db.entries.bulkPut(structuredClone(fixtureEntries)); await setSetting('reimburse.countAsIncome', asIncome);
    await readOnly(async () => {
      const review = await getLifeLedgerReview(question, selected);
      for (const month of oracleMonths(selected.month, analysis === 'trend' ? 6 : analysis === 'compare' ? 2 : 1)) {
        const range = oracleRange(month);
        const expected = oracleSummary(fixtureEntries, categories, range, asIncome ? 'income' : 'offset', true);
        const expenseRows = fixtureEntries.filter(row => row.deletedAt === 0 && row.type === 'expense' && row.occurredAt >= range.from && row.occurredAt < range.to);
        const expenses = await getLifeLedgerEvidence(review, { month, type: 'expense' });
        expect(sortedIds(expenses.items)).toEqual(sortedIds(expenseRows));
        expect(expenses.summary).toMatchObject(expected);
        expect(expenses.label).toContain(month);
        expect(expenses.items).toHaveLength(expected.totals.expenseCount + expected.totals.refundCount);
        const incomeRows = fixtureEntries.flatMap(row => {
          if (row.deletedAt !== 0) return [];
          if (row.type === 'income' && row.occurredAt >= range.from && row.occurredAt < range.to) return [{ id: row.id, kind: 'entry', amount: row.amount, occurredAt: row.occurredAt }];
          if (asIncome && row.type === 'expense' && row.reimburseStatus === 'done' && row.reimbursedAmount && row.reimbursedAt! >= range.from && row.reimbursedAt! < range.to) {
            return [{ id: row.id, kind: 'reimbursement', amount: row.reimbursedAmount, occurredAt: row.reimbursedAt! }];
          }
          return [];
        });
        const income = await getLifeLedgerEvidence(review, { month, type: 'income' });
        expect(income.items.map(({ id, kind, amount, occurredAt }) => ({ id, kind, amount, occurredAt })).sort((a, b) => a.id - b.id)).toEqual(incomeRows.sort((a, b) => a.id - b.id));
        expect(numericSum(income.items.map(row => row.amount))).toBe(expected.income!.incomeFen);
        expect(income.items).toHaveLength(expected.income!.count);
        expect(income.summary).toMatchObject(expected);
      }
    });
    expect(outbound.requests).toHaveLength(0);
  });

  it('duplicate display names, parent/child categories and unknown IDs resolve to the correct local rows', async () => {
    const extra: Category[] = [
      { id: 7, name: '餐饮', kind: 'expense', icon: '', sortOrder: 7, createdAt: 1, updatedAt: 1 },
      { id: 8, name: '同'.repeat(80) + '甲', kind: 'expense', icon: '', sortOrder: 8, createdAt: 1, updatedAt: 1 },
      { id: 9, name: '同'.repeat(80) + '乙', kind: 'expense', icon: '', sortOrder: 9, createdAt: 1, updatedAt: 1 },
    ];
    const rows = [makeEntry(1, { categoryId: 2, amount: 101 }), makeEntry(2, { categoryId: 3, amount: 202 }),
      makeEntry(3, { categoryId: 7, amount: 404 }), makeEntry(4, { categoryId: 999, amount: 505 }), makeEntry(5, { amount: 606 }),
      makeEntry(6, { categoryId: 8, amount: 707 }), makeEntry(7, { categoryId: 9, amount: 808 })];
    await db.categories.bulkPut(extra); await db.entries.bulkPut(rows);
    const review = await getLifeLedgerReview(question, { ...baseScope, analysis: 'compare' });
    const expectedGroups = new Map([[303, [1, 2]], [404, [3]], [1111, [4, 5]], [707, [6]], [808, [7]]]);
    expect(review.summary.categories.filter(row => row.name === '餐饮')).toHaveLength(2);
    expect(review.summary.categories.filter(row => row.name === '同'.repeat(80))).toHaveLength(2);
    for (const [categoryIndex, category] of review.summary.categories.entries()) {
      const evidence = await getLifeLedgerEvidence(review, { month: baseScope.month, type: 'expense', categoryIndex });
      expect(sortedIds(evidence.items)).toEqual(expectedGroups.get(category.expenseFen));
      expect(evidence.items).toHaveLength(category.count);
      expect(evidence.summary.totals).toEqual(review.summary.totals);
      expect(evidence.label).toContain(category.name);
    }
    expect(outbound.requests).toHaveLength(0);
  });

  it('merged other-category evidence includes exactly the undisplayed groups and preserves all counts/cents', async () => {
    const cats: Category[] = Array.from({ length: 17 }, (_, index) => ({ id: index + 20, name: `虚构分类${index}`, kind: 'expense', icon: '', sortOrder: index, createdAt: 1, updatedAt: 1 }));
    const rows = cats.map((category, index) => makeEntry(index + 1, { categoryId: category.id, amount: (index + 1) * 101 }));
    await db.categories.bulkPut(cats); await db.entries.bulkPut(rows);
    const review = await getLifeLedgerReview(question, { ...baseScope, analysis: 'trend' });
    checkAggregates(review, rows, cats);
    expect(review.summary.categories).toHaveLength(13);
    const evidence = await getLifeLedgerEvidence(review, { month: baseScope.month, type: 'expense', categoryIndex: 12 });
    expect(sortedIds(evidence.items)).toEqual([1, 2, 3, 4, 5]);
    expect(review.summary.categories[12]).toEqual({ name: '其他分类（合并）', expenseFen: 1515, count: 5 });
    expect(numericSum(evidence.items.map(row => row.amount))).toBe(1515);
  });

  it('positive shares use the independent 2dp oracle without forcing rounded percentages to total 100', async () => {
    const rows = [makeEntry(1, { amount: 1, categoryId: 1 }), makeEntry(2, { amount: 1, categoryId: 4 }), makeEntry(3, { amount: 1, categoryId: 6 })];
    await db.entries.bulkPut(rows);
    const { summary } = await getLifeLedgerReview(question, { ...baseScope, analysis: 'trend' });
    const expected = oracleSummary(rows, categories, oracleRange(baseScope.month), 'offset', false);
    expect(lifeLedgerCategoryShares(summary)).toEqual(expected.categories.map(category => oraclePercent(category.expenseFen, expected.totals.expenseFen)));
    expect(lifeLedgerCategoryShares(summary)).toEqual([33.33, 33.33, 33.33]);
    expect(lifeLedgerCategoryShares(structuredClone(summary))).toEqual([null, null, null]);
  });

  it.each(['negative category', 'zero total', 'negative total'] as const)('%s suppresses misleading category percentages', async kind => {
    const rows = [makeEntry(1, { amount: kind === 'negative category' ? 100 : kind === 'zero total' ? 30 : 20, categoryId: 1 }), makeEntry(2, { amount: 30, refundFlag: true, categoryId: 4 })];
    await db.entries.bulkPut(rows);
    const { summary } = await getLifeLedgerReview(question, { ...baseScope, analysis: 'compare' });
    expect(lifeLedgerCategoryShares(summary)).toEqual(summary.categories.map(() => null));
  });

  it('negative categories hidden by a positive merged group still suppress every percentage', async () => {
    const cats: Category[] = Array.from({ length: 14 }, (_, index) => ({ id: 20 + index, name: `负分类边界${index}`, kind: 'expense', icon: '', sortOrder: index, createdAt: 1, updatedAt: 1 }));
    const rows = cats.map((category, index) => makeEntry(index + 1, { categoryId: category.id, amount: index < 12 ? 1000 + index : index === 12 ? 7 : 3, refundFlag: index === 13 }));
    await db.categories.bulkPut(cats); await db.entries.bulkPut(rows);
    const { summary } = await getLifeLedgerReview(question, { ...baseScope, analysis: 'trend' });
    expect(summary.categories.every(category => category.expenseFen > 0)).toBe(true);
    expect(summary.categories.at(-1)).toEqual({ name: '其他分类（合并）', expenseFen: 4, count: 2 });
    expect(lifeLedgerCategoryShares(summary)).toEqual(Array(13).fill(null));
  });

  it.each([
    { month: '2026-03', type: 'expense' }, { month: '2026-10', type: 'expense' },
    { month: '2026-09', type: 'income' }, { month: '2026-09', type: 'loan' },
    { month: '2026-09', type: 'expense', categoryIndex: -1 }, { month: '2026-09', type: 'expense', categoryIndex: 0.5 },
    { month: '2026-09', type: 'expense', categoryIndex: 999 },
  ] as const)('evidence refuses unauthorized month/type/category: $month $type $categoryIndex', async selection => {
    await db.entries.bulkPut(structuredClone(fixtureEntries));
    const review = await getLifeLedgerReview(question, { ...baseScope, analysis: 'trend' });
    await expect(getLifeLedgerEvidence(review, selection as Parameters<typeof getLifeLedgerEvidence>[1])).rejects.toThrow();
    expect(outbound.requests).toHaveLength(0);
  });

  it('income evidence rejects a category selector even with income explicitly included', async () => {
    await db.entries.bulkPut(structuredClone(fixtureEntries));
    const review = await getLifeLedgerReview(question, { ...baseScope, analysis: 'compare', includeIncome: true });
    await expect(getLifeLedgerEvidence(review, { month: baseScope.month, type: 'income', categoryIndex: 0 })).rejects.toThrow();
  });

  it.each(['entry note', 'same-amount replacement', 'category parent', 'deleted earlier month'] as const)('stale %s evidence is rejected even if a new summary could have the same total', async kind => {
    await db.entries.bulkPut(structuredClone(fixtureEntries));
    const review = await getLifeLedgerReview(question, { ...baseScope, analysis: 'trend' });
    if (kind === 'entry note') await db.entries.update(2, { note: 'FICTIONAL_CHANGED_LOCAL_NOTE' });
    if (kind === 'same-amount replacement') { const row = await db.entries.get(2); await db.entries.delete(2); await db.entries.put({ ...row!, id: 222 }); }
    if (kind === 'category parent') await db.categories.update(2, { parentId: 4 });
    if (kind === 'deleted earlier month') await db.entries.update(18, { deletedAt: 1 });
    await expect(getLifeLedgerEvidence(review, { month: baseScope.month, type: 'expense' })).rejects.toThrow('重新确认');
    expect(outbound.requests).toHaveLength(0);
  });

  it('serialized or cloned review cannot regain evidence access; mutating returned local rows cannot alter the DB', async () => {
    await db.entries.bulkPut(structuredClone(fixtureEntries));
    const review = await getLifeLedgerReview(question, { ...baseScope, analysis: 'compare' });
    await expect(getLifeLedgerEvidence(structuredClone(review), { month: baseScope.month, type: 'expense' })).rejects.toThrow('重新确认');
    await readOnly(async () => {
      const evidence = await getLifeLedgerEvidence(review, { month: baseScope.month, type: 'expense' });
      evidence.items[0].amount = 777;
      const again = await getLifeLedgerEvidence(review, { month: baseScope.month, type: 'expense' });
      expect(again.items.some(row => row.amount === 777)).toBe(false);
    });
  });
});

describe('verified deterministic follow-up choices never inherit authority', () => {
  const cases = [undefined, ...kinds].flatMap(analysis => [false, true].flatMap(includeIncome =>
    (['calendar', 'accounting'] as const).map(period => ({ analysis, includeIncome, period }))));
  it.each(cases)('mode=$analysis period=$period income=$includeIncome returns exactly the other modes with the same explicit scope', async ({ analysis, includeIncome, period }) => {
    const scope = { ...baseScope, month: '2024-01', period, includeIncome, ...(analysis ? { analysis } : {}) };
    const review = await getLifeLedgerReview(question, scope);
    const before = JSON.stringify(review);
    const result = getLifeLedgerFollowUps(review);
    expect(result).toHaveLength(2);
    expect(result).toEqual(getLifeLedgerFollowUps(review));
    expect(result.map(option => option.scope.analysis)).toEqual([undefined, ...kinds].filter(mode => mode !== analysis));
    for (const option of result) {
      expect(option.scope).toMatchObject({ month: scope.month, period, includeIncome });
      expect(option.question).toContain(scope.month);
      expect(option.question).toContain(period === 'calendar' ? '自然月' : '财务月');
      expect(option.question).toContain(includeIncome ? '收支' : '支出');
      expect(option.label.length).toBeGreaterThan(0);
      expect(option).not.toHaveProperty('grant');
      expect(option).not.toHaveProperty('ledgerGrant');
    }
    result[0].scope.month = '2099-12';
    expect(JSON.stringify(review)).toBe(before);
    expect(getLifeLedgerFollowUps(review)[0].scope.month).toBe(scope.month);
    expect(outbound.requests).toHaveLength(0);
  });
});

describe('verified expanded-scope consent and outbound privacy', () => {
  const privateNote = 'FICTIONAL_PRIVATE_TREND_NOTE_H7';
  const privateHistory = 'FICTIONAL_PRIVATE_TREND_HISTORY_H8';
  const privateOutside = 761234567;
  const forbiddenKeys = ['id', 'accountId', 'fromAccountId', 'toAccountId', 'categoryId', 'categoryIds', 'merchantId', 'refundOfEntryId', 'reimburseAccountId', 'note', 'items', 'entryIds', 'fingerprint', 'photoRefs', 'ledgerGrant'];
  const sentReview = () => {
    expect(outbound.requests).toHaveLength(1);
    const payload = JSON.parse(String(outbound.requests[0].init.body)) as { model: string; messages: { role: string; content: string }[] };
    expect(payload.model).toBe(destination.model);
    expect(payload.messages.map(message => message.role)).toEqual(['system', 'user']);
    return JSON.parse(payload.messages[1].content) as LifeLedgerReview;
  };
  async function seedPrivate() {
    await db.entries.bulkPut([...structuredClone(fixtureEntries), makeEntry(100, { amount: privateOutside, occurredAt: oracleRange('2026-03').from, note: 'FICTIONAL_PRIVATE_OUTSIDE_PERIOD' })]);
    await db.entries.update(2, { note: privateNote });
  }

  it.each(kinds)('%s preview equals actual aggregate-only outbound; local IDs/notes/history never leave', async analysis => {
    await seedPrivate();
    const review = await getLifeLedgerReview(question, { ...baseScope, analysis });
    const preview = lifeLedgerReviewText(review);
    const expectedMonths = oracleMonths(baseScope.month, analysis === 'compare' ? 2 : 6);
    for (const month of expectedMonths) expect(preview).toContain(`范围：${month}`);
    expect(preview.match(/范围：/g)).toHaveLength(expectedMonths.length);
    const serialized = JSON.stringify(review);
    for (const token of [privateNote, privateHistory, String(privateOutside)]) expect(serialized).not.toContain(token);
    for (const key of forbiddenKeys) expect(serialized).not.toContain(`"${key}"`);
    await getLifeLedgerEvidence(review, { month: baseScope.month, type: 'expense', categoryIndex: 0 });
    expect(JSON.stringify(review)).toBe(serialized);
    const grant = approveLifeLedgerReview(review, destination);
    expect(JSON.stringify(grant)).toBe('{"kind":"life-ledger-once"}');
    outbound.respondWith(endpoint, () => response());
    await readOnly(() => continueLifeChat(input(grant, { messages: [{ role: 'assistant', content: privateHistory }, { role: 'user', content: question }] })));
    expect(sentReview()).toEqual(review);
    const actualBody = String(outbound.requests[0].init.body);
    for (const token of [privateNote, privateHistory, String(privateOutside)]) expect(actualBody).not.toContain(token);
    for (const period of sentReview().summary.analysis!.periods) expect(period).not.toHaveProperty('income');
    await expect(continueLifeChat(input(grant))).rejects.toThrow('重新确认');
    expect(outbound.requests).toHaveLength(1);
  });

  it.each(['analysis mode', 'selected month', 'period order', 'period total', 'change amount', 'include income'] as const)('a preview tampered before approval in %s cannot acquire expanded authority', async field => {
    await seedPrivate();
    const review = await getLifeLedgerReview(question, { ...baseScope, analysis: 'compare' });
    if (field === 'analysis mode') review.summary.scope.analysis = 'trend';
    if (field === 'selected month') review.summary.scope.month = '2026-08';
    if (field === 'period order') review.summary.analysis!.periods.reverse();
    if (field === 'period total') review.summary.analysis!.periods[0].totals.expenseFen++;
    if (field === 'change amount') review.summary.analysis!.change.expenseChangeFen++;
    if (field === 'include income') review.summary.scope.includeIncome = true;
    const grant = approveLifeLedgerReview(review, destination);
    await expect(continueLifeChat(input(grant))).rejects.toThrow('重新确认');
    await expect(continueLifeChat(input(grant))).rejects.toThrow('重新确认');
    expect(outbound.requests).toHaveLength(0);
  });

  it('post-approval mutation cannot broaden the immutable approved analysis', async () => {
    await seedPrivate();
    const review = await getLifeLedgerReview(question, { ...baseScope, analysis: 'compare' });
    const approved = structuredClone(review), selectedDestination = { ...destination };
    const grant = approveLifeLedgerReview(review, selectedDestination);
    review.summary.scope.analysis = 'trend'; review.summary.scope.includeIncome = true;
    review.summary.analysis!.periods[0].scope.month = '2026-03';
    review.summary.analysis!.change.expenseChangeFen = 123456789;
    selectedDestination.baseUrl = 'https://fictional-other.invalid/v1';
    outbound.respondWith(endpoint, () => response());
    await continueLifeChat(input(grant));
    expect(sentReview()).toEqual(approved);
  });

  it.each(['question', 'provider', 'model'] as const)('a trend grant binds %s and cannot be retried with the original value', async field => {
    const grant = approveLifeLedgerReview(await getLifeLedgerReview(question, { ...baseScope, analysis: 'trend' }), destination);
    const changed: Partial<LifeAiInput> = field === 'question' ? { messages: [{ role: 'user', content: '分析我的 2026 年 9 月收入' }] }
      : { expectedDestination: field === 'provider' ? { ...destination, baseUrl: 'https://fictional-other.invalid/v1' } : { ...destination, model: 'fictional-other-model' } };
    await expect(continueLifeChat(input(grant, changed))).rejects.toThrow('重新确认');
    await expect(continueLifeChat(input(grant))).rejects.toThrow('重新确认');
    expect(outbound.requests).toHaveLength(0);
  });

  it.each(['baseline amount', 'baseline note', 'reimbursement mode', 'fiscal start'] as const)('changing %s after approval invalidates all periods, including untouched selected-month totals', async field => {
    await seedPrivate();
    const scope: LifeLedgerScope = { ...baseScope, analysis: 'trend', period: field === 'fiscal start' ? 'accounting' : 'calendar' };
    const grant = approveLifeLedgerReview(await getLifeLedgerReview(question, scope), destination);
    if (field === 'baseline amount') await db.entries.put(makeEntry(201, { amount: 50, occurredAt: oracleRange('2026-04').from }));
    if (field === 'baseline note') await db.entries.update(18, { note: 'FICTIONAL_NOTE_CHANGED_WITH_SAME_CENTS' });
    if (field === 'reimbursement mode') await setSetting('reimburse.countAsIncome', true);
    if (field === 'fiscal start') await setSetting('accounting.monthStartDay', 28);
    await expect(continueLifeChat(input(grant))).rejects.toThrow('重新确认');
    await expect(continueLifeChat(input(grant))).rejects.toThrow('重新确认');
    expect(outbound.requests).toHaveLength(0);
  });

  it('restoring a serialized expanded review cannot grant access to its local source metadata', async () => {
    await seedPrivate();
    const review = await getLifeLedgerReview(question, { ...baseScope, analysis: 'trend' });
    const restored = JSON.parse(JSON.stringify(review)) as LifeLedgerReview;
    const grant = approveLifeLedgerReview(restored, destination);
    await expect(continueLifeChat(input(grant))).rejects.toThrow('重新确认');
    expect(outbound.requests).toHaveLength(0);
  });

  it('cancelling an expanded review and choosing a follow-up never transfers its grant', async () => {
    const review = await getLifeLedgerReview(question, { ...baseScope, analysis: 'trend' });
    const grant = approveLifeLedgerReview(review, destination);
    revokeLifeLedgerGrant(grant);
    const followUp = getLifeLedgerFollowUps(review)[0];
    await getLifeLedgerReview(followUp.question, followUp.scope);
    await expect(continueLifeChat(input(grant))).rejects.toThrow('重新确认');
    expect(outbound.requests).toHaveLength(0);
  });

  it('failed expanded request is one-shot; retry requires a freshly reviewed and approved grant', async () => {
    await seedPrivate();
    const scope: LifeLedgerScope = { ...baseScope, analysis: 'trend' };
    const grant = approveLifeLedgerReview(await getLifeLedgerReview(question, scope), destination);
    outbound.respondWith(endpoint, () => new Response('FICTIONAL_SERVER_ERROR', { status: 503 }));
    await expect(continueLifeChat(input(grant))).rejects.toThrow('不可用');
    await expect(continueLifeChat(input(grant))).rejects.toThrow('重新确认');
    expect(outbound.requests).toHaveLength(1);
    const fresh = approveLifeLedgerReview(await getLifeLedgerReview(question, scope), destination);
    outbound.respondWith(endpoint, () => response());
    await continueLifeChat(input(fresh));
    expect(outbound.requests).toHaveLength(2);
  });

  it('aborting an in-flight trend request drops the late result and cannot reuse its grant', async () => {
    await seedPrivate();
    const grant = approveLifeLedgerReview(await getLifeLedgerReview(question, { ...baseScope, analysis: 'trend' }), destination);
    const controller = new AbortController();
    let started!: () => void, finish!: (result: Response) => void;
    const didStart = new Promise<void>(resolve => { started = resolve; });
    outbound.respondWith(endpoint, () => { started(); return new Promise<Response>(resolve => { finish = resolve; }); });
    const pending = continueLifeChat(input(grant, { signal: controller.signal }));
    const rejected = expect(pending).rejects.toThrow('取消');
    await didStart; controller.abort();
    expect(outbound.requests[0].init.signal?.aborted).toBe(true);
    finish(response()); await rejected;
    await expect(continueLifeChat(input(grant))).rejects.toThrow('重新确认');
    expect(outbound.requests).toHaveLength(1);
  });
});

describe('verified analysis conservative numeric and year limits', () => {
  it.each([
    { current: 9007199254740000, percent: 90071992547300, reason: 'comparable' },
    { current: 9007199254740001, percent: null, reason: 'unsafe-percentage' },
    { current: 8000000000010012, percent: null, reason: 'unsafe-percentage' },
    { current: 8000000000010062, percent: null, reason: 'unsafe-percentage' },
  ])('current=$current preserves exact two-decimal percentage meaning below the scaled integer bound', async ({ current, percent, reason }) => {
    const rows = [makeEntry(1, { amount: 10000, occurredAt: oracleRange('2026-08').from }), makeEntry(2, { amount: current })];
    await db.entries.bulkPut(rows);
    const review = await getLifeLedgerReview(question, { ...baseScope, analysis: 'compare' });
    checkAggregates(review, rows, categories);
    expect(review.summary.analysis!.change).toEqual({ expenseChangeFen: current - 10000, expenseChangePercent: percent, reason });
  });

  it.each([
    { month: '0000-09', analysis: 'compare' }, { month: '0099-09', analysis: 'trend' },
    { month: '0100-01', analysis: 'compare' }, { month: '0100-05', analysis: 'trend' },
  ] as const)('$analysis ending $month rejects legacy Date year remapping and generated out-of-domain periods', async scope => {
    await expect(getLifeLedgerReview(question, { ...baseScope, ...scope })).rejects.toThrow();
    expect(outbound.requests).toHaveLength(0);
  });

  it.each([{ month: '0100-02', analysis: 'compare' }, { month: '0100-06', analysis: 'trend' }] as const)('$analysis ending $month keeps supported early years padded to four digits', async scope => {
    const review = await getLifeLedgerReview(question, { ...baseScope, ...scope });
    checkAggregates(review, [], categories);
    expect(review.summary.analysis!.periods[0].scope.month).toBe('0100-01');
  });

  it.each(kinds)('%s review, evidence and suggestions work locally while AI remains disabled', async analysis => {
    await db.entries.bulkPut(structuredClone(fixtureEntries));
    await setSetting('life.aiEnabled', false);
    await readOnly(async () => {
      const review = await getLifeLedgerReview(question, { ...baseScope, analysis });
      checkAggregates(review, fixtureEntries, categories);
      expect((await getLifeLedgerEvidence(review, { month: baseScope.month, type: 'expense' })).items.length).toBe(6);
      expect(getLifeLedgerFollowUps(review)).toHaveLength(2);
      expect(await getSetting('life.aiEnabled')).toBe(false);
    });
    expect(outbound.requests).toHaveLength(0);
  });
});
