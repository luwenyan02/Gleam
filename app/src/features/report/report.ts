/**
 * 拾光 · 报表页（features/report，PRD 4.4）
 * 周/月/年三周期收支报表：汇总卡、收支趋势柱状图、支出构成环形图、分类/账户/标签排行。
 * SVG 绘制逻辑移植自原型 index.html renderTrend/renderDonut/renderRank（L1202-1256），
 * 数据一律经 statsRepo/repo 读取，金额格式化只走 money.ts。
 *
 * 趋势口径：周 = 单日支出单柱（7 天）；月 = 近 6 个月支出+收入双柱（含所选月）；
 * 年 = 所选年 12 个月支出+收入双柱。转账/借贷不计收支由 statsRepo 保证。
 */
import './report.css';
import { openEntityInsight } from '../tagmerchant/tagmerchant';
import { iconHtml } from '../../assets/icons';
import { esc } from '../../core/esc';
import { on } from '../../core/store';
import { formatFen, formatFenCny } from '../../core/money';
import * as statsRepo from '../../core/repo/statsRepo';
import { listCategories } from '../../core/repo/categoryRepo';
import { listAccounts } from '../../core/repo/accountRepo';
import { listTags } from '../../core/repo/tagRepo';
import { listMerchants } from '../../core/repo/merchantRepo';
import { registerPage } from '../shell/router';
import type { Account, Category } from '../../core/types';
import {
  collapseRankRows, reportSelectionToLedgerQuery,
  type ReportDimension, type ReportSelection,
} from '../../core/ledgerQuery';
import { openLedgerSearch } from '../search/search';
import { openDateWheel, openMonthWheel } from '../../shared/dateTimeWheel';
import { showToast } from '../shell/toast';
import { accountingMonthRange, getAccountingMonth } from '../../core/repo/periodRepo';
import { formatAccountingRange, shiftMonthKey } from '../../core/period';

type Period = 'week' | 'month' | 'year' | 'custom';

/** 排行/环形图统一行结构（amount 为分） */
interface RankRow {
  id: number;
  queryIds: number[];
  name: string;
  icon: string;
  amount: number;
}

/** 一次刷新所需的全部报表数据 */
interface ReportData {
  label: string;
  range: { from: number; to: number };
  summary: statsRepo.Summary;
  trend: { labels: string[]; expense: number[]; incomes: number[]; ranges: { from: number; to: number }[] };
  cats: RankRow[];
  accts: RankRow[];
  tags: RankRow[];
  incomes: RankRow[];
  merchants: RankRow[];
}

/* ── 模块状态 ── */
let period: Period = 'month';
/** 周期锚点（落在所选周期内的任意时刻） */
let anchor = new Date();
let dimension: ReportDimension = 'trend';
let customRange: { from: number; to: number } | undefined;
let rankExpanded = false;
let root: HTMLElement | undefined;
/** 并发刷新令牌：仅最后一次 refresh 的结果允许上屏 */
let refreshToken = 0;
/** 待应用的切换过渡范围：'all'=周期切换整页内容淡入，'rank'=仅排行卡 */
let pendingAnim: 'all' | 'rank' | null = null;
/** 月视图使用财务月键；为空时按当前日期和全局起始日初始化。 */
let selectedAccountingMonth = '';
let followsCurrentAccountingMonth = true;
let activeRange: { from: number; to: number } | undefined;

const DAY = 86400000;

/** 账户组 → 展示图标（与原型 ACCT_ICONS 语义一致） */
const GROUP_ICONS: Record<Account['group'], string> = {
  cash: 'ic-wallet',
  credit: 'ic-card',
  debit: 'ic-card',
  online: 'ic-pay',
  investment: 'ic-chart',
  receivable: 'ic-coin',
  stored: 'ic-card',
  other: 'ic-wallet',
};

