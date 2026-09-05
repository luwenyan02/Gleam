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
import { iconHtml } from '../../assets/icons';
import { esc } from '../../core/esc';
import { on } from '../../core/store';
import { formatFen, formatFenCny } from '../../core/money';
import * as statsRepo from '../../core/repo/statsRepo';
import { listCategories } from '../../core/repo/categoryRepo';
import { listAccounts } from '../../core/repo/accountRepo';
import { listTags } from '../../core/repo/tagRepo';
import { registerPage } from '../shell/router';
import type { Account, Category } from '../../core/types';

type Period = 'week' | 'month' | 'year';
type RankDim = 'cat' | 'acct' | 'tag';

/** 排行/环形图统一行结构（amount 为分） */
interface RankRow {
  name: string;
  icon: string;
  amount: number;
}

/** 一次刷新所需的全部报表数据 */
interface ReportData {
  label: string;
  summary: statsRepo.Summary;
  trend: { labels: string[]; expense: number[]; incomes?: number[] };
  cats: RankRow[];
  accts: RankRow[];
  tags: RankRow[];
}

/* ── 模块状态 ── */
let period: Period = 'month';
/** 周期锚点（落在所选周期内的任意时刻） */
let anchor = new Date();
let rankDim: RankDim = 'cat';
let root: HTMLElement | undefined;
/** 并发刷新令牌：仅最后一次 refresh 的结果允许上屏 */
let refreshToken = 0;
/** 待应用的切换过渡范围：'all'=周期切换整页内容淡入，'rank'=仅排行卡 */
let pendingAnim: 'all' | 'rank' | null = null;

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

/** 元整数展示（原型 fmt0 语义）：丢弃分位小数 */
function fmtYuan0(fen: number): string {
  return formatFen(fen).split('.')[0];
}

/** 当前周期的时间范围 [from, to) */
function currentRange(): { from: number; to: number } {
  if (period === 'week') return statsRepo.weekRange(anchor.getTime());
  if (period === 'year') return statsRepo.yearRange(anchor.getFullYear());
  return statsRepo.monthRange(monthStr(anchor));
}

function monthStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** 周期标签：'8月2日 – 8月8日' / '2026年8月' / '2026年' */
function periodLabel(): string {
  if (period === 'week') {
    const { from, to } = statsRepo.weekRange(anchor.getTime());
    const a = new Date(from);
    const b = new Date(to - DAY);
    return `${a.getMonth() + 1}月${a.getDate()}日 – ${b.getMonth() + 1}月${b.getDate()}日`;
  }
  if (period === 'year') return `${anchor.getFullYear()}年`;
  return `${anchor.getFullYear()}年${anchor.getMonth() + 1}月`;
}

/** 周期前后翻页（dir = ±1） */
function shiftPeriod(dir: 1 | -1): void {
  const d = new Date(anchor);
  if (period === 'week') d.setDate(d.getDate() + dir * 7);
  else if (period === 'month') d.setMonth(d.getMonth() + dir, 1);
  else d.setFullYear(d.getFullYear() + dir, d.getMonth(), 1);
  anchor = d;
  pendingAnim = 'all';
  void refresh();
}

/* ── 数据装载 ── */

/** 趋势数据：周=7 天单柱；月=近 6 个月双柱；年=12 个月双柱 */
async function loadTrend(): Promise<ReportData['trend']> {
  if (period === 'week') {
    const { from } = statsRepo.weekRange(anchor.getTime());
    const labels: string[] = [];
    const expense: number[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(from + i * DAY);
      labels.push(`${d.getMonth() + 1}/${d.getDate()}`);
      const s = await statsRepo.rangeSummary(from + i * DAY, from + (i + 1) * DAY);
      expense.push(s.expense);
    }
    return { labels, expense };
  }
  const months: Date[] = [];
  if (period === 'month') {
    for (let i = 5; i >= 0; i--) months.push(new Date(anchor.getFullYear(), anchor.getMonth() - i, 1));
  } else {
    for (let m = 0; m < 12; m++) months.push(new Date(anchor.getFullYear(), m, 1));
  }
  const labels: string[] = [];
  const expense: number[] = [];
  const incomes: number[] = [];
  for (const d of months) {
    labels.push(`${d.getMonth() + 1}月`);
    const s = await statsRepo.monthSummary(monthStr(d));
    expense.push(s.expense);
    incomes.push(s.income);
  }
  return { labels, expense, incomes };
}

