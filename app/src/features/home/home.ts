import { entryDisplayAmount } from '../../core/entryAmount';
/**
 * 拾光 · 首页流水时间线（PRD 4.2）
 * 页头（日期与节气）、月度总览卡（与预算中心同源 budgetUsage）、快捷五宫格、
 * 按日分组流水（账单 + 生活记录混排、补账按 occurredAt 归组、滚动分页加载更早）。
 * 消费 settingsRepo 'home.modules' 的模块显隐配置（自定义设置页归 M2-D）。
 */
import { iconHtml } from '../../assets/icons';
import { esc } from '../../core/esc';
import { formatFen, formatFenCny } from '../../core/money';
import { on } from '../../core/store';
import { type Category, type LifeNote } from '../../core/types';
import type { LedgerItem } from '../../core/ledgerEvents';
import { summarizeLedgerEntries } from '../../core/ledgerQuery';
import { listEntries, getEntry, dayKey } from '../../core/repo/entryRepo';
import { listCategories, listExpenseTree } from '../../core/repo/categoryRepo';
import { listAccounts } from '../../core/repo/accountRepo';
import { listLifeNotes } from '../../core/repo/lifeRepo';
import { listTemplates } from '../../core/repo/templateRepo';
import { getSetting } from '../../core/repo/settingsRepo';
import { monthSummary, budgetUsage, ledgerEntriesInRange } from '../../core/repo/statsRepo';
import { getBudget } from '../../core/repo/budgetRepo';
import { registerPage, openSubpage } from '../shell/router';
import { showToast } from '../shell/toast';
import { openEntrySheet } from '../entry/entrySheet';
import {
  bindEntrySwipeActions, entrySwipeActionsHtml, openEntryDetail, runEntryQuickAction,
  type EntryQuickAction,
} from '../detail/detail';
import './home.css';
import { getHomeLayout, HOME_SERVICES, type HomeService } from '../../core/repo/homeLayoutRepo';
import { openPickList } from '../../shared/pickList';
import { entryRowText } from '../detail/entryRowText';
import { listInAppReminders } from '../../core/notify';
import { accountingMonthRange, getAccountingMonth } from '../../core/repo/periodRepo';

import { bindSpendingRhythm, refreshSpendingRhythm, spendingRhythmHtml } from './spendingRhythm';

const PAGE = 40;

let root: HTMLElement | null = null;
let limit = PAGE;
let exhausted = false;
let loading = false;
let refreshTimer = 0;
let refreshPending = false;
let paginationPending = false;
let dayTimer = 0;

/** 注册首页（main.ts 调用一次） */
export function initHome(): void {
  registerPage('page-home', {
    render(el) {
      root = el;
      limit = PAGE;
      renderSkeleton(el);
    },
    onShow() { scheduleRefresh(); },
  });

  // 数据变化时去抖刷新（仅首页已挂载时）
  const events = ['entries-changed', 'accounts-changed', 'categories-changed',
    'budgets-changed', 'credit-changed', 'life-changed', 'settings-changed'] as const;
  for (const ev of events) on(ev, scheduleRefresh);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) scheduleRefresh();
  });
}

function scheduleRefresh(): void {
  if (!root?.isConnected) return;
  window.clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(() => void refresh(), 50);
}

/* ── 骨架与事件 ───────────────────── */

