/**
 * 拾光 · 统计仓库（statsRepo）
 * 只读聚合查询：收支汇总、分类构成、排行、日历聚合、净资产走势、预算已用。
 *
 * 统计口径（PRD 数据一致性硬规则）：
 * - 转账与借贷不计收支；回收站账单不计任何统计；补账按 occurredAt 归属周期；
 * - 报销口径由设置 'reimburse.countAsIncome' 决定：
 *   · false（冲抵，默认）：已到账报销额从原账单所在周期的支出中扣减，不进收入；
 *   · true（计收入）：已到账报销额按 reimbursedAt 所在周期计入收入，支出不扣减。
 */
import { db } from '../db';
import { dayKey } from './entryRepo';
import { listNetWorthAccounts } from './accountRepo';
import { getSetting } from './settingsRepo';
import type { Entry } from '../types';
import { filterLedgerEntries, summarizeLedgerEntries } from '../ledgerQuery';
import { ledgerItems, type LedgerItem } from '../ledgerEvents';
import { accountEffects } from '../entryEffects';

/** 收支汇总结果（分） */
export interface Summary {
  expense: number;
  income: number;
  /** 结余 = income − expense */
  balance: number;
}

/** 'YYYY-MM' → [monthStart, nextMonthStart) 毫秒时间戳 */
export function monthRange(month: string): { from: number; to: number } {
  const [y, m] = month.split('-').map(Number);
  return { from: new Date(y, m - 1, 1).getTime(), to: new Date(y, m, 1).getTime() };
}

/** 取某时间所在自然周（周一起）的范围 [from, to) */
export function weekRange(ts: number): { from: number; to: number } {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  const dow = (d.getDay() + 6) % 7; // 周一=0
  const from = d.getTime() - dow * 86400000;
  return { from, to: from + 7 * 86400000 };
}

/** 'YYYY' → 全年范围 [from, to) */
export function yearRange(year: number): { from: number; to: number } {
  return { from: new Date(year, 0, 1).getTime(), to: new Date(year + 1, 0, 1).getTime() };
}

/** 范围内未删除账单（内部通用取数） */
async function entriesIn(from: number, to: number): Promise<Entry[]> {
  return db.entries.where('[deletedAt+occurredAt]').between([0, from], [0, to], true, false).toArray();
}

/**
 * 统一统计事件集：普通账单按 occurredAt 入选；计收入口径额外按 reimbursedAt
 * 载入报销来源并展开为到账事件。来源账单可早于查询范围。
 */
export async function ledgerEntriesInRange(
  from: number,
  to: number,
  countAsIncome?: boolean,
): Promise<LedgerItem[]> {
  const asIncome = countAsIncome ?? await getSetting('reimburse.countAsIncome');
  const rows = await entriesIn(from, to);
  if (asIncome) {
    const reimbursedSources = await db.entries
      .where('reimburseStatus')
      .equals('done')
      .filter((entry) => entry.deletedAt === 0 && entry.reimbursedAt != null
        && entry.reimbursedAt >= from && entry.reimbursedAt < to)
      .toArray();
    const ids = new Set(rows.map((entry) => entry.id));
    rows.push(...reimbursedSources.filter((entry) => !ids.has(entry.id)));
  }
  return filterLedgerEntries(ledgerItems(rows, asIncome), { from, to });
}

/** 支出统计方向：普通支出为正，退款记录为负。 */
function expenseAmount(entry: Entry): number {
  return entry.refundFlag ? -entry.amount : entry.amount;
}

/**
 * 时间范围收支汇总（含报销口径处理）。
 * @param from 起（含）
 * @param to 止（不含）
 */
export async function rangeSummary(from: number, to: number): Promise<Summary> {
  const countAsIncome = await getSetting('reimburse.countAsIncome');
  const items = await ledgerEntriesInRange(from, to, countAsIncome);
  const summary = summarizeLedgerEntries(items, {
    reimburseMode: countAsIncome ? 'income' : 'offset',
  });
  return { expense: summary.expense, income: summary.income, balance: summary.balance };
}