/** 装载当前周期全部数据（汇总 + 趋势 + 三维排行） */
async function loadData(): Promise<ReportData> {
  const { from, to } = currentRange();
  const [summary, trend, breakdown, acctRank, tagRank, expenseCats, accounts, tags] = await Promise.all([
    statsRepo.rangeSummary(from, to),
    loadTrend(),
    statsRepo.categoryBreakdown(from, to),
    statsRepo.accountRanking(from, to),
    statsRepo.tagRanking(from, to),
    listCategories('expense'),
    listAccounts(),
    listTags(),
  ]);
  const catMap = new Map<number, Category>(expenseCats.map((c) => [c.id, c]));
  const acctMap = new Map<number, Account>(accounts.map((a) => [a.id, a]));
  const tagMap = new Map(tags.map((t) => [t.id, t.name]));
  return {
    label: periodLabel(),
    summary,
    trend,
    cats: breakdown.map(({ categoryId, amount }) => ({
      name: catMap.get(categoryId)?.name ?? '未分类',
      icon: catMap.get(categoryId)?.icon ?? 'ic-coin',
      amount,
    })),
    accts: acctRank.map(({ accountId, amount }) => ({
      name: acctMap.get(accountId)?.name ?? '已删除账户',
      icon: GROUP_ICONS[acctMap.get(accountId)?.group ?? 'cash'],
      amount,
    })),
    tags: tagRank.map(({ tagId, amount }) => ({ name: tagMap.get(tagId) ?? '已删除标签', icon: 'ic-tag', amount })),
  };
}

/* ── SVG 绘制（移植原型逻辑） ── */

