import { db } from '../db';
import type { LedgerItem } from '../ledgerEvents';
import type { Category } from '../types';
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
  /** 不设置时保留单月摘要；范围只能扩展到相邻两月或所选月结束的六个月。 */
  analysis?: 'compare' | 'trend';
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
  analysis?: {
    kind: 'compare' | 'trend';
    /** 按时间正序，各周期自身不再嵌套 analysis。 */
    periods: LifeLedgerSummary[];
    change: { expenseChangeFen: number; expenseChangePercent: number | null; reason: 'comparable' | 'empty-baseline' | 'zero-baseline' | 'negative-baseline' | 'negative-current' | 'unsafe-percentage' };
  };
}

export interface LifeLedgerReview { question: string; summary: LifeLedgerSummary }
type Destination = { baseUrl: string; model: string };
/** 只存在于当前页面内存；不能从草稿/备份恢复，也不能复用于重试。 */
export interface LifeLedgerGrant { readonly kind: 'life-ledger-once' }
const grants = new WeakMap<LifeLedgerGrant, { review: LifeLedgerReview; destination: Destination }>();
interface PeriodSnapshot {
  summary: LifeLedgerSummary;
  items: LedgerItem[];
  /** 与公开分类行逐项对应，合并分类仍保留所有内部分类身份。 */
  categoryItems: LedgerItem[][];
  fingerprint: string;
}
interface ReviewSnapshot { serialized: string; fingerprint: string; periods: PeriodSnapshot[] }
/** 原始记录与内部 ID 只存在当前页面内存，绝不放进摘要、草稿或请求。 */
const snapshots = new WeakMap<LifeLedgerReview, ReviewSnapshot>();
const categoryShareEligibility = new WeakMap<LifeLedgerSummary, boolean>();
const STALE_REVIEW = '账本或统计范围已变化，请重新确认后发送';

/** 仅识别读取本人账本的意图；不让模型决定是否读取或扩大范围。 */
export function isLifeLedgerQuestion(question: string): boolean {
  const text = question.trim();
  const request = text.replace(/^(?:(?:请你|请|帮我|帮忙|麻烦你|麻烦|能否|可以|能不能|你能|我想请你|我想让你|我想)\s*)*/, '');
  // 引用里的账本问题、写作/开发任务和通用方法咨询仍属于普通聊天。
  if (/润色|改写|翻译|复述|造句|措辞|这(?:句话|段话)|(?:写|编写|设计|开发|实现).{0,24}(?:代码|脚本|SQL|程序|软件|应用|功能|系统|机器人|提示词|文案)/i.test(text)
    || /^(?:(?:我想知道|我想了解|知道|了解|请问|我|你)\s*)*(?:(?:分析|解释|讲解|说明)(?:一下)?\s*)?(?:如何|怎么|怎样)(?:才能|能|可以)?(?:查看|查询|统计|分析|增加|提高|减少|降低|设计|计算|知道|判断|了解)/.test(request)
    || /消费(?:观|主义|税)|(?:收入|收支)(?:概念|定义|区别)/.test(text)) return false;
  const subject = /消费|支出|收入|收支|账单|账本|记账数据|花了?多少|花销|开销|开支|花的钱/.test(text);
  const anchor = /我的|本人|自己的|账本|账单|记账数据|本月|这(?:个)?月|上(?:个)?月|财务月|月度|近[6六]个?月|最近[6六]个?月|\d{1,4}(?:年|月)|\d{4}-\d{2}/.test(text);
  // 要求主动查询，而非「我昨天查看了账单」等叙述。单独的「我」或月份不构成请求。
  const action = /^(?:分析|对比|比较|统计|汇总|查询|查看|查查|查一下|看看|看一下|算算|算一下|计算)/.test(request)
    || /^(?:根据|基于|结合|用).{0,24}(?:账本|账单|记账数据).{0,12}(?:分析|统计|汇总|查|算)/.test(text);
  const directQuestion = /(?:消费|支出|收入|收支|花销|开销|开支|账单)(?:情况|构成|分布)?(?:有|是|一共|总共|合计|为|\s)*(?:多少(?:钱|元)?|几笔|有哪些|如何|怎么样|怎样)[？?。！!\s]*$/.test(text)
    || /花(?:了|掉)?多少(?:钱|元)?[？?。！!\s]*$|有哪些(?:消费|支出|收入|账单|开支)[？?。！!\s]*$/.test(text);
  return subject && anchor && (action || directQuestion);
}