/** 当前周期的时间范围 [from, to) */
async function currentRange(): Promise<{ from: number; to: number }> {
  if (period === 'week') return statsRepo.weekRange(anchor.getTime());
  if (period === 'year') return statsRepo.yearRange(anchor.getFullYear());
  if (period === 'custom' && customRange) return customRange;
  if (!selectedAccountingMonth || followsCurrentAccountingMonth) {
    selectedAccountingMonth = await getAccountingMonth(anchor.getTime());
  }
  return accountingMonthRange(selectedAccountingMonth);
}

/** 周期标签：'8月2日 – 8月8日' / '2026年8月' / '2026年' */
function periodLabel(range: { from: number; to: number }): string {
  if (period === 'week') {
    const { from, to } = range;
    const a = new Date(from);
    const b = new Date(to - DAY);
    return `${a.getMonth() + 1}月${a.getDate()}日 – ${b.getMonth() + 1}月${b.getDate()}日`;
  }
  if (period === 'year') return `${anchor.getFullYear()}年`;
  if (period === 'custom' && customRange) {
    const from = new Date(customRange.from);
    const to = new Date(customRange.to - 1);
    return `${from.getFullYear()}/${from.getMonth() + 1}/${from.getDate()} – ${to.getFullYear()}/${to.getMonth() + 1}/${to.getDate()}`;
  }
  const month = Number(selectedAccountingMonth.split('-')[1]);
  return `${month}月 · ${formatAccountingRange(range)}`;
}

/** 周期前后翻页（dir = ±1） */
async function shiftPeriod(dir: 1 | -1): Promise<void> {
  if (period === 'custom' && customRange) {
    const span = customRange.to - customRange.from;
    customRange = { from: customRange.from + dir * span, to: customRange.to + dir * span };
    anchor = new Date(customRange.from);
    pendingAnim = 'all';
    void refresh();
    return;
  }
  if (period === 'month') {
    if (!selectedAccountingMonth) selectedAccountingMonth = await getAccountingMonth(anchor.getTime());
    selectedAccountingMonth = shiftMonthKey(selectedAccountingMonth, dir);
    followsCurrentAccountingMonth = false;
    pendingAnim = 'all';
    void refresh();
    return;
  }
  const d = new Date(anchor);
  if (period === 'week') d.setDate(d.getDate() + dir * 7);
  else d.setFullYear(d.getFullYear() + dir, d.getMonth(), 1);
  anchor = d;
  pendingAnim = 'all';
  void refresh();
}

/* ── 数据装载 ── */

function trendBuckets(range: { from: number; to: number }): { label: string; from: number; to: number }[] {
  if (period === 'year') {
    return Array.from({ length: 12 }, (_, month) => ({
      label: `${month + 1}月`,
      from: new Date(anchor.getFullYear(), month, 1).getTime(),
      to: new Date(anchor.getFullYear(), month + 1, 1).getTime(),
    }));
  }
  const days = Math.max(1, Math.ceil((range.to - range.from) / DAY));
  const bucketDays = period === 'week' ? 1 : Math.max(1, Math.ceil(days / (period === 'month' ? 5 : 10)));
  const buckets: { label: string; from: number; to: number }[] = [];
  for (let from = range.from; from < range.to;) {
    const next = new Date(from);
    next.setDate(next.getDate() + bucketDays);
    const to = Math.min(range.to, next.getTime());
    const first = new Date(from);
    const last = new Date(to - 1);
    const label = bucketDays === 1
      ? `${first.getMonth() + 1}/${first.getDate()}`
      : first.getMonth() === last.getMonth()
        ? `${first.getDate()}–${last.getDate()}日`
        : `${first.getMonth() + 1}/${first.getDate()}–${last.getMonth() + 1}/${last.getDate()}`;
    buckets.push({ label, from, to });
    from = to;
  }
  return buckets;
}