/** 月收支汇总。month 形如 '2026-08' */
export async function monthSummary(month: string): Promise<Summary> {
  const { from, to } = monthRange(month);
  return rangeSummary(from, to);
}

/** 构建 支出小类 id → 大类 id 的映射（大类映射到自身） */
async function topLevelMap(): Promise<Map<number, number>> {
  const cats = await db.categories.where('kind').equals('expense').toArray();
  const map = new Map<number, number>();
  for (const c of cats) map.set(c.id!, c.parentId ?? c.id!);
  return map;
}

/**
 * 支出分类构成（按大类聚合，冲抵口径已扣减报销额），金额降序。
 * @returns [{ categoryId: 大类 id, amount }]
 */
export async function categoryBreakdown(from: number, to: number): Promise<{ categoryId: number; amount: number }[]> {
  const countAsIncome = await getSetting('reimburse.countAsIncome');
  const [rows, topMap] = await Promise.all([entriesIn(from, to), topLevelMap()]);
  const acc = new Map<number, number>();
  for (const e of rows) {
    if (e.type !== 'expense' || e.categoryId == null) continue;
    let amt = expenseAmount(e);
    if (!countAsIncome && e.reimburseStatus === 'done' && e.reimbursedAmount) amt -= e.reimbursedAmount;
    const top = topMap.get(e.categoryId) ?? e.categoryId;
    acc.set(top, (acc.get(top) ?? 0) + amt);
  }
  return [...acc.entries()].map(([categoryId, amount]) => ({ categoryId, amount })).sort((a, b) => b.amount - a.amount);
}

/**
 * 账户支出排行（仅统计支出账单的 accountId），金额降序。
 */
export async function accountRanking(from: number, to: number): Promise<{ accountId: number; amount: number }[]> {
  const [rows, countAsIncome] = await Promise.all([entriesIn(from, to), getSetting('reimburse.countAsIncome')]);
  const acc = new Map<number, number>();
  for (const e of rows) {
    if (e.type !== 'expense' || e.accountId == null) continue;
    const amount = expenseAmount(e) - (!countAsIncome && e.reimburseStatus === 'done' ? e.reimbursedAmount ?? 0 : 0);
    acc.set(e.accountId, (acc.get(e.accountId) ?? 0) + amount);
  }
  return [...acc.entries()].map(([accountId, amount]) => ({ accountId, amount })).sort((a, b) => b.amount - a.amount);
}

/**
 * 标签支出排行。仅统计打了标签的支出（口径须在 UI 注明），金额降序。
 */
export async function tagRanking(from: number, to: number): Promise<{ tagId: number; amount: number }[]> {
  const [rows, countAsIncome] = await Promise.all([entriesIn(from, to), getSetting('reimburse.countAsIncome')]);
  const expenseById = new Map<number, number>();
  for (const e of rows) {
    if (e.type !== 'expense' || e.id == null) continue;
    const amount = expenseAmount(e) - (!countAsIncome && e.reimburseStatus === 'done' ? e.reimbursedAmount ?? 0 : 0);
    expenseById.set(e.id, amount);
  }
  if (expenseById.size === 0) return [];
  const links = await db.entryTags.where('entryId').anyOf([...expenseById.keys()]).toArray();
  const acc = new Map<number, number>();
  for (const l of links) {
    const amt = expenseById.get(l.entryId);
    if (amt != null) acc.set(l.tagId, (acc.get(l.tagId) ?? 0) + amt);
  }
  return [...acc.entries()].map(([tagId, amount]) => ({ tagId, amount })).sort((a, b) => b.amount - a.amount);
}

/**
 * 日历每日聚合：某月每天的支出/收入/笔数（转账借贷计入笔数但不计金额）。
 * @returns Map<'YYYY-MM-DD', { expense, income, count }>
 */