/** 建议只是选择器初值，发送前始终展示并允许改选月份。 */
export async function suggestLifeLedgerScope(question: string, now = Date.now()): Promise<LifeLedgerScope> {
  const period = /财务月|记账周期/.test(question) ? 'accounting' : 'calendar';
  const date = new Date(now);
  let month = period === 'accounting' ? await getAccountingMonth(now) : monthKey(date.getFullYear(), date.getMonth());
  const explicit = /(\d{4})\s*(?:年|[-/])\s*(1[0-2]|0?[1-9])(?:月|(?=[^\d]|$))/.exec(question);
  const monthOnly = /(?:^|[^\d])(1[0-2]|0?[1-9])月/.exec(question.replace(/(?:最近|近)[6六]个?月/g, ''));
  if (explicit) month = `${explicit[1]}-${explicit[2].padStart(2, '0')}`;
  else if (monthOnly) month = `${date.getFullYear()}-${monthOnly[1].padStart(2, '0')}`;
  else if (/上(?:个)?月/.test(question) && !/(?:本|这(?:个)?)(?:财务)?月/.test(question)) month = shiftMonthKey(month, -1);
  const analysis = /近[6六]个?月|最近[6六]个?月|趋势/.test(question) ? 'trend'
    : /对比|比较|环比/.test(question) ? 'compare' : undefined;
  return { month, period, includeIncome: /收支|收入/.test(question), ...(analysis ? { analysis } : {}) };
}

function safeSum(values: number[]): number {
  return values.reduce((sum, value) => {
    if (!Number.isSafeInteger(value) || !Number.isSafeInteger(sum + value)) throw new Error('账本金额超出安全范围，请先检查账单');
    return sum + value;
  }, 0);
}

/** 精确到百分之一百分点；负值使用与正值对称的四舍五入。 */
function roundedPercent(numerator: number, denominator: number): number | null {
  const scaled = BigInt(numerator) * 10000n;
  const divisor = BigInt(denominator);
  const absolute = scaled < 0n ? -scaled : scaled;
  const rounded = (absolute + divisor / 2n) / divisor;
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  // 最终 number 也必须保留精确到两位的小数；不能只检查 BigInt 的中间运算。
  const result = Number(`${scaled < 0n && rounded !== 0n ? '-' : ''}${rounded / 100n}.${String(rounded % 100n).padStart(2, '0')}`);
  // JSON/普通字符串与 UI 的 toFixed(2) 都必须保留同一个十进制结果。
  for (const decimal of [Math.abs(result).toString(), Math.abs(result).toFixed(2)]) {
    const [whole, fraction = ''] = decimal.split('.');
    if (fraction.length > 2 || BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0')) !== rounded) return null;
  }
  return result;
}

async function buildPeriod(scope: LifeLedgerScope, asIncome: boolean, categories: Category[]): Promise<PeriodSnapshot> {
  const range = scope.period === 'accounting' ? await accountingMonthRange(scope.month) : monthRange(scope.month);
  const items = (await ledgerEntriesInRange(range.from, range.to, asIncome))
    .filter(item => item.type === 'expense' || (scope.includeIncome && item.type === 'income'));
  const expenses = items.filter(item => item.type === 'expense');
  const mode = asIncome ? 'income' : 'offset';
  const net = (rows: LedgerItem[]) => {
    // 与报表、搜索共用账务口径，同时保留现有保守安全整数检查。
    safeSum(rows.flatMap(row => [row.amount, row.reimbursedAmount ?? 0]));
    return safeSum([summarizeLedgerEntries(rows, { reimburseMode: mode }).expense]);
  };
  const categoryMap = new Map(categories.map(category => [category.id, category]));
  const grouped = new Map<number | undefined, LedgerItem[]>();
  for (const expense of expenses) {
    const category = categoryMap.get(expense.categoryId ?? -1);
    const key = category?.parentId ?? category?.id;
    const rows = grouped.get(key);
    if (rows) rows.push(expense); else grouped.set(key, [expense]);
  }
  const ranked = [...grouped].map(([id, rows]) => ({
    id, rows, name: (categoryMap.get(id ?? -1)?.name ?? '未分类').slice(0, 80), expenseFen: net(rows), count: rows.length,
  })).sort((a, b) => Math.abs(b.expenseFen) - Math.abs(a.expenseFen) || a.name.localeCompare(b.name));
  const publicRows = ranked.map(({ name, expenseFen, count }) => ({ name, expenseFen, count }));
  const categoryItems = ranked.length <= 12 ? ranked.map(row => row.rows)
    : [...ranked.slice(0, 12).map(row => row.rows), ranked.slice(12).flatMap(row => row.rows)];
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
    categories: publicRows.length <= 12 ? publicRows : [...publicRows.slice(0, 12), {
      name: '其他分类（合并）', expenseFen: safeSum(publicRows.slice(12).map(row => row.expenseFen)), count: publicRows.slice(12).reduce((sum, row) => sum + row.count, 0),
    }],
  };
  if (scope.includeIncome) {
    const income = items.filter(item => item.type === 'income');
    summary.income = {
      incomeFen: safeSum(income.map(item => item.amount)),
      reimbursementIncomeFen: safeSum(income.filter(item => item.kind === 'reimbursement').map(item => item.amount)), count: income.length,
    };
  }
  categoryShareEligibility.set(summary, ranked.every(row => row.expenseFen >= 0));
  const relevantCategoryIds = new Set(items.flatMap(item => item.categoryId == null ? [] : [item.categoryId]));
  for (const id of [...relevantCategoryIds]) {
    const parent = categoryMap.get(id)?.parentId;
    if (parent != null) relevantCategoryIds.add(parent);
  }
  // 精确的本机快照（非出站摘要、非散列）检测同额替换、类别身份/子类名、时间和备注变更。
  const fingerprint = JSON.stringify({ items, categories: categories.filter(category => relevantCategoryIds.has(category.id)),
    groups: ranked.map(row => row.id ?? null) });
  return { summary, items, categoryItems, fingerprint };
}

