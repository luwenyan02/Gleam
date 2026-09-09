import 'fake-indexeddb/auto';
import { beforeEach, expect, it, vi } from 'vitest';
import { db } from '../src/core/db';
import { saveMonthlyBudget, copyPreviousBudget, getBudget, listCategoryBudgets, setAnnualBudget, getAnnualBudget } from '../src/core/repo/budgetRepo';

beforeEach(async () => { await db.delete(); await db.open(); });
it('复制上期同时复制分类，历史查看不会自动创建预算', async () => {
  await saveMonthlyBudget('2025-12', 10000, [{ id: 1, fen: 4000 }], false);
  expect(await getBudget('2026-01')).toBeUndefined();
  await copyPreviousBudget('2026-01');
  expect((await getBudget('2026-01'))?.totalLimit).toBe(10000);
  expect((await listCategoryBudgets('2026-01'))[0].limit).toBe(4000);
});
it('分类写入失败时总预算也回滚', async () => {
  await saveMonthlyBudget('2026-01', 10000, [], false);
  const spy = vi.spyOn(db.categoryBudgets, 'add').mockRejectedValueOnce(new Error('模拟失败'));
  await expect(saveMonthlyBudget('2026-01', 20000, [{ id: 1, fen: 3000 }], false)).rejects.toThrow('模拟失败');
  spy.mockRestore();
  expect((await getBudget('2026-01'))?.totalLimit).toBe(10000);
});
it('年度预算独立保存整数分并拒绝非法额度', async () => {
  await setAnnualBudget(2026, 123456);
  expect(await getAnnualBudget(2026)).toBe(123456);
  await expect(setAnnualBudget(2026, -1)).rejects.toThrow();
  await expect(setAnnualBudget(2026, 1.5)).rejects.toThrow();
});