function renderSkeleton(el: HTMLElement): void {
  el.innerHTML = `
    <header class="page-head">
      <div>
        <h1 class="brand">拾光</h1>
        <p class="sub">${headSub()}</p>
      </div>
      <div style="display:flex;gap:8px">
        <button class="icon-btn" id="btn-home-edit" aria-label="自定义首页模块">${iconHtml('ic-set')}</button>
        <button class="icon-btn" id="btn-search" aria-label="搜索流水与生活记录">${iconHtml('ic-search')}</button>
      </div>
    </header>

    <section class="card home-reminders" id="hm-reminders" aria-label="应用内提醒" hidden></section>

    <section class="month-card" id="hm-month" aria-label="本期收支总览" hidden>
      <div class="mc-overview overview-art">
        <div class="mc-heading"><p class="mc-label"></p><span class="mc-unit">单位：元</span></div>
        <p class="mc-amt num"><span id="m-spend">0.00</span></p>
      </div>
      <div class="mc-row">
        <div><p>收入</p><p class="num" id="m-income"></p></div>
        <div><p>结余</p><p class="num" id="m-balance"></p></div>
        <div><p>预算剩余</p><p class="num" id="m-remain"></p></div>
      </div>
    </section>

    <nav class="card quick-row" id="hm-quick" aria-label="快捷功能" hidden>
      <button class="qa" data-qa="note"><span class="qa-ic">${iconHtml('ic-bolt')}</span>速记</button>
      <button class="qa" data-qa="detail"><span class="qa-ic">${iconHtml('ic-file')}</span>明细</button>
      <button class="qa" data-qa="cal"><span class="qa-ic">${iconHtml('ic-cal')}</span>日历</button>
      <button class="qa" data-qa="cycle"><span class="qa-ic">${iconHtml('ic-repeat')}</span>周期账</button>
      <button class="qa" data-qa="ai"><span class="qa-ic">${iconHtml('ic-ai')}</span>AI 记账</button>
    </nav>

    ${spendingRhythmHtml()}

    <div id="hm-days"></div>
    <p class="tiny hm-more" id="hm-more"></p>`;

  bindSpendingRhythm(el);
  el.querySelector('#btn-home-edit')!.addEventListener('click', () => openSubpage('sp-home-custom'));
  el.querySelector('#btn-search')!.addEventListener('click', () => openSubpage('sp-search'));

  el.querySelector('#hm-reminders')!.addEventListener('click', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('[data-reminder-route]');
    if (row?.dataset.reminderRoute) openSubpage(row.dataset.reminderRoute);
  });

  el.querySelector('#hm-quick')!.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-qa]');
    if (!btn) return;
    const act = btn.dataset.qa!;
    if (act === 'all') {
      openPickList({ container: el, title: '全部功能', items: HOME_SERVICES.map(service => ({ value: service.key, label: service.name, icon: service.icon })), onPick: key => void openService(key as HomeService) });
    } else void openService(act as HomeService);
  });

  // 空状态可直接记账；账单条目点击进入编辑抽屉
  el.querySelector('#hm-days')!.addEventListener('click', (e) => {
    const emptyAction = (e.target as HTMLElement).closest<HTMLElement>('[data-empty-entry]');
    if (emptyAction) { void openEntrySheet(); return; }
    const action = (e.target as HTMLElement).closest<HTMLElement>('[data-entry-action]');
    const swipeRow = (e.target as HTMLElement).closest<HTMLElement>('[data-entry-row]');
    if (swipeRow?.dataset.swipeSuppress === 'true') return;
    if (action && swipeRow) {
      if (action.getAttribute('aria-disabled') === 'true') { showToast('仅普通支出账单支持退款'); return; }
      void getEntry(Number(swipeRow.dataset.entryRow)).then((entry) => {
        if (entry) void runEntryQuickAction(action.dataset.entryAction as EntryQuickAction, entry);
      });
      return;
    }
    const item = (e.target as HTMLElement).closest<HTMLElement>('[data-entry]');
    if (item) openEntryDetail(Number(item.dataset.entry));
  });
  bindEntrySwipeActions(el.querySelector<HTMLElement>('#hm-days')!);

  // 滚动到底加载更早（.page 即滚动容器）
  el.addEventListener('scroll', () => loadMore(el));

  void refresh();
}

async function openService(key: HomeService): Promise<void> {
  if (key !== 'note') {
    const service = HOME_SERVICES.find(s => s.key === key);
    if (service) openSubpage(service.route);
    return;
  }
  const templates = await listTemplates();
  if (!templates.length) { openSubpage('sp-template-manage'); return; }
  const container = root!.closest<HTMLElement>('.app') ?? root!;
  openPickList({ container, title: '选择速记模板', searchable: true,
    searchAction: { icon: 'ic-set', label: '速记模板设置', onClick: () => openSubpage('sp-template-manage') },
    items: templates.map(t => ({ value: t.id, label: t.name, note: formatFenCny(t.amount) })),
    onPick: id => { void openEntrySheet({ templateId: Number(id) }); },
  });
}

/* ── 数据刷新 ─────────────────────── */

function loadMore(el: HTMLElement): void {
  if (root !== el || !el.isConnected || el.inert || !el.classList.contains('is-active')
    || !el.clientHeight || el.scrollTop + el.clientHeight < el.scrollHeight - 240) {
    paginationPending = false;
    return;
  }
  // 时间线可能先于总览和提醒完成；保留单次触底意图，不在查询中途改变 limit。
  if (loading) { paginationPending = true; return; }
  if (exhausted) return;
  limit += PAGE;
  void refresh();
}