function periodChange(first: LifeLedgerSummary, last: LifeLedgerSummary): NonNullable<LifeLedgerSummary['analysis']>['change'] {
  const baseline = first.totals.expenseFen, current = last.totals.expenseFen;
  const expenseChangeFen = safeSum([current, -baseline]);
  const reason = first.totals.expenseCount + first.totals.refundCount === 0 ? 'empty-baseline'
    : baseline === 0 ? 'zero-baseline' : baseline < 0 ? 'negative-baseline' : current < 0 ? 'negative-current' : 'comparable';
  const expenseChangePercent = reason === 'comparable' ? roundedPercent(expenseChangeFen, baseline) : null;
  return { expenseChangeFen, expenseChangePercent, reason: reason === 'comparable' && expenseChangePercent === null ? 'unsafe-percentage' : reason };
}

/** JS 多参数 Date 会把 0–99 年改作 1900–1999；这些范围不支持。 */
function validReviewMonth(month: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(month) && Number(month.slice(0, 4)) >= 100;
}

/** 只在本机按已选的固定周期聚合，不读取账户余额、标签、凭证或生活记录。 */
export async function getLifeLedgerReview(question: string, scope: LifeLedgerScope): Promise<LifeLedgerReview> {
  if (!question.trim() || question.length > 8000) throw new Error('请先填写 8000 字以内的问题');
  if (!validReviewMonth(scope.month) || !['calendar', 'accounting'].includes(scope.period)
    || typeof scope.includeIncome !== 'boolean' || (scope.analysis !== undefined && scope.analysis !== 'compare' && scope.analysis !== 'trend')) {
    throw new Error('请选择有效的账本范围');
  }
  const selectedScope = { month: scope.month, period: scope.period, includeIncome: scope.includeIncome,
    ...(scope.analysis ? { analysis: scope.analysis } : {}) };
  // 同一只读事务固定账目、分类和设置，防止多周期读取期间混合不同版本。
  return db.transaction('r', db.entries, db.categories, db.settings, async () => {
    const asIncome = await getSetting('reimburse.countAsIncome');
    const categories = await db.categories.toArray();
    const length = selectedScope.analysis === 'trend' ? 6 : selectedScope.analysis === 'compare' ? 2 : 1;
    const periods: PeriodSnapshot[] = [];
    for (let index = 1 - length; index <= 0; index++) {
      const month = index === 0 ? selectedScope.month : shiftMonthKey(selectedScope.month, index).padStart(7, '0');
      if (!validReviewMonth(month)) throw new Error('请选择有效的账本范围');
      periods.push(await buildPeriod({ month, period: selectedScope.period, includeIncome: selectedScope.includeIncome }, asIncome, categories));
    }
    const selected = periods[periods.length - 1].summary;
    const summary: LifeLedgerSummary = selectedScope.analysis ? { ...selected, scope: selectedScope, analysis: {
      kind: selectedScope.analysis, periods: periods.map(period => period.summary), change: periodChange(periods[0].summary, selected),
    } } : selected;
    categoryShareEligibility.set(summary, categoryShareEligibility.get(selected) === true);
    const review = { question, summary };
    snapshots.set(review, { serialized: JSON.stringify(review), fingerprint: JSON.stringify(periods.map(period => period.fingerprint)), periods });
    return review;
  });
}