/** 收支趋势柱状图（原型 renderTrend；柱宽按柱数自适应以容纳 12 个月） */
function renderTrend(d: ReportData['trend']): void {
  const box = root!.querySelector<HTMLElement>('#trend')!;
  const cap = root!.querySelector<HTMLElement>('#trend-cap')!;
  if (!d.expense.some((v) => v > 0) && !(d.incomes ?? []).some((v) => v > 0)) {
    box.innerHTML = '<div class="chart-empty">该周期暂无收支记录</div>';
    cap.textContent = '';
    return;
  }
  const W = 336, H = 168, base = 134, maxH = 100;
  const max = Math.max(...d.expense, ...(d.incomes ?? [0]));
  const n = d.labels.length, slot = W / n;
  const dw = Math.min(12, slot / 2 - 2);   // 双柱单根宽
  const sw = Math.min(22, slot - 8);       // 单柱宽
  let s = '';
  for (const k of [0, 0.5, 1]) {
    s += `<line x1="0" y1="${base - maxH * k}" x2="${W}" y2="${base - maxH * k}" stroke="var(--border)" stroke-width="1"${k ? ' stroke-dasharray="3 4"' : ''}/>`;
  }
  d.labels.forEach((lb, i) => {
    const cx = slot * i + slot / 2;
    const eh = Math.max(3, (d.expense[i] / max) * maxH);
    if (d.incomes) {
      const ih = Math.max(3, (d.incomes[i] / max) * maxH);
      s += `<rect x="${(cx - dw - 1).toFixed(1)}" y="${(base - eh).toFixed(1)}" width="${dw.toFixed(1)}" height="${eh.toFixed(1)}" rx="3" fill="var(--c1)"/>`;
      s += `<rect x="${(cx + 1).toFixed(1)}" y="${(base - ih).toFixed(1)}" width="${dw.toFixed(1)}" height="${ih.toFixed(1)}" rx="3" fill="var(--c4)"/>`;
    } else {
      s += `<rect x="${(cx - sw / 2).toFixed(1)}" y="${(base - eh).toFixed(1)}" width="${sw.toFixed(1)}" height="${eh.toFixed(1)}" rx="4" fill="var(--c1)"/>`;
    }
    s += `<text x="${cx.toFixed(1)}" y="${base + 18}" text-anchor="middle" font-size="${n > 8 ? 8.5 : 10}" fill="var(--muted)">${lb}</text>`;
  });
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="收支趋势柱状图">${s}</svg>`;
  cap.textContent = d.incomes ? '深色为支出 · 浅色为收入（单位：元）' : '每日支出（单位：元）';
}

/** 支出构成环形图（原型 renderDonut；stroke-dasharray 分段）。超过 6 类聚合为「其他」 */
function renderDonut(cats: RankRow[]): void {
  const svg = root!.querySelector<HTMLElement>('#donut-svg')!;
  const legend = root!.querySelector<HTMLElement>('#donut-legend')!;
  if (cats.length === 0) {
    svg.innerHTML = `<circle cx="60" cy="60" r="48" fill="none" stroke="var(--border)" stroke-width="15"/>
      <text x="60" y="64" text-anchor="middle" font-size="10" fill="var(--faint)">暂无支出</text>`;
    legend.innerHTML = '<li class="donut-empty">记录支出后这里会展示分类占比</li>';
    return;
  }
  let rows = cats;
  if (cats.length > 6) {
    const rest = cats.slice(5).reduce((sum, r) => sum + r.amount, 0);
    rows = [...cats.slice(0, 5), { name: '其他', icon: 'ic-coin', amount: rest }];
  }
  const total = rows.reduce((sum, r) => sum + r.amount, 0);
  const C = 2 * Math.PI * 48;
  let acc = 0, s = '';
  rows.forEach((r, i) => {
    const len = (r.amount / total) * C;
    s += `<circle cx="60" cy="60" r="48" fill="none" stroke="var(--c${i + 1})" stroke-width="15" stroke-dasharray="${Math.max(0, len - 2.4).toFixed(2)} ${(C - len + 2.4).toFixed(2)}" stroke-dashoffset="${(-acc).toFixed(2)}" transform="rotate(-90 60 60)"/>`;
    acc += len;
  });
  s += '<text x="60" y="56" text-anchor="middle" font-size="9" fill="var(--muted)">总支出</text>';
  s += `<text x="60" y="72" text-anchor="middle" font-size="13" font-weight="700" fill="var(--fg)" font-family="var(--font-mono)">¥${fmtYuan0(total)}</text>`;
  svg.innerHTML = s;
  legend.innerHTML = rows
    .map((r, i) => `<li><span class="dot" style="background:var(--c${i + 1})"></span>${esc(r.name)}<b class="num">${((r.amount / total) * 100).toFixed(1)}%</b></li>`)
    .join('');
}

/** 排行卡（原型 renderRank）：分类/账户/标签三维度，占比以周期总支出为基数 */
function renderRank(data: ReportData): void {
  const list = root!.querySelector<HTMLElement>('#rank')!;
  const note = root!.querySelector<HTMLElement>('#rank-note')!;
  const rows = rankDim === 'acct' ? data.accts : rankDim === 'tag' ? data.tags : data.cats;
  note.hidden = rankDim !== 'tag';
  if (rows.length === 0) {
    list.innerHTML = `<li class="rank-empty">${rankDim === 'tag' ? '该周期没有打了标签的支出' : '该周期暂无支出记录'}</li>`;
    return;
  }
  const base = data.summary.expense || rows.reduce((sum, r) => sum + r.amount, 0);
  list.innerHTML = rows
    .map((r, i) => {
      const pct = base > 0 ? (r.amount / base) * 100 : 0;
      return `<li class="rank-row">
        <span class="e-ic sm">${iconHtml(r.icon, 17)}</span>
        <div class="rank-main">
          <div class="rank-top"><span>${rankDim === 'tag' ? '#' + esc(r.name) : esc(r.name)}</span><span class="num">¥${formatFen(r.amount)}</span></div>
          <div class="rank-bar"><i style="width:${Math.min(100, pct).toFixed(1)}%;background:var(--c${(i % 6) + 1})"></i></div>
        </div>
        <span class="rank-pct num">${pct.toFixed(1)}%</span></li>`;
    })
    .join('');
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
  root.querySelector<HTMLElement>('#r-label')!.textContent = data.label;
  root.querySelector<HTMLElement>('#r-spend')!.textContent = `¥${formatFen(data.summary.expense)}`;
  root.querySelector<HTMLElement>('#r-income')!.textContent = `¥${formatFen(data.summary.income)}`;
  root.querySelector<HTMLElement>('#r-balance')!.textContent = formatFenCny(data.summary.balance);
  renderTrend(data.trend);
  renderDonut(data.cats);
  renderRank(data);
  if (anim) animateIn(anim === 'rank' ? ['#rank'] : ['.r-sum', '#trend', '.donut-wrap', '#rank']);
}

/** 渲染静态骨架并绑定交互（registerPage render） */
function render(el: HTMLElement): void {
  root = el;
  el.innerHTML = `
    <header class="page-head">
      <div>
        <h2 class="brand sm">报表</h2>
        <div class="r-nav">
          <button class="nav-btn" data-nav="-1" aria-label="上一周期">${iconHtml('ic-left')}</button>
          <p class="sub" id="r-label"></p>
          <button class="nav-btn" data-nav="1" aria-label="下一周期">${iconHtml('ic-right')}</button>
        </div>
      </div>
      <div class="seg" id="r-seg" role="tablist" aria-label="统计周期">
        <button data-p="week" role="tab">周</button>
        <button data-p="month" class="active" role="tab" aria-selected="true">月</button>
        <button data-p="year" role="tab">年</button>
      </div>
    </header>

    <section class="card">
      <div class="r-sum">
        <div><p>支出</p><p class="big num" id="r-spend">¥0.00</p></div>
        <div><p>收入</p><p class="mid in num" id="r-income">¥0.00</p></div>
        <div><p>结余</p><p class="mid num" id="r-balance">¥0.00</p></div>
      </div>
    </section>

    <section class="card">
      <h3 class="card-title">收支趋势</h3>
      <div class="chart-box" id="trend"></div>
      <p class="chart-cap" id="trend-cap"></p>
    </section>

    <section class="card">
      <h3 class="card-title">支出构成</h3>
      <div class="donut-wrap">
        <svg viewBox="0 0 120 120" id="donut-svg" role="img" aria-label="支出分类占比环形图"></svg>
        <ul class="legend" id="donut-legend"></ul>
      </div>
    </section>

    <section class="card">
      <div class="rank-head">
        <h3 class="card-title">排行</h3>
        <div class="seg mini" id="rank-dim" role="tablist" aria-label="排行维度">
          <button class="active" data-d="cat" role="tab" aria-selected="true">分类</button>
          <button data-d="acct" role="tab">账户</button>
          <button data-d="tag" role="tab">标签</button>
        </div>
      </div>
      <ul class="rank" id="rank"></ul>
      <p class="tiny" id="rank-note" hidden>标签排行只统计打了标签的支出 · 未打标签的账单不在此列</p>
    </section>`;

  // 周期分段切换
  el.querySelector<HTMLElement>('#r-seg')!.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-p]');
    if (!btn) return;
    for (const b of el.querySelectorAll<HTMLElement>('#r-seg button')) {
      b.classList.toggle('active', b === btn);
      b.setAttribute('aria-selected', String(b === btn));
    }
    period = btn.dataset.p as Period;
    anchor = new Date(); // 切周期回到当前周期
    pendingAnim = 'all';
    void refresh();
  });

  // 周期前后翻页
  for (const btn of el.querySelectorAll<HTMLElement>('[data-nav]')) {
    btn.addEventListener('click', () => shiftPeriod(Number(btn.dataset.nav) as 1 | -1));
  }

  // 排行维度切换
  el.querySelector<HTMLElement>('#rank-dim')!.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-d]');
    if (!btn) return;
    for (const b of el.querySelectorAll<HTMLElement>('#rank-dim button')) {
      b.classList.toggle('active', b === btn);
      b.setAttribute('aria-selected', String(b === btn));
    }
    rankDim = btn.dataset.d as RankDim;
    pendingAnim = 'rank';
    void refresh();
  });

  // 数据变化联动刷新（口径/分类/账户名变化也影响展示）
  on('entries-changed', () => void refresh());
  on('settings-changed', () => void refresh());
  on('categories-changed', () => void refresh());
  on('accounts-changed', () => void refresh());

  void refresh();
}

/** 注册报表一级页（覆盖占位页），main.ts 在 mountShell 后调用 */
export function registerReportPage(): void {
  registerPage('page-report', { render, onShow: () => void refresh() });
}