/** 趋势数据严格取当前周期，柱/点的范围可直接转换为明细查询。 */
async function loadTrend(range: { from: number; to: number }): Promise<ReportData['trend']> {
  const buckets = trendBuckets(range);
  const summaries = await Promise.all(buckets.map((bucket) => statsRepo.rangeSummary(bucket.from, bucket.to)));
  return {
    labels: buckets.map((bucket) => bucket.label),
    expense: summaries.map((summary) => summary.expense),
    incomes: summaries.map((summary) => summary.income),
    ranges: buckets.map(({ from, to }) => ({ from, to })),
  };
}

/** 装载当前周期全部数据（汇总 + 趋势 + 三维排行） */
async function loadData(): Promise<ReportData> {
  const range = await currentRange();
  const { from, to } = range;
  const [summary, trend, breakdown, acctRank, tagRank, incomeRank, merchantRank, expenseCats, incomeCats, accounts, tags, merchants] = await Promise.all([
    statsRepo.rangeSummary(from, to),
    loadTrend(range),
    statsRepo.categoryBreakdown(from, to),
    statsRepo.accountRanking(from, to),
    statsRepo.tagRanking(from, to),
    statsRepo.incomeCategoryBreakdown(from, to),
    statsRepo.merchantRanking(from, to),
    listCategories('expense'),
    listCategories('income'),
    listAccounts(),
    listTags(),
    listMerchants(),
  ]);
  const catMap = new Map<number, Category>([...expenseCats, ...incomeCats].map((c) => [c.id, c]));
  const acctMap = new Map<number, Account>(accounts.map((a) => [a.id, a]));
  const tagMap = new Map(tags.map((t) => [t.id, t.name]));
  const merchantMap = new Map(merchants.map((m) => [m.id, m.name]));
  return {
    label: periodLabel(range),
    range,
    summary,
    trend,
    cats: breakdown.map(({ categoryId, amount }) => ({
      id: categoryId,
      queryIds: expenseCats.filter((cat) => cat.id === categoryId || cat.parentId === categoryId).map((cat) => cat.id),
      name: catMap.get(categoryId)?.name ?? '未分类',
      icon: catMap.get(categoryId)?.icon ?? 'ic-coin',
      amount,
    })),
    accts: acctRank.map(({ accountId, amount }) => ({
      id: accountId,
      queryIds: [accountId],
      name: acctMap.get(accountId)?.name ?? '已删除账户',
      icon: GROUP_ICONS[acctMap.get(accountId)?.group ?? 'cash'],
      amount,
    })),
    tags: tagRank.map(({ tagId, amount }) => ({
      id: tagId,
      queryIds: [tagId],
      name: tagMap.get(tagId) ?? '已删除标签',
      icon: 'ic-tag',
      amount,
    })),
    incomes: incomeRank.map(({ categoryId, amount }) => ({
      id: categoryId,
      queryIds: [categoryId],
      name: catMap.get(categoryId)?.name ?? '未分类',
      icon: catMap.get(categoryId)?.icon ?? 'ic-coin',
      amount,
    })),
    merchants: merchantRank.map(({ merchantId, amount }) => ({
      id: merchantId,
      queryIds: [merchantId],
      name: merchantMap.get(merchantId) ?? '已删除商家',
      icon: 'ic-shop',
      amount,
    })),
  };
}

/* ── SVG 绘制（移植原型逻辑） ── */

