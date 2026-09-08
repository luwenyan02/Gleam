import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, stamp } from '../src/core/db';
import type { Budget, Category, CategoryBudget, Entry } from '../src/core/types';
import { ensureMonthBudget } from '../src/core/repo/budgetRepo';
import { dailyAggregates, monthRange, rangeSummary } from '../src/core/repo/statsRepo';
import { setSetting } from '../src/core/repo/settingsRepo';

const at = (year: number, month: number, day: number, hour = 12): number =>
  new Date(year, month - 1, day, hour, 0, 0, 0).getTime();

async function seedReimbursement(): Promise<void> {
  await db.categories.put(stamp({
    id: 1, name: '虚构餐饮', icon: 'ic-bowl', kind: 'expense', sortOrder: 1,
  }) as Category);
  await db.entries.put(stamp({
    id: 1,
    type: 'expense',
    amount: 10_000,
    occurredAt: at(2026, 8, 3),
    categoryId: 1,
    accountId: 1,
    reimburseStatus: 'done',
    reimbursedAmount: 6_000,
    reimbursedAt: at(2026, 9, 5),
    reimburseAccountId: 1,
    deletedAt: 0,
  }) as Entry);
}

beforeEach(async () => {
  await db.delete();
  await db.open();
});

describe('统计安全回归', () => {
  it('冲抵口径把报销额扣回原支出日', async () => {
    await seedReimbursement();
    await setSetting('reimburse.countAsIncome', false);

    const august = await dailyAggregates('2026-08');

    expect(august.get('2026-08-03')).toEqual({ expense: 4_000, income: 0, count: 1 });
  });

  it('计收入口径按到账日生成跨月收入事件且保留原月全额支出', async () => {
    await seedReimbursement();
    await setSetting('reimburse.countAsIncome', true);

    const august = await dailyAggregates('2026-08');
    const september = await dailyAggregates('2026-09');

    expect(august.get('2026-08-03')).toEqual({ expense: 10_000, income: 0, count: 1 });
    expect(september.get('2026-09-05')).toEqual({ expense: 0, income: 6_000, count: 1 });
  });

  it('只有退款时保留负净支出而不是归零', async () => {
    await db.entries.put(stamp({
      id: 2,
      type: 'expense',
      amount: 5_000,
      occurredAt: at(2026, 9, 8),
      accountId: 1,
      reimburseStatus: 'none',
      refundFlag: true,
      deletedAt: 0,
    }) as Entry);
    const { from, to } = monthRange('2026-09');

    expect(await rangeSummary(from, to)).toEqual({ expense: -5_000, income: 0, balance: 5_000 });
  });
});

describe('预算延续并发安全', () => {
  it('两次首次确保在同一事务内幂等复制预算及子预算', async () => {
    await db.budgets.put(stamp({
      id: 1, month: '2026-08', totalLimit: 100_000, autoRenew: true,
    }) as Budget);
    await db.categoryBudgets.put(stamp({
      id: 1, month: '2026-08', categoryId: 1, limit: 40_000,
    }) as CategoryBudget);

    const results = await Promise.all([
      ensureMonthBudget('2026-09'),
      ensureMonthBudget('2026-09'),
    ]);

    expect(results[0]).toMatchObject({ month: '2026-09', totalLimit: 100_000, autoRenew: true });
    expect(results[1]).toEqual(results[0]);
    expect(await db.budgets.where('month').equals('2026-09').count()).toBe(1);
    expect(await db.categoryBudgets.where('[month+categoryId]').equals(['2026-09', 1]).count()).toBe(1);
  });
});
