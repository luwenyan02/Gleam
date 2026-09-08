/**
 * 拾光 · 预算仓库（budgetRepo）
 * 月总预算 + 分类子预算（按支出大类）。月末不结转；ensureMonthBudget 负责按上月延续。
 * 「已用」口径见 statsRepo.budgetUsage（与首页月度总览严格同源）。
 * 写操作后 emit 'budgets-changed'。
 */
import { db, now, stamp } from '../db';
import { emit } from '../store';
import type { Budget, CategoryBudget } from '../types';
import { getSetting } from './settingsRepo';

/** 读取某月总预算，未设置时返回 undefined。month 形如 '2026-08' */
export async function getBudget(month: string): Promise<Budget | undefined> {
  return db.budgets.where('month').equals(month).first();
}

/**
 * 设置某月总预算（存在则更新额度）。
 * @param totalLimit 额度，分
 * @param autoRenew 是否延续到下月，缺省沿用全局设置
 */
export async function setBudget(month: string, totalLimit: number, autoRenew?: boolean): Promise<void> {
  const renew = autoRenew ?? (await getSetting('budget.autoRenew'));
  const existing = await getBudget(month);
  if (existing) {
    await db.budgets.update(existing.id!, { totalLimit, autoRenew: renew, updatedAt: now() });
  } else {
    await db.budgets.add(stamp({ month, totalLimit, autoRenew: renew }) as Budget);
  }
  emit('budgets-changed', { month });
}

/**
 * 确保某月预算存在：若无且上月开启 autoRenew，则按上月额度（含子预算）自动延续。
 * 由调度器/预算中心进入时调用。
 * @returns 该月预算（可能仍为 undefined，表示上月未设或未开启延续）
 */
export async function ensureMonthBudget(month: string): Promise<Budget | undefined> {
  const [y, m] = month.split('-').map(Number);
  const prev = new Date(y, m - 2, 1);
  const prevMonth = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`;
  let created = false;
  const budget = await db.transaction('rw', [db.budgets, db.categoryBudgets], async () => {
    const existing = await getBudget(month);
    if (existing) return existing;
    const prevBudget = await getBudget(prevMonth);
    if (!prevBudget || !prevBudget.autoRenew) return undefined;
    const next = stamp({
      month,
      totalLimit: prevBudget.totalLimit,
      autoRenew: prevBudget.autoRenew,
    }) as Budget;
    const id = await db.budgets.add(next);
    const prevCats = await db.categoryBudgets.where('month').equals(prevMonth).toArray();
    for (const cb of prevCats) {
      await db.categoryBudgets.add(stamp({ month, categoryId: cb.categoryId, limit: cb.limit }) as CategoryBudget);
    }
    created = true;
    return { ...next, id };
  });
  if (created) emit('budgets-changed', { month });
  return budget;
}

/** 某月全部分类子预算 */
export async function listCategoryBudgets(month: string): Promise<CategoryBudget[]> {
  return db.categoryBudgets.where('month').equals(month).toArray();
}

/**
 * 设置分类子预算（limit 为 0 时删除该子预算）。
 * @param categoryId 支出大类 id
 * @param limit 额度，分
 */
export async function setCategoryBudget(month: string, categoryId: number, limit: number): Promise<void> {
  const existing = await db.categoryBudgets.where('[month+categoryId]').equals([month, categoryId]).first();
  if (limit <= 0) {
    if (existing) await db.categoryBudgets.delete(existing.id!);
  } else if (existing) {
    await db.categoryBudgets.update(existing.id!, { limit, updatedAt: now() });
  } else {
    await db.categoryBudgets.add(stamp({ month, categoryId, limit }) as CategoryBudget);
  }
  emit('budgets-changed', { month });
}