async function refresh(): Promise<void> {
  const el = root;
  if (!el?.isConnected) return;
  if (loading) { refreshPending = true; return; }
  loading = true;
  try {
    const [mods, layout] = await Promise.all([getSetting('home.modules'), getHomeLayout()]);
    el.querySelector<HTMLElement>('#hm-month')!.hidden = !mods.month;
    const nav = el.querySelector<HTMLElement>('#hm-quick')!;
    const nextKeys = [...layout.quick, 'all'];
    const currentKeys = [...nav.children].map(button => (button as HTMLElement).dataset.qa);
    // 初次显示前补齐已配置的入口；同布局刷新不移除按钮，保留焦点与正在进行的操作。
    if (currentKeys.length !== nextKeys.length || currentKeys.some((key, index) => key !== nextKeys[index])) {
      nav.innerHTML = layout.quick.map(key => {
        const service = HOME_SERVICES.find(s => s.key === key)!;
        return `<button class="qa" data-qa="${key}"><span class="qa-ic">${iconHtml(service.icon)}</span>${service.name}</button>`;
      }).join('') + `<button class="hm-all" data-qa="all"><span class="qa-ic">${iconHtml('ic-file')}</span>全部</button>`;
    }
    nav.style.gridTemplateColumns = `repeat(${Math.max(1, layout.quick.length + 1)}, minmax(44px, 1fr))`;
    nav.hidden = !mods.quick;
    const showRhythm = mods.rhythm !== false;
    el.querySelector<HTMLElement>('#hm-rhythm')!.hidden = !showRhythm;
    await Promise.all([
      mods.month ? refreshMonthCard(el) : Promise.resolve(),
      showRhythm ? refreshSpendingRhythm(el) : Promise.resolve(),
      refreshReminders(el),
      refreshTimeline(el, mods.today, mods.past),
    ]);
    for (const [index, key] of layout.order.entries()) {
      const selectors = { month: '#hm-month', quick: '#hm-quick', rhythm: '#hm-rhythm', today: '#hm-today', past: '.hm-past' };
      for (const node of el.querySelectorAll<HTMLElement>(selectors[key])) node.style.order = String(index);
    }
  } finally {
    loading = false;
    window.clearTimeout(dayTimer);
    const now = new Date();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
    dayTimer = window.setTimeout(scheduleRefresh, Math.max(1000, midnight - Date.now()));
    if (refreshPending) {
      refreshPending = false;
      void refresh();
    } else if (paginationPending) {
      paginationPending = false;
      // 刷新后再检查位置与 exhausted；用户已滚离底部或切页时不继续分页。
      loadMore(el);
    }
  }
}

async function refreshReminders(el: HTMLElement): Promise<void> {
  const container = el.querySelector<HTMLElement>('#hm-reminders')!;
  const reminders = await listInAppReminders();
  if (!reminders.length) {
    container.hidden = true;
    container.innerHTML = '';
    return;
  }
  container.hidden = false;
  container.innerHTML = `
    <div class="home-reminder-head"><h3>提醒</h3><span>${reminders.length} 项待处理</span></div>
    ${reminders.map((reminder) => `
      <button class="row" data-reminder-route="${reminder.route}">
        <span class="e-ic sm">${iconHtml(reminder.icon, 17)}</span>
        <span class="e-main"><span class="e-title">${esc(reminder.title)}</span><span class="e-meta">${esc(reminder.body)}</span></span>
        <span class="chev">${iconHtml('ic-right', 15)}</span>
      </button>`).join('')}`;
}

/** 月度总览卡：与预算中心严格同源（statsRepo.budgetUsage / budgetRepo.getBudget） */
async function refreshMonthCard(el: HTMLElement): Promise<void> {
  const month = await getAccountingMonth();
  const [sum, budget, usage, range] = await Promise.all([
    monthSummary(month), getBudget(month), budgetUsage(month), accountingMonthRange(month),
  ]);
  const from = new Date(range.from);
  const to = new Date(range.to);
  to.setDate(to.getDate() - 1);
  el.querySelector('.mc-label')!.textContent = `${from.getMonth() + 1}月${from.getDate()}日–${to.getMonth() + 1}月${to.getDate()}日支出`;
  el.querySelector('#m-spend')!.textContent = formatFen(sum.expense);
  el.querySelector('#m-income')!.textContent = formatFen(sum.income);
  el.querySelector('#m-balance')!.textContent = formatFen(sum.balance);
  if (budget && budget.totalLimit > 0) {
    const remain = budget.totalLimit - usage.totalUsed;
    el.querySelector('#m-remain')!.textContent = formatFen(remain);
  } else {
    el.querySelector('#m-remain')!.textContent = '未设置';
  }
  const values = [...el.querySelectorAll<HTMLElement>('.mc-row .num')];
  el.querySelector('.mc-row')!.classList.toggle('is-wide', values.some(value => (value.textContent?.length ?? 0) > 11));
}

/* ── 时间线 ───────────────────────── */