/** 所有可见周期；不把外层所选月再重复计数。 */
export function lifeLedgerPeriods(review: LifeLedgerReview): LifeLedgerSummary[] {
  return review.summary.analysis?.periods ?? [review.summary];
}

export function lifeLedgerReviewCount(review: LifeLedgerReview): number {
  return lifeLedgerPeriods(review).reduce((count, period) => count + period.totals.expenseCount + period.totals.refundCount + (period.income?.count ?? 0), 0);
}

/** 分类占比只作本机展示。未知来源或含负分类（包括合并前）不输出占比。 */
export function lifeLedgerCategoryShares(summary: LifeLedgerSummary): Array<number | null> {
  const eligible = categoryShareEligibility.get(summary) === true && summary.totals.expenseFen > 0
    && summary.categories.every(row => row.expenseFen >= 0);
  return summary.categories.map(row => eligible ? roundedPercent(row.expenseFen, summary.totals.expenseFen) : null);
}

export function getLifeLedgerFollowUps(review: LifeLedgerReview): Array<{ label: string; question: string; scope: LifeLedgerScope }> {
  const { month, period, includeIncome, analysis } = review.summary.scope;
  const subject = includeIncome ? '收支' : '支出';
  const selected = `${month} ${period === 'calendar' ? '自然月' : '财务月'}`;
  return ([undefined, 'compare', 'trend'] as const).filter(mode => mode !== analysis).map(mode => ({
    label: mode === 'compare' ? '对比上月' : mode === 'trend' ? '近6个月趋势' : '查看单月',
    question: mode === 'compare' ? `对比我的 ${selected}${subject}与上一个月。`
      : mode === 'trend' ? `分析我的截至 ${selected}的近6个月${subject}趋势。` : `分析我的 ${selected}${subject}。`,
    scope: { month, period, includeIncome, ...(mode ? { analysis: mode } : {}) },
  }));
}

async function freshSnapshot(review: LifeLedgerReview): Promise<ReviewSnapshot> {
  const snapshot = snapshots.get(review);
  if (!snapshot || JSON.stringify(review) !== snapshot.serialized) throw new Error(STALE_REVIEW);
  const fresh = await getLifeLedgerReview(review.question, review.summary.scope);
  const next = snapshots.get(fresh)!;
  if (next.serialized !== snapshot.serialized || next.fingerprint !== snapshot.fingerprint) throw new Error(STALE_REVIEW);
  return next;
}

/** 请求返回后或本机下钻前复核；反序列化对象不能恢复原有审阅资格。 */
export async function assertLifeLedgerReviewFresh(review: LifeLedgerReview): Promise<void> {
  await freshSnapshot(review);
}

/** 仅返回本机明细；选择器只允许审阅范围内某月、收支类型和对应的分类行。 */
export async function getLifeLedgerEvidence(review: LifeLedgerReview, selection: {
  month: string; type: 'expense' | 'income'; categoryIndex?: number;
}): Promise<{ items: LedgerItem[]; summary: LifeLedgerSummary; label: string }> {
  const snapshot = await freshSnapshot(review);
  const period = snapshot.periods.find(item => item.summary.scope.month === selection.month);
  const index = selection.categoryIndex;
  if (!period || (selection.type !== 'expense' && selection.type !== 'income')
    || (selection.type === 'income' && (!period.summary.scope.includeIncome || index !== undefined))
    || (index !== undefined && (!Number.isSafeInteger(index) || index < 0 || index >= period.categoryItems.length))) {
    throw new Error('请选择本次已确认范围内的账单');
  }
  const category = index === undefined ? undefined : period.summary.categories[index];
  const included = index === undefined ? undefined : new Set(period.categoryItems[index]);
  const items = period.items.filter(item => item.type === selection.type && (!included || included.has(item)));
  return { items, summary: period.summary,
    label: `${period.summary.scope.month} ${category?.name ?? (selection.type === 'income' ? '收入' : '支出')}（${period.summary.range.label}）` };
}