/** 收支趋势柱状图（原型 renderTrend；柱宽按柱数自适应以容纳 12 个月） */
function renderTrend(d: ReportData['trend']): void {
  const box = root!.querySelector<HTMLElement>('#trend')!;
  const cap = root!.querySelector<HTMLElement>('#trend-cap')!;
  const values = [...d.expense, ...d.incomes];
  if (!values.some((value) => value !== 0)) {
    box.innerHTML = '<div class="chart-empty">该周期暂无收支记录</div>';
    cap.textContent = '';
    return;
  }
  const W = 336, H = 168, plotTop = 34, plotBottom = 134, plotHeight = plotBottom - plotTop;
  const positiveMax = Math.max(0, ...values);
  const negativeMax = Math.max(0, ...values.map((value) => -value));
  const span = positiveMax + negativeMax;
  const zeroY = plotTop + (positiveMax / span) * plotHeight;
  const barBox = (value: number): { y: number; height: number } => {
    if (value === 0) return { y: zeroY, height: 0 };
    const height = Math.max(3, (Math.abs(value) / span) * plotHeight);
    return { y: value > 0 ? zeroY - height : zeroY, height };
  };
  const n = d.labels.length, slot = W / n;
  const dw = Math.min(12, slot / 2 - 2);   // 双柱单根宽
  let s = '';
  for (const y of [...new Set([plotTop, zeroY, plotBottom])]) {
    s += `<line x1="0" y1="${y.toFixed(1)}" x2="${W}" y2="${y.toFixed(1)}" stroke="var(--border)" stroke-width="1"${y === zeroY ? '' : ' stroke-dasharray="3 4"'}/>`;
  }
  d.labels.forEach((lb, i) => {
    const cx = slot * i + slot / 2;
    const expense = barBox(d.expense[i]);
    const income = barBox(d.incomes[i]);
    const range = d.ranges[i];
    s += `<g class="trend-hit" role="button" tabindex="0" data-drill-from="${range.from}" data-drill-to="${range.to}" aria-label="${esc(lb)}，支出 ${formatFenCny(d.expense[i])}，收入 ${formatFenCny(d.incomes[i])}，查看明细">`;
    s += `<rect data-series="expense" data-value="${d.expense[i]}" data-zero-y="${zeroY.toFixed(1)}" x="${(cx - dw - 1).toFixed(1)}" y="${expense.y.toFixed(1)}" width="${dw.toFixed(1)}" height="${expense.height.toFixed(1)}" rx="3" fill="var(--c1)"/>`;
    s += `<rect data-series="income" data-value="${d.incomes[i]}" data-zero-y="${zeroY.toFixed(1)}" x="${(cx + 1).toFixed(1)}" y="${income.y.toFixed(1)}" width="${dw.toFixed(1)}" height="${income.height.toFixed(1)}" rx="3" fill="var(--c4)"/>`;
    s += `<rect x="${Math.max(0, cx - slot / 2).toFixed(1)}" y="22" width="${slot.toFixed(1)}" height="${plotBottom - 20}" fill="transparent"/></g>`;
    s += `<text x="${cx.toFixed(1)}" y="${plotBottom + 18}" text-anchor="middle" font-size="${n > 8 ? 8.5 : 10}" fill="var(--muted)">${lb}</text>`;
  });
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" aria-label="收支趋势柱状图，可选择柱形查看明细">${s}</svg>`;
  cap.textContent = '橙色支出 · 绿色收入 · 点柱形看明细';
}