type TimelineItem =
  | { kind: 'entry'; ts: number; entry: LedgerItem }
  | { kind: 'life'; ts: number; note: LifeNote };

async function refreshTimeline(el: HTMLElement, showToday: boolean, showPast: boolean): Promise<void> {
  const pageLimit = limit;
  const [entries, cats, tree, accounts, countAsIncome] = await Promise.all([
    listEntries({ limit: pageLimit }),
    listCategories('income'), listExpenseTree(), listAccounts(true),
    getSetting('reimburse.countAsIncome'),
  ]);
  const oldestTs = entries.length ? entries[entries.length - 1].occurredAt : 0;
  const boundaryFrom = oldestTs ? startOfDay(oldestTs) : 0;
  // 事件查询会补齐边界日的全部实体；只有边界日前仍有账单时才需要继续分页。
  const hasEarlierEntries = entries.length >= pageLimit && boundaryFrom > 0
    ? (await listEntries({ to: boundaryFrom, limit: 1 })).length > 0
    : false;
  exhausted = !hasEarlierEntries;

  const catMap = new Map<number, Category>();
  for (const cat of cats) catMap.set(cat.id, cat);
  for (const g of tree) {
    catMap.set(g.parent.id, g.parent);
    for (const ch of g.children) catMap.set(ch.id, ch);
  }
  const acctNames = new Map(accounts.map((a) => [a.id, a.name]));

  // 生活记录与统计事件混排：边界日完整载入，存在更早实体时再向前分页。
  const from = hasEarlierEntries ? boundaryFrom : 0;
  const [notes, ledgerEntries] = await Promise.all([
    listLifeNotes({ from }),
    ledgerEntriesInRange(from, Infinity, countAsIncome),
  ]);
  // 边界日补齐后，下次分页从已展示的原始账单数继续；不计报销事件或生活记录。
  limit = Math.max(pageLimit, ledgerEntries.filter(entry => entry.kind === 'entry').length);

  let items: TimelineItem[] = [
    ...ledgerEntries.map((entry): TimelineItem => ({ kind: 'entry', ts: entry.occurredAt, entry })),
    ...notes.map((note): TimelineItem => ({ kind: 'life', ts: note.occurredAt, note })),
  ];
  items.sort((a, b) => b.ts - a.ts);

  // 按日分组（补账账单按 occurredAt 归组，不进「今天」）
  const groups = new Map<string, TimelineItem[]>();
  for (const it of items) {
    const key = dayKey(it.ts);
    let list = groups.get(key);
    if (!list) { list = []; groups.set(key, list); }
    list.push(it);
  }
  const todayKey = dayKey(Date.now());
  if (showToday && !groups.has(todayKey)) groups.set(todayKey, []);

  const days = [...groups.keys()].sort((a, b) => (a < b ? 1 : -1));
  const html = days.map((key) => {
    const isToday = key === todayKey;
    if (isToday ? !showToday : !showPast) return '';
    const list = groups.get(key)!;
    const summary = summarizeLedgerEntries(
      list.filter((it): it is Extract<TimelineItem, { kind: 'entry' }> => it.kind === 'entry')
        .map((it) => it.entry),
      { reimburseMode: countAsIncome ? 'income' : 'offset' },
    );
    const { expense, income } = summary;
    const sums: string[] = [];
    if (expense) sums.push(`支出 ${formatFenCny(expense)}`);
    if (income) sums.push(`收入 ${formatFenCny(income)}`);
    const body = list.length
      ? `<div class="card list">${list.map((it) =>
          it.kind === 'entry'
            ? entryHtml(it.entry, catMap, acctNames)
            : lifeHtml(it.note)).join('')}</div>`
      : `<div class="card list home-empty">
          <span class="e-ic">${iconHtml('ic-pen', 18)}</span>
          <div><p class="e-title">今天还没有记录</p><p class="e-meta">花了什么、赚了什么，随手记下就好</p></div>
          <button class="chip" data-empty-entry>记一笔</button>
        </div>`;
    return `
      <section aria-label="${dayTitle(key)}的记录"${isToday ? ' id="hm-today"' : ' class="hm-past"'}>
        <header class="day"><h3>${isToday ? '今天 · ' : ''}${dayTitle(key)}</h3><p class="day-sum num">${sums.join(' · ')}</p></header>
        ${body}
      </section>`;
  }).join('');

  el.querySelector('#hm-days')!.innerHTML =
    (showToday || showPast) ? html : '<p class="tiny" style="text-align:center;padding:20px 0">流水模块已隐藏 · 可在右上角自定义首页</p>';
  el.querySelector('#hm-more')!.textContent = exhausted
    ? (items.length ? '已展示全部流水' : '')
    : '下拉加载更早的流水…';
}

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function dayTitle(key: string): string {
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const md = `${m}月${d}日 ${WEEK[date.getDay()]}`;
  return y === new Date().getFullYear() ? md : `${y}年${md}`;
}

