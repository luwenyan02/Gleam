import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, stamp } from '../src/core/db';
import type { Entry } from '../src/core/types';
import { setSetting } from '../src/core/repo/settingsRepo';
import { rangeSummary } from '../src/core/repo/statsRepo';
import { getSpendingRhythm, spendingRhythmDays } from '../src/core/repo/spendingRhythmRepo';

const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime();
const now = at(2026, 10, 3);
async function entry(id: number, occurredAt: number, patch: Partial<Entry> = {}) {
  await db.entries.put(stamp({ id, type: 'expense', amount: 1000, occurredAt,
    accountId: 1, reimburseStatus: 'none', deletedAt: 0, ...patch }) as Entry);
}
beforeEach(async () => { await db.delete(); await db.open(); });

describe('最近七个本地自然日消费节奏', () => {
  it('空数据返回七天，不把没有记录说成没有消费', async () => {
    const result = await getSpendingRhythm(now);
    expect(result.days.map(d => d.key)).toEqual(['2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03']);
    expect(result).toMatchObject({ expense: 0, spendingDays: 0, expenseCount: 0 });
    expect(result.days.every(d => d.expense === 0 && d.expenseCount === 0)).toBe(true);
  });
  it('半开边界，补账和导入按发生日期归属，未来自然日不进入', async () => {
    const days = spendingRhythmDays(now);
    await entry(1, days[0].from - 1);
    await entry(2, days[0].from, { createdAt: now });
    await entry(3, days[6].to - 1, { createdAt: at(2026, 10, 9) });
    await entry(4, days[6].to);
    const result = await getSpendingRhythm(now);
    expect(result).toMatchObject({ expense: 2000, spendingDays: 2, expenseCount: 2 });
    expect(result.days[0].expense).toBe(1000);
    expect(result.days[6].expense).toBe(1000);
  });
  it('退款保留负数、整笔冲回不丢记录，收入转账借贷删除项不计支出', async () => {
    await entry(1, at(2026, 9, 28));
    await entry(2, at(2026, 9, 28), { refundFlag: true });
    await entry(3, at(2026, 9, 29), { refundFlag: true, amount: 333 });
    await entry(4, now, { type: 'income', amount: 999999 });
    await entry(5, now, { type: 'transfer', amount: 999999 });
    await entry(6, now, { type: 'loan', amount: 999999 });
    await entry(7, now, { deletedAt: now });
    const result = await getSpendingRhythm(now);
    expect(result).toMatchObject({ expense: -333, spendingDays: 1, expenseCount: 3 });
    expect(result.days[1]).toMatchObject({ expense: 0, expenseCount: 2, spendingCount: 1 });
    expect(result.days[2]).toMatchObject({ expense: -333, expenseCount: 1, spendingCount: 0 });
  });
  it('报销两种口径与同范围报表完全一致，跨范围到账不误增支出天数', async () => {
    await entry(1, at(2026, 9, 28), { reimburseStatus: 'done', reimbursedAmount: 600, reimbursedAt: at(2026, 10, 9), reimburseAccountId: 1 });
    await entry(2, at(2026, 9, 10), { reimburseStatus: 'done', reimbursedAmount: 700, reimbursedAt: now, reimburseAccountId: 1 });
    for (const countAsIncome of [false, true]) {
      await setSetting('reimburse.countAsIncome', countAsIncome);
      const result = await getSpendingRhythm(now);
      expect(result.expense).toBe(countAsIncome ? 1000 : 400);
      expect(result.spendingDays).toBe(1);
      expect(result.expenseCount).toBe(1);
      expect(result.expense).toBe((await rangeSummary(result.from, result.to)).expense);
    }
  });
  it('所有本地午夜连续，跨年和夏令时仍是七个自然日', () => {
    for (const now of [at(2027, 1, 2), at(2026, 3, 10), at(2026, 11, 3)]) {
      const days = spendingRhythmDays(now);
      expect(days).toHaveLength(7);
      expect(new Set(days.map(d => d.key)).size).toBe(7);
      days.forEach((day, index) => {
        expect(new Date(day.from).getHours()).toBe(0);
        expect(new Date(day.to).getHours()).toBe(0);
        if (index) expect(day.from).toBe(days[index - 1].to);
      });
      expect(days[6].key).toBe(`${new Date(now).getFullYear()}-${String(new Date(now).getMonth()+1).padStart(2,'0')}-${String(new Date(now).getDate()).padStart(2,'0')}`);
    }
  });
});

it('日卡下钻的自定义结束日与本地自然日上界一致，夏令时末小时不漏不多', async () => {
  const { nextLocalDayStart } = await import('../src/core/queryValidation');
  for (const now of [at(2026, 3, 8), at(2026, 11, 1)]) {
    const day = spendingRhythmDays(now)[6];
    // openLedgerSearch converts exclusive bounds to the date wheel's inclusive end date.
    const inclusiveEnd = new Date(day.to - 1);
    const midnight = new Date(inclusiveEnd.getFullYear(), inclusiveEnd.getMonth(), inclusiveEnd.getDate()).getTime();
    expect(nextLocalDayStart(midnight)).toBe(day.to);
    expect(nextLocalDayStart(midnight) - 1).toBe(day.to - 1);
  }
});