/** 用户看到的全部金融数值与真正发送的摘要来自同一对象。 */
function periodReviewLines(s: LifeLedgerSummary): string[] {
  return [
    `范围：${s.scope.month} ${s.scope.period === 'calendar' ? '自然月' : '财务月'}（${s.range.label}）`,
    '数据：该范围内当前已记账的数据；货币为人民币。',
    `支出 ${s.totals.expenseCount} 笔，原始支出 ¥${formatFen(s.totals.grossExpenseFen)}`,
    `退款 ${s.totals.refundCount} 笔，冲抵 ¥${formatFen(s.totals.refundFen)}`,
    s.reimbursementMode === 'offset' ? `到账报销按原支出周期冲抵 ¥${formatFen(s.totals.reimbursementOffsetFen)}` : '到账报销按到账时间计收入，不冲抵支出',
    `净支出 ¥${formatFen(s.totals.expenseFen)}`,
    ...s.categories.map(row => `${row.name}：净支出 ¥${formatFen(row.expenseFen)}（含退款共 ${row.count} 笔）`),
    ...(s.income ? [`收入 ${s.income.count} 笔，合计 ¥${formatFen(s.income.incomeFen)}（其中报销到账 ¥${formatFen(s.income.reimbursementIncomeFen)}）`] : []),
  ];
}

/** 审阅文案与出站汇总使用同一组已核算数值；多月不会隐含扩展。 */
export function lifeLedgerReviewText(review: LifeLedgerReview): string {
  const analysis = review.summary.analysis;
  const periods = lifeLedgerPeriods(review);
  const reasonText = { 'empty-baseline': '基期没有支出账单', 'zero-baseline': '基期净支出为零',
    'negative-baseline': '基期净支出为负', 'negative-current': '所选月净支出为负', 'unsafe-percentage': '变化比例超出安全精度', comparable: '' };
  return [
    `问题：${review.question}`,
    ...(analysis ? [`分析：${analysis.kind === 'compare' ? '与上月对比' : '近6个月趋势'}；以下为全部发送周期`] : []),
    ...periods.flatMap(periodReviewLines),
    ...(analysis ? [`${periods.at(-1)!.scope.month} 较 ${periods[0].scope.month} 净支出变化 ¥${formatFen(analysis.change.expenseChangeFen)}`,
      analysis.change.expenseChangePercent === null ? `${reasonText[analysis.change.reason]}，不计算变化百分比`
        : `净支出变化 ${analysis.change.expenseChangePercent}%`] : []),
    '转账和借贷不计收支；回收站账单不参与统计。',
    analysis ? '不含账户余额、账户名、商家、备注、标签、凭证、逐笔明细、上述范围外月份或历史聊天。'
      : '不含账户余额、账户名、商家、备注、标签、凭证、逐笔明细、其他月份或历史聊天。',
  ].join('\n');
}

/** 仅在用户点击「同意并发送」之后调用。 */
export function approveLifeLedgerReview(review: LifeLedgerReview, destination: Destination): LifeLedgerGrant {
  const grant: LifeLedgerGrant = Object.freeze({ kind: 'life-ledger-once' });
  const approved = structuredClone(review);
  const snapshot = snapshots.get(review);
  if (snapshot) {
    snapshots.set(approved, snapshot);
    const originalPeriods = lifeLedgerPeriods(review);
    lifeLedgerPeriods(approved).forEach((period, index) => categoryShareEligibility.set(period, categoryShareEligibility.get(originalPeriods[index]) === true));
    categoryShareEligibility.set(approved.summary, categoryShareEligibility.get(review.summary) === true);
  }
  grants.set(grant, { review: approved, destination: { ...destination } });
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
  await assertLifeLedgerReviewFresh(approved.review);
  return approved.review;
}