/** 支出构成环形图：直接展示前五项，其余合并为“其他”，各区段可下钻。 */
function renderDonut(cats: RankRow[]): void {
  const svg = root!.querySelector<HTMLElement>('#donut-svg')!;
  const legend = root!.querySelector<HTMLElement>('#donut-legend')!;
  const positiveCats = cats.filter((row) => row.amount > 0);
  if (positiveCats.length === 0) {
    svg.innerHTML = `<circle cx="60" cy="60" r="48" fill="none" stroke="var(--border)" stroke-width="15"/>
      <text x="60" y="64" text-anchor="middle" font-size="10" fill="var(--faint)">暂无支出</text>`;
    legend.innerHTML = '<li class="donut-empty">记录支出后这里会展示分类占比</li>';
    return;
  }
  const collapsed = collapseRankRows(positiveCats);
  const rows = collapsed.map((row) => row.id === 'other'
    ? { ...row, icon: 'ic-coin', queryIds: positiveCats.slice(5).flatMap((item) => item.queryIds) }
    : row);
  const total = rows.reduce((sum, r) => sum + r.amount, 0);
  const C = 2 * Math.PI * 48;
  let acc = 0, s = '';
  rows.forEach((r, i) => {
    const len = (r.amount / total) * C;
    s += `<circle class="donut-hit" role="button" tabindex="0" data-report-dim="category" data-report-ids="${r.queryIds.join(',')}" aria-label="${esc(r.name)} ${((r.amount / total) * 100).toFixed(1)}%，查看明细" cx="60" cy="60" r="48" fill="none" stroke="var(--c${i + 1})" stroke-width="15" stroke-dasharray="${Math.max(0, len - 2.4).toFixed(2)} ${(C - len + 2.4).toFixed(2)}" stroke-dashoffset="${(-acc).toFixed(2)}" transform="rotate(-90 60 60)"/>`;
    acc += len;
  });
  s += '<text x="60" y="56" text-anchor="middle" font-size="9" fill="var(--muted)">净支出</text>';
  s += `<text x="60" y="72" text-anchor="middle" font-size="13" font-weight="700" fill="var(--fg)" font-family="var(--font-mono)">¥${formatFen(cats.reduce((sum, row) => sum + row.amount, 0))}</text>`;
  svg.innerHTML = s;
  legend.innerHTML = rows
    .map((r, i) => `<li><button data-report-dim="category" data-report-ids="${r.queryIds.join(',')}"><span class="dot" style="background:var(--c${i + 1})"></span>${esc(r.name)}<b class="num">${((r.amount / total) * 100).toFixed(1)}%</b></button></li>`)
    .join('') + (cats.some(row => row.amount < 0) ? '<li class="tiny">环形占比仅展示正净支出分类，退款净额见下方明细</li>' : '');
}

/** 排行卡（原型 renderRank）：分类/账户/标签三维度，占比以周期总支出为基数 */
function renderRank(data: ReportData): void {
  const list = root!.querySelector<HTMLElement>('#rank')!;
  const note = root!.querySelector<HTMLElement>('#rank-note')!;
  const more = root!.querySelector<HTMLButtonElement>('#rank-more')!;
  const rows = dimension === 'account' ? data.accts
    : dimension === 'tag' ? data.tags
      : dimension === 'income' ? data.incomes
        : dimension === 'merchant' ? data.merchants : data.cats;
  note.hidden = dimension !== 'tag';
  if (rows.length === 0) {
    list.innerHTML = dimension === 'tag' || dimension === 'merchant' ? '' : dimension === 'income' ? '<li class="rank-empty">该周期暂无收入记录</li>' : '<li class="rank-empty">该周期暂无支出记录</li>';
    more.hidden = true;
    return;
  }
  const base = (dimension === 'income' ? data.summary.income : data.summary.expense) || rows.reduce((sum, r) => sum + r.amount, 0);
  const shown = rankExpanded ? rows : rows.slice(0, 3);
  list.innerHTML = shown
    .map((r, i) => {
      const pct = base > 0 ? (r.amount / base) * 100 : 0;
      return `<li><button class="rank-row rank-link" data-report-dim="${dimension}" data-report-ids="${r.queryIds.join(',')}">
        <span class="e-ic sm">${iconHtml(r.icon, 17)}</span>
        <div class="rank-main">
          <div class="rank-top"><span>${dimension === 'tag' ? '#' + esc(r.name) : esc(r.name)}</span><span class="num">¥${formatFen(r.amount)}</span></div>
          <div class="rank-bar"><i style="width:${Math.max(0, Math.min(100, pct)).toFixed(1)}%;background:var(--c${(i % 6) + 1})"></i></div>
        </div>
        <span class="rank-pct num">${pct.toFixed(1)}%</span></button>${(dimension === 'tag' || dimension === 'merchant') && r.queryIds.length === 1 ? `<button class="chip" data-entity-kind="${dimension}" data-entity-id="${r.queryIds[0]}" aria-label="${esc(r.name)}详情">详情 ›</button>` : ''}</li>`;
    })
    .join('');
  more.hidden = rows.length <= 3;
  more.textContent = rankExpanded ? '收起' : `展开全部 ${rows.length} 项`;
}

