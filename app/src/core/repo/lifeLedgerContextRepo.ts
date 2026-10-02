import { db } from '../db';
import { summarizeLedgerEntries } from '../ledgerQuery';
import { formatFen } from '../money';
import { formatAccountingRange, monthKey, shiftMonthKey } from '../period';
import { accountingMonthRange, getAccountingMonth } from './periodRepo';
import { getSetting } from './settingsRepo';
import { ledgerEntriesInRange, monthRange } from './statsRepo';

export interface LifeLedgerScope {
  month: string;
  period: 'calendar' | 'accounting';
  includeIncome: boolean;
}

export interface LifeLedgerSummary {
  scope: LifeLedgerScope;
  range: { from: number; to: number; label: string };
  currency: 'CNY';
  unit: 'fen';
  reimbursementMode: 'income' | 'offset';
  totals: { expenseFen: number; grossExpenseFen: number; refundFen: number; reimbursementOffsetFen: number; expenseCount: number; refundCount: number };
  categories: { name: string; expenseFen: number; count: number }[];
  income?: { incomeFen: number; reimbursementIncomeFen: number; count: number };
}

export interface LifeLedgerReview { question: string; summary: LifeLedgerSummary }
type Destination = { baseUrl: string; model: string };
/** 只存在于当前页面内存；不能从草稿/备份恢复，也不能复用于重试。 */
export interface LifeLedgerGrant { readonly kind: 'life-ledger-once' }
const grants = new WeakMap<LifeLedgerGrant, { review: LifeLedgerReview; destination: Destination }>();

/** 仅识别读取本人账本的意图；不让模型决定是否读取或扩大范围。 */
export function isLifeLedgerQuestion(question: string): boolean {
  const subject = /消费|支出|收入|收支|账单|账本|记账数据|花了?多少|花销|开销|开支/.test(question);
  const request = /我|本月|这(?:个)?月|上(?:个)?月|财务月|\d{1,4}(?:年|月)|\d{4}-\d{2}|分析|统计|查|看|汇总/.test(question);
  return subject && request;
}

/** 建议只是选择器初值，发送前始终展示并允许改选月份。 */
export async function suggestLifeLedgerScope(question: string, now = Date.now()): Promise<LifeLedgerScope> {
  const period = /财务月|记账周期/.test(question) ? 'accounting' : 'calendar';
  const date = new Date(now);
  let month = period === 'accounting' ? await getAccountingMonth(now) : monthKey(date.getFullYear(), date.getMonth());
  const explicit = /(\d{4})\s*(?:年|[-/])\s*(1[0-2]|0?[1-9])(?:月|(?=[^\d]|$))/.exec(question);
  const monthOnly = /(?:^|[^\d])(1[0-2]|0?[1-9])月/.exec(question);
  if (explicit) month = `${explicit[1]}-${explicit[2].padStart(2, '0')}`;
  else if (monthOnly) month = `${date.getFullYear()}-${monthOnly[1].padStart(2, '0')}`;
  else if (/上(?:个)?月/.test(question)) month = shiftMonthKey(month, -1);
  return { month, period, includeIncome: /收支|收入/.test(question) };
}

function safeSum(values: number[]): number {
  return values.reduce((sum, value) => {
    if (!Number.isSafeInteger(value) || !Number.isSafeInteger(sum + value)) throw new Error('账本金额超出安全范围，请先检查账单');
    return sum + value;
  }, 0);
}