export async function dailyAggregates(month: string): Promise<Map<string, { expense: number; income: number; count: number }>> {
  const { from, to } = monthRange(month);
  const countAsIncome = await getSetting('reimburse.countAsIncome');
  const rows = await ledgerEntriesInRange(from, to, countAsIncome);
  const map = new Map<string, { expense: number; income: number; count: number }>();
  for (const e of rows) {
    const key = dayKey(e.occurredAt);
    let d = map.get(key);
    if (!d) {
      d = { expense: 0, income: 0, count: 0 };
      map.set(key, d);
    }
    d.count += 1;
    const summary = summarizeLedgerEntries([e], {
      reimburseMode: countAsIncome ? 'income' : 'offset',
    });
    d.expense += summary.expense;
    d.income += summary.income;
  }
  return map;
}

/** 一条账单对「账户总余额」的净影响（分；转账双边抵消为 0，对账调整为单边） */
function netDelta(e: Entry, includedAccounts: ReadonlySet<number>): number {
  // 报销以到账日期单独加入事件，此处只计算原账单本金。
  return accountEffects({ ...e, reimbursedAmount: undefined })
    .filter(effect => includedAccounts.has(effect.accountId)).reduce((sum, effect) => sum + effect.delta, 0);
}

/**
 * 近 N 个月净资产走势：以当前余额为终点，用账单净影响逐月倒推各月末净资产。
 * @param months 月数，默认 6（含当前月，当前月取「现在」时点）
 * @returns 时间升序 [{ month: 'YYYY-MM', net }]
 */
export async function netWorthTrend(months = 6): Promise<{ month: string; net: number }[]> {
  const accounts = await listNetWorthAccounts();
  const includedAccounts = new Set(accounts.map(account => account.id));
  const currentNet = accounts.reduce((sum, account) => sum + account.balance, 0);
  const nowD = new Date();
  // 各月末边界（最早月在前）；最后一项为当前时点
  const bounds: { month: string; end: number }[] = [];
  for (let i = months - 1; i >= 1; i--) {
    const d = new Date(nowD.getFullYear(), nowD.getMonth() - i + 1, 1);
    const m = new Date(nowD.getFullYear(), nowD.getMonth() - i, 1);
    bounds.push({ month: `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}`, end: d.getTime() });
  }
  bounds.push({
    month: `${nowD.getFullYear()}-${String(nowD.getMonth() + 1).padStart(2, '0')}`,
    end: Date.now(),
  });

  const earliest = bounds[0].end;
  // 最早边界之后的所有账单（含报销到账事件），按时间构造净影响事件
  const rows = await entriesIn(earliest, Infinity);
  const events: { at: number; delta: number }[] = [];
  for (const e of rows) events.push({ at: e.occurredAt, delta: netDelta(e, includedAccounts) });
  const reimbursed = await db.entries
    .where('reimburseStatus')
    .equals('done')
    .filter((e) => e.deletedAt === 0 && e.reimbursedAt != null && e.reimbursedAt >= earliest)
    .toArray();
  for (const e of reimbursed) {
    if (e.reimburseAccountId != null && includedAccounts.has(e.reimburseAccountId)) {
      events.push({ at: e.reimbursedAt!, delta: e.reimbursedAmount ?? 0 });
    }
  }

  // 从当前净资产往回减：某月末净资产 = 当前 − (月末之后所有事件的净影响)
  return bounds.map(({ month, end }) => {
    const after = events.filter((ev) => ev.at >= end).reduce((s, ev) => s + ev.delta, 0);
    return { month, net: currentNet - after };
  });
}

/**
 * 预算已用：月支出按大类聚合（冲抵口径扣减已到账报销额），供预算中心与首页总览同源使用。
 * @returns totalUsed 为全部支出合计；byCategory 仅含有支出的大类
 */
export async function budgetUsage(month: string): Promise<{ totalUsed: number; byCategory: Map<number, number> }> {
  const { from, to } = monthRange(month);
  const breakdown = await categoryBreakdown(from, to);
  const byCategory = new Map<number, number>();
  let totalUsed = 0;
  for (const { categoryId, amount } of breakdown) {
    byCategory.set(categoryId, amount);
    totalUsed += amount;
  }
  return { totalUsed, byCategory };
}