function applyDimensionView(): void {
  const trendCard = root?.querySelector<HTMLElement>('#report-trend-card');
  const donutCard = root?.querySelector<HTMLElement>('#report-donut-card');
  const rankCard = root?.querySelector<HTMLElement>('#report-rank-card');
  if (!trendCard || !donutCard || !rankCard) return;
  trendCard.hidden = dimension !== 'trend';
  donutCard.hidden = dimension !== 'category';
  rankCard.hidden = dimension === 'trend';
  const titles: Record<Exclude<ReportDimension, 'trend'>, string> = {
    category: '分类排行', account: '账户排行', tag: '标签排行', income: '收入分类', merchant: '商家排行',
  };
  if (dimension !== 'trend') root!.querySelector<HTMLElement>('#rank-title')!.textContent = titles[dimension];
}

function setPeriodButtons(el: HTMLElement): void {
  for (const button of el.querySelectorAll<HTMLElement>('#r-seg button')) {
    const active = button.dataset.p === period;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  }
}

async function pickCustomPeriod(onDone: () => void): Promise<void> {
  const current = await currentRange();
  const fromDate = new Date(current.from);
  const first = openDateWheel({
    initial: { year: fromDate.getFullYear(), month: fromDate.getMonth() + 1, day: fromDate.getDate() },
    onConfirm(fromResult) {
      const toDate = new Date(current.to - 1);
      const second = openDateWheel({
        initial: { year: toDate.getFullYear(), month: toDate.getMonth() + 1, day: toDate.getDate() },
        onConfirm(toResult) {
          const from = new Date(fromResult.year, fromResult.month - 1, fromResult.day).getTime();
          const to = new Date(toResult.year, toResult.month - 1, toResult.day + 1).getTime();
          if (to <= from) { showToast('结束日期不能早于开始日期'); return; }
          customRange = { from, to };
          period = 'custom';
          anchor = new Date(from);
          rankExpanded = false;
          pendingAnim = 'all';
          onDone();
          void refresh();
        },
      });
      document.body.appendChild(second);
    },
  });
  document.body.appendChild(first);
}

/* ── 刷新与渲染 ── */

/** 重触发一次 .r-anim 入场动画（移除→强制回流→重加；reduce 场景由 base.css 全局禁用） */
function animateIn(selectors: string[]): void {
  for (const sel of selectors) {
    const el = root?.querySelector<HTMLElement>(sel);
    if (!el) continue;
    el.classList.remove('r-anim');
    void el.offsetWidth;
    el.classList.add('r-anim');
  }
}

/** 重新取数并整页刷新（带并发令牌，丢弃过期结果） */
async function refresh(): Promise<void> {
  if (!root) return;
  const token = ++refreshToken;
  const anim = pendingAnim;
  pendingAnim = null;
  const data = await loadData();
  if (token !== refreshToken || !root) return;
  activeRange = data.range;
  root.querySelector<HTMLElement>('#r-label')!.textContent = data.label;
  root.querySelector<HTMLElement>('#r-spend')!.textContent = formatFenCny(data.summary.expense);
  root.querySelector<HTMLElement>('#r-income')!.textContent = `¥${formatFen(data.summary.income)}`;
  root.querySelector<HTMLElement>('#r-balance')!.textContent = formatFenCny(data.summary.balance);
  root.querySelector('.r-sum')!.classList.toggle('is-wide',
    [data.summary.income, data.summary.balance].some(value => formatFenCny(value).length > 11));
  renderTrend(data.trend);
  renderDonut(data.cats);
  renderRank(data);
  applyDimensionView();
  if (anim) animateIn(anim === 'rank' ? ['#rank'] : ['.r-sum', '#trend', '.donut-wrap', '#rank']);
}