/** 只在本机按已选范围聚合。不查询账户余额、商家、备注、标签、凭证或生活记录。 */
export async function getLifeLedgerReview(question: string, scope: LifeLedgerScope): Promise<LifeLedgerReview> {
  if (!question.trim() || question.length > 8000) throw new Error('请先填写 8000 字以内的问题');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(scope.month) || !['calendar', 'accounting'].includes(scope.period)
    || typeof scope.includeIncome !== 'boolean') throw new Error('请选择有效的账本范围');
  const range = scope.period === 'accounting' ? await accountingMonthRange(scope.month) : monthRange(scope.month);
  const asIncome = await getSetting('reimburse.countAsIncome');
  const [items, categories] = await Promise.all([
    ledgerEntriesInRange(range.from, range.to, asIncome), db.categories.toArray(),
  ]);
  const expenses = items.filter(item => item.type === 'expense');
  const mode = asIncome ? 'income' : 'offset';
  const net = (rows: typeof expenses) => {
    // 与报表、搜索共用账务口径，同时拒绝损坏或累加溢出的金额。
    safeSum(rows.flatMap(row => [row.amount, row.reimbursedAmount ?? 0]));
    const amount = summarizeLedgerEntries(rows, { reimburseMode: mode }).expense;
    return safeSum([amount]);
  };
  const categoryMap = new Map(categories.map(category => [category.id, category]));
  const grouped = new Map<number | undefined, typeof expenses>();
  for (const expense of expenses) {
    const category = categoryMap.get(expense.categoryId ?? -1);
    const key = category?.parentId ?? category?.id;
    const rows = grouped.get(key);
    if (rows) rows.push(expense); else grouped.set(key, [expense]);
  }
  const ranked = [...grouped].map(([id, rows]) => ({
    name: (categoryMap.get(id ?? -1)?.name ?? '未分类').slice(0, 80), expenseFen: net(rows), count: rows.length,
  })).sort((a, b) => Math.abs(b.expenseFen) - Math.abs(a.expenseFen) || a.name.localeCompare(b.name));
  const summary: LifeLedgerSummary = {
    scope: { month: scope.month, period: scope.period, includeIncome: scope.includeIncome },
    range: { ...range, label: formatAccountingRange(range) }, currency: 'CNY', unit: 'fen', reimbursementMode: mode,
    totals: {
      expenseFen: net(expenses),
      grossExpenseFen: safeSum(expenses.filter(item => !item.refundFlag).map(item => item.amount)),
      refundFen: safeSum(expenses.filter(item => item.refundFlag).map(item => item.amount)),
      reimbursementOffsetFen: asIncome ? 0 : safeSum(expenses.filter(item => item.reimburseStatus === 'done').map(item => item.reimbursedAmount ?? 0)),
      expenseCount: expenses.filter(item => !item.refundFlag).length,
      refundCount: expenses.filter(item => item.refundFlag).length,
    },
    categories: ranked.length <= 12 ? ranked : [...ranked.slice(0, 12), {
      name: '其他分类（合并）', expenseFen: safeSum(ranked.slice(12).map(row => row.expenseFen)), count: ranked.slice(12).reduce((sum, row) => sum + row.count, 0),
    }],
  };
  if (scope.includeIncome) {
    const income = items.filter(item => item.type === 'income');
    summary.income = {
      incomeFen: safeSum(income.map(item => item.amount)),
      reimbursementIncomeFen: safeSum(income.filter(item => item.kind === 'reimbursement').map(item => item.amount)), count: income.length,
    };
  }
  return { question, summary };
}

/** 用户看到的全部金融数值与真正发送的摘要来自同一对象。 */
export function lifeLedgerReviewText({ question, summary: s }: LifeLedgerReview): string {
  return [
    `问题：${question}`, `范围：${s.scope.month} ${s.scope.period === 'calendar' ? '自然月' : '财务月'}（${s.range.label}）`,
    '数据：该范围内当前已记账的数据；货币为人民币。',
    `支出 ${s.totals.expenseCount} 笔，原始支出 ¥${formatFen(s.totals.grossExpenseFen)}`,
    `退款 ${s.totals.refundCount} 笔，冲抵 ¥${formatFen(s.totals.refundFen)}`,
    s.reimbursementMode === 'offset' ? `到账报销按原支出周期冲抵 ¥${formatFen(s.totals.reimbursementOffsetFen)}` : '到账报销按到账时间计收入，不冲抵支出',
    `净支出 ¥${formatFen(s.totals.expenseFen)}`,
    ...s.categories.map(row => `${row.name}：净支出 ¥${formatFen(row.expenseFen)}（含退款共 ${row.count} 笔）`),
    ...(s.income ? [`收入 ${s.income.count} 笔，合计 ¥${formatFen(s.income.incomeFen)}（其中报销到账 ¥${formatFen(s.income.reimbursementIncomeFen)}）`] : []),
    '转账和借贷不计收支；回收站账单不参与统计。',
    '不含账户余额、账户名、商家、备注、标签、凭证、逐笔明细、其他月份或历史聊天。',
  ].join('\n');
}

/** 仅在用户点击「同意并发送」之后调用。 */
export function approveLifeLedgerReview(review: LifeLedgerReview, destination: Destination): LifeLedgerGrant {
  const grant: LifeLedgerGrant = Object.freeze({ kind: 'life-ledger-once' });
  grants.set(grant, { review: structuredClone(review), destination: { ...destination } });
  return grant;
}

/** 包括在启用/来源/取消校验阶段失败的尝试，也不得保留旧授权。 */
export function revokeLifeLedgerGrant(grant: LifeLedgerGrant): void { grants.delete(grant); }

/** 出站前再次核对，失效/已消费的授权绝不自动重试或回退为普通聊天。 */
export async function consumeLifeLedgerGrant(grant: LifeLedgerGrant, question: string, destination?: Destination): Promise<LifeLedgerReview> {
  const approved = grants.get(grant);
  grants.delete(grant);
  if (!approved || approved.review.question !== question || !destination
    || approved.destination.baseUrl !== destination.baseUrl || approved.destination.model !== destination.model) {
    throw new Error('账本分析需重新确认本次问题、摘要和 AI 服务');
  }
  const fresh = await getLifeLedgerReview(question, approved.review.summary.scope);
  if (JSON.stringify(fresh) !== JSON.stringify(approved.review)) throw new Error('账本或统计范围已变化，请重新确认后发送');
  return approved.review;
}