/* ── 条目渲染 ─────────────────────── */

function entryHtml(
  entry: LedgerItem,
  catMap: Map<number, Category>,
  acctNames: Map<number, string>,
): string {
  const text = entryRowText(entry, catMap, acctNames, { hideDate: true });
  const note = text.note ? ` <span class="e-sub">· ${esc(text.note)}</span>` : '';
  const inflow = entryDisplayAmount(entry) >= 0;
  const transfer = entry.type === 'transfer';
  return swipeEntry(entry, `<span class="e-ic${text.neutral ? ' neutral' : ''}">${iconHtml(text.icon)}</span>
    <div class="e-main"><p class="e-title">${esc(text.title)}${note}</p><p class="e-meta">${esc(text.meta)}</p></div>
    <p class="e-amt num${transfer ? '' : inflow ? ' in' : ' out'}">${formatFen(entryDisplayAmount(entry), { sign: !transfer })}</p>`);
}

function swipeEntry(entry: LedgerItem, content: string): string {
  if (entry.kind === 'reimbursement') {
    return `<div data-entry-row="${entry.id}" data-reimbursement>
      <article class="entry entry-swipe-content" data-entry="${entry.id}" role="button" tabindex="0">${content}</article>
    </div>`;
  }
  return `<div class="entry-swipe" data-entry-row="${entry.id}">
    ${entrySwipeActionsHtml(entry)}
    <article class="entry entry-swipe-content" data-entry="${entry.id}">${content}</article>
  </div>`;
}

const LIFE_META: Record<LifeNote['kind'], { icon: string; label: string }> = {
  diary: { icon: 'ic-pen', label: '日记' },
  photo: { icon: 'ic-camera', label: '照片' },
  habit: { icon: 'ic-pulse', label: '打卡' },
};

function lifeHtml(note: LifeNote): string {
  const meta = LIFE_META[note.kind];
  const title = note.title || meta.label;
  const body = note.body ? ` <span class="e-sub">· ${esc(snippet(note.body))}</span>` : '';
  const extra = note.mood ? ` · 心情 ${esc(note.mood)}` : note.linkedAmount ? ` · 关联支出 ${formatFenCny(note.linkedAmount)}` : '';
  return `<article class="entry">
    <span class="e-ic life">${iconHtml(meta.icon)}</span>
    <div class="e-main"><p class="e-title">${esc(title)}${body}</p><p class="e-meta">生活记录${extra}</p></div></article>`;
}

function snippet(text: string): string {
  return text.length > 14 ? `${text.slice(0, 14)}…` : text;
}

/* ── 页头日期与节气 ───────────────── */

function headSub(): string {
  const d = new Date();
  return `${d.getMonth() + 1}月${d.getDate()}日 · ${WEEK[d.getDay()]} · ${solarTerm(d)}`;
}

const TERM_NAMES = ['小寒', '大寒', '立春', '雨水', '惊蛰', '春分', '清明', '谷雨', '立夏', '小满',
  '芒种', '夏至', '小暑', '大暑', '立秋', '处暑', '白露', '秋分', '寒露', '霜降', '立冬', '小雪', '大雪', '冬至'];
// 21 世纪节气日期近似公式 C 值（[Y×0.2422+C]−L）
const TERM_C = [5.4055, 20.12, 3.87, 18.73, 5.63, 20.646, 4.81, 20.1, 5.52, 21.04, 5.678, 21.37,
  7.108, 22.83, 7.5, 23.13, 7.646, 23.042, 8.318, 23.438, 7.438, 22.36, 7.18, 21.94];

function termDay(year: number, n: number): number {
  const y = year % 100;
  const leap = n < 4 ? Math.floor((y - 1) / 4) : Math.floor(y / 4);
  return Math.floor(y * 0.2422 + TERM_C[n]) - leap;
}

/** 当前所处节气（当日或最近一个已到的节气） */
function solarTerm(d: Date): string {
  const m = d.getMonth(); // 0-11
  const day = d.getDate();
  const first = m * 2;
  if (day >= termDay(d.getFullYear(), first + 1)) return TERM_NAMES[first + 1];
  if (day >= termDay(d.getFullYear(), first)) return TERM_NAMES[first];
  // 未到本月第一个节气：仍处上月第二个节气
  return TERM_NAMES[(first + 23) % 24];
}