/** 渲染静态骨架并绑定交互（registerPage render） */
function render(el: HTMLElement): void {
  root = el;
  el.innerHTML = `
    <header class="page-head report-head">
      <h2 class="brand sm">报表</h2>
    </header>
      <div class="seg" id="r-seg" role="tablist" aria-label="统计周期">
        <button data-p="week" role="tab">周</button>
        <button data-p="month" class="active" role="tab" aria-selected="true">月</button>
        <button data-p="year" role="tab">年</button>
        <button data-p="custom" role="tab">自定义</button>
      </div>
    <div class="r-nav">
      <button class="nav-btn" data-nav="-1" aria-label="上一周期">${iconHtml('ic-left')}</button>
      <button class="sub" id="r-label" aria-label="选择报表日期"></button>
      <button class="nav-btn" data-nav="1" aria-label="下一周期">${iconHtml('ic-right')}</button>
    </div>

    <div class="seg report-dim" id="report-dim" role="tablist" aria-label="报表维度">
      <button class="active" data-dimension="trend" role="tab" aria-selected="true">趋势</button>
      <button data-dimension="category" role="tab">分类</button>
      <button data-dimension="account" role="tab">账户</button>
      <button data-dimension="tag" role="tab">标签</button>
      <button data-dimension="income" role="tab">收入</button>
      <button data-dimension="merchant" role="tab">商家</button>
    </div>

    <section class="card">
      <div class="r-sum">
        <button data-summary-type="expense"><p>支出</p><p class="big num" id="r-spend">¥0.00</p></button>
        <button data-summary-type="income"><p>收入</p><p class="mid in num" id="r-income">¥0.00</p></button>
        <button data-summary-type="all"><p>结余</p><p class="mid num" id="r-balance">¥0.00</p></button>
      </div>
    </section>

    <section class="card" id="report-trend-card">
      <h3 class="card-title">收支趋势</h3>
      <div class="chart-box" id="trend"></div>
      <p class="chart-cap" id="trend-cap"></p>
    </section>

    <section class="card" id="report-donut-card" hidden>
      <h3 class="card-title">支出构成</h3>
      <div class="donut-wrap">
        <svg viewBox="0 0 120 120" id="donut-svg" role="img" aria-label="支出分类占比环形图"></svg>
        <ul class="legend" id="donut-legend"></ul>
      </div>
    </section>

    <section class="card" id="report-rank-card" hidden>
      <div class="rank-head">
        <h3 class="card-title" id="rank-title">分类排行</h3>
        <button class="rank-more" id="rank-more" hidden>展开全部</button>
      </div>
      <ul class="rank" id="rank"></ul>
      <p class="tiny" id="rank-note" hidden>一笔多标签分别计入各标签，占比可能合计超过 100%；未打标签的账单不在此列</p>
    </section>`;

  // 周期分段切换
  el.querySelector<HTMLElement>('#r-seg')!.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-p]');
    if (!btn) return;
    const nextPeriod = btn.dataset.p as Period;
    if (nextPeriod === 'custom') {
      void pickCustomPeriod(() => setPeriodButtons(el));
      return;
    }
    period = nextPeriod;
    anchor = new Date(); // 切周期回到当前周期
    if (period === 'month') {
      selectedAccountingMonth = '';
      followsCurrentAccountingMonth = true;
    }
    rankExpanded = false;
    setPeriodButtons(el);
    pendingAnim = 'all';
    void refresh();
  });

  // 周期前后翻页
  el.querySelector('#r-label')!.addEventListener('click', () => {
    if (period === 'custom') { void pickCustomPeriod(() => setPeriodButtons(el)); return; }
    if (period === 'month') {
      void (async () => {
        const selected = selectedAccountingMonth || await getAccountingMonth(anchor.getTime());
        const [year, month] = selected.split('-').map(Number);
        const picker = openMonthWheel({ initial: { year, month }, onConfirm: result => {
          selectedAccountingMonth = `${result.year}-${String(result.month).padStart(2, '0')}`;
          followsCurrentAccountingMonth = false;
          rankExpanded = false;
          void refresh();
        } });
        document.body.appendChild(picker);
      })();
      return;
    }
    const commit = (year: number, month: number, day = 1) => {
      anchor = new Date(year, month - 1, day); rankExpanded = false; void refresh();
    };
    const picker = period === 'week'
      ? openDateWheel({ initial:{year:anchor.getFullYear(),month:anchor.getMonth()+1,day:anchor.getDate()},onConfirm:r=>commit(r.year,r.month,r.day) })
      : openMonthWheel({ initial:{year:anchor.getFullYear(),month:anchor.getMonth()+1},onConfirm:r=>commit(r.year,r.month) });
    document.body.appendChild(picker);
  });
  for (const btn of el.querySelectorAll<HTMLElement>('[data-nav]')) {
    btn.addEventListener('click', () => void shiftPeriod(Number(btn.dataset.nav) as 1 | -1));
  }

  // 维度切换：周期 → 维度 → 单一结果区。
  el.querySelector<HTMLElement>('#report-dim')!.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-dimension]');
    if (!btn) return;
    for (const b of el.querySelectorAll<HTMLElement>('#report-dim button')) {
      b.classList.toggle('active', b === btn);
      b.setAttribute('aria-selected', String(b === btn));
    }
    dimension = btn.dataset.dimension as ReportDimension;
    rankExpanded = false;
    pendingAnim = 'all';
    void refresh();
  });

  el.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const more = target.closest('#rank-more');
    if (more) {
      rankExpanded = !rankExpanded;
      pendingAnim = 'rank';
      void refresh();
      return;
    }

    const range = activeRange;
    if (!range) return;
    const { from, to } = range;
    const label = root?.querySelector<HTMLElement>('#r-label')?.textContent ?? '';
    const summary = target.closest<HTMLElement>('[data-summary-type]');
    if (summary) {
      const type = summary.dataset.summaryType;
      const types = type === 'all' ? undefined : [type as 'expense' | 'income'];
      openLedgerSearch(reportSelectionToLedgerQuery({ from, to, dimension: 'trend', types }), `${label} · ${type === 'expense' ? '支出' : type === 'income' ? '收入' : '全部明细'}`);
      return;
    }

    const trendHit = target.closest<HTMLElement>('[data-drill-from][data-drill-to]');
    if (trendHit) {
      openLedgerSearch(reportSelectionToLedgerQuery({
        from: Number(trendHit.dataset.drillFrom),
        to: Number(trendHit.dataset.drillTo),
        dimension: 'trend',
      }), '趋势明细');
      return;
    }

    const drill = target.closest<HTMLElement>('[data-report-dim][data-report-ids]');
    const entity = target.closest<HTMLElement>('[data-entity-kind]');
    if (entity) { openEntityInsight(entity.dataset.entityKind as 'tag' | 'merchant', Number(entity.dataset.entityId)); return; }
    if (drill) {
      const selectedIds = (drill.dataset.reportIds ?? '').split(',').map(Number).filter(Number.isFinite);
      const selectedDimension = drill.dataset.reportDim as Exclude<ReportDimension, 'trend'>;
      const selection: ReportSelection = { from, to, dimension: selectedDimension, selectedIds };
      const dimLabel = { category: '分类', account: '账户', tag: '标签', income: '收入分类', merchant: '商家' }[selectedDimension];
      openLedgerSearch(reportSelectionToLedgerQuery(selection), `${label} · ${dimLabel}明细`);
    }
  });
  el.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-drill-from], [data-report-dim]');
    if (!target) return;
    event.preventDefault();
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });

  // 数据变化联动刷新（口径/分类/账户名变化也影响展示）
  on('entries-changed', () => void refresh());
  on('settings-changed', () => void refresh());
  on('categories-changed', () => void refresh());
  on('accounts-changed', () => void refresh());

  setPeriodButtons(el);
  for (const button of el.querySelectorAll<HTMLElement>('#report-dim button')) {
    const active = button.dataset.dimension === dimension;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  }
  void refresh();
}

/** 注册报表一级页（覆盖占位页），main.ts 在 mountShell 后调用 */
export function registerReportPage(): void {
  registerPage('page-report', { render, onShow: () => void refresh() });
}
