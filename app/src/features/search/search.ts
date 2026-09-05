/**
 * 拾光 · 全局搜索（重做版，参考挖财记账 UX）
 * 功能：字段选择器、iOS 风格日期滚轮选择器、搜索历史、结果汇总卡、
 * 高级筛选面板、关键词搜索（流水 + 生活记录）、左滑操作、entries-changed 自动刷新。
 */
import './search.css';
import { iconHtml } from '../../assets/icons';
import { esc } from '../../core/esc';
import { formatFen } from '../../core/money';
import { listEntries, getEntry, dayKey } from '../../core/repo/entryRepo';
import { listCategories } from '../../core/repo/categoryRepo';
import { listAccounts } from '../../core/repo/accountRepo';
import { listMerchants } from '../../core/repo/merchantRepo';
import { listTags, listEntryIdsByTag } from '../../core/repo/tagRepo';
import { listLifeNotes } from '../../core/repo/lifeRepo';
import { getSetting, setSetting } from '../../core/repo/settingsRepo';
import { registerSubpage, openSubpage, closeSubpage, switchPage } from '../shell/router';
import { showToast } from '../shell/toast';
import { on } from '../../core/store';
import { openEntryDetail } from '../detail/detail';
import {
  bindEntrySwipeActions, entrySwipeActionsHtml, runEntryQuickAction, type EntryQuickAction,
} from '../detail/entrySwipe';
import { LOAN_KIND_META, type Entry, type EntryType, type LifeNote } from '../../core/types';
import {
  filterLedgerEntries, groupLedgerEntries, summarizeLedgerEntries,
  type LedgerQuery,
} from '../../core/ledgerQuery';
import { openDateWheel, type DateWheelResult } from '../../shared/dateTimeWheel';
import { createFilterPanel, emptyFilter, isFilterEmpty, type FilterState } from './filterPanel';

let body: HTMLElement | undefined;
let searchToken = 0;

/* ── 状态 ── */
type DateRange = 'all' | 'month' | 'lastMonth' | '3m' | 'custom';
type FieldMode = 'all' | 'category' | 'account' | 'tag' | 'merchant' | 'note' | 'amount';

let dateRange: DateRange = 'all';
let customFrom: DateWheelResult | null = null;
let customTo: DateWheelResult | null = null;
let fieldMode: FieldMode = 'all';
let filterState: FilterState = emptyFilter();
let summaryFilter: 'all' | 'expense' | 'income' = 'all';
let queryTypes: EntryType[] = [];
let ledgerOnly = false;

interface PendingLedgerSearch {
  query: LedgerQuery;
  title?: string;
}

let pendingLedgerSearch: PendingLedgerSearch | undefined;

/** 从报表或账户页进入携带相同条件的统一明细查询。 */
export function openLedgerSearch(query: LedgerQuery, title?: string): void {
  pendingLedgerSearch = { query, title };
  openSubpage('sp-search');
}

const FIELD_LABELS: Record<FieldMode, string> = {
  all: '全部匹配', category: '类别', account: '账户', tag: '标签', merchant: '商家', note: '备注', amount: '金额',
};

/* ── 日期工具 ── */
function dateStr(r: DateWheelResult): string {
  return `${r.year}/${String(r.month).padStart(2, '0')}/${String(r.day).padStart(2, '0')}`;
}

function dateToTs(r: DateWheelResult): number {
  return new Date(r.year, r.month - 1, r.day).getTime();
}

function tsToDateResult(timestamp: number): DateWheelResult {
  const date = new Date(timestamp);
  return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() };
}

function rangeWindow(): { from: number; to: number } | null {
  const d = new Date();
  const y = d.getFullYear();
  const m = d.getMonth();
  if (dateRange === 'month') return { from: new Date(y, m, 1).getTime(), to: new Date(y, m + 1, 1).getTime() };
  if (dateRange === 'lastMonth') return { from: new Date(y, m - 1, 1).getTime(), to: new Date(y, m, 1).getTime() };
  if (dateRange === '3m') return { from: new Date(y, m - 2, 1).getTime(), to: new Date(y, m + 1, 1).getTime() };
  if (dateRange === 'custom' && (customFrom || customTo)) {
    return {
      from: customFrom ? dateToTs(customFrom) : 0,
      to: customTo ? dateToTs(customTo) + 86400000 : Number.MAX_SAFE_INTEGER,
    };
  }
  return null;
}

let cachedEarliestDate: DateWheelResult | null = null;

function getDefaultFrom(): DateWheelResult {
  return cachedEarliestDate ?? { year: new Date().getFullYear(), month: new Date().getMonth() + 1, day: new Date().getDate() };
}

async function loadEarliestDate(): Promise<void> {
  const entries = await listEntries({});
  if (entries.length) {
    const earliest = entries[entries.length - 1];
    const d = new Date(earliest.occurredAt);
    cachedEarliestDate = { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
  } else {
    cachedEarliestDate = null;
  }
}
function getDefaultTo(): DateWheelResult {
  const d = new Date();
  return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
}

function dateRangeClass(range: DateRange): string {
  return dateRange === range ? ' active' : '';
}

/* ── 账单标题 / 金额渲染 ── */
function entryTitle(e: Entry, catNames: Map<number, string>): string {
  if (e.type === 'transfer') return '转账';
  if (e.type === 'loan') return LOAN_KIND_META[e.loanKind ?? 'borrow'].name;
  const name = catNames.get(e.categoryId ?? -1) ?? '未分类';
  return e.refundFlag ? `${name}退款` : name;
}

function amountHtml(e: Entry): string {
  if (e.type === 'expense') return e.refundFlag
    ? `<span class="num" style="color:var(--income)">+${formatFen(e.amount)}</span>`
    : `<span class="num" style="color:var(--danger,#d0552e)">-${formatFen(e.amount)}</span>`;
  if (e.type === 'income') return `<span class="num" style="color:var(--primary)">+${formatFen(e.amount)}</span>`;
  return `<span class="num">${formatFen(e.amount)}</span>`;
}

/* ── 搜索历史 ── */
async function loadHistory(): Promise<string[]> {
  return await getSetting('search.history') as string[];
}

async function saveHistory(kw: string): Promise<void> {
  let history = await loadHistory();
  history = history.filter(h => h !== kw);
  history.unshift(kw);
  if (history.length > 10) history = history.slice(0, 10);
  await setSetting('search.history', history);
}

async function clearHistory(): Promise<void> {
  await setSetting('search.history', []);
}

interface FilterLabelMaps {
  catNames: ReadonlyMap<number, string>;
  accountNames: ReadonlyMap<number, string>;
  tagNames: ReadonlyMap<number, string>;
  merchantNames: ReadonlyMap<number, string>;
}

function renderActiveFilters(maps: FilterLabelMaps): void {
  const container = body?.querySelector<HTMLElement>('#sr-active-filters');
  if (!container) return;
  const chips: string[] = [];
  const chip = (kind: string, label: string, id?: number) => {
    chips.push(`<button class="chip sr-filter-chip" data-remove-filter="${kind}"${id == null ? '' : ` data-filter-id="${id}"`}>${esc(label)}<span aria-hidden="true">×</span></button>`);
  };
  const dateLabels: Record<DateRange, string> = {
    all: '全部日期', month: '本月', lastMonth: '上月', '3m': '近三月', custom: '自定义日期',
  };
  if (dateRange !== 'all') chip('date', dateLabels[dateRange]);
  if (queryTypes.length) {
    const typeLabels = queryTypes.map((type) => type === 'expense' ? '支出' : type === 'income' ? '收入' : type === 'transfer' ? '转账' : '借贷');
    chip('type', `类型：${typeLabels.join('、')}`);
  }
  for (const id of filterState.categoryIds) chip('category', maps.catNames.get(id) ?? '已删除分类', id);
  for (const id of filterState.accountIds) chip('account', maps.accountNames.get(id) ?? '已删除账户', id);
  for (const id of filterState.tagIds) chip('tag', `#${maps.tagNames.get(id) ?? '已删除标签'}`, id);
  for (const id of filterState.merchantIds) chip('merchant', maps.merchantNames.get(id) ?? '已删除商家', id);
  if (filterState.amountMin || filterState.amountMax) {
    chip('amount', `${filterState.amountMin || '0'} – ${filterState.amountMax || '不限'} 元`);
  }
  container.innerHTML = chips.join('');
  container.hidden = chips.length === 0;
}

/* ── 核心搜索逻辑 ── */
async function doSearch(kw: string): Promise<void> {
  const resultsEl = body?.querySelector<HTMLElement>('#sr-results');
  if (!resultsEl) return;
  const token = ++searchToken;

  const hasStructuredQuery = dateRange !== 'all' || !isFilterEmpty(filterState) || queryTypes.length > 0;
  // 没有关键词也没有任何结构化条件时才显示历史；报表下钻可直接列出全部匹配账单。
  if (!kw && !hasStructuredQuery) {
    const history = await loadHistory();
    if (token !== searchToken) return;
    renderHistory(resultsEl, history);
    const filters = body?.querySelector<HTMLElement>('#sr-active-filters');
    filters?.replaceChildren();
    if (filters) filters.hidden = true;
    return;
  }

  // 保存搜索历史
  if (kw) void saveHistory(kw);

  const [expenseCats, incomeCats, merchants, tags, entries, notes, accounts] = await Promise.all([
    listCategories('expense'), listCategories('income'), listMerchants(), listTags(),
    listEntries({}), listLifeNotes(), listAccounts(),
  ]);
  if (token !== searchToken || !resultsEl.isConnected) return;

  const catNames = new Map<number, string>();
  for (const c of [...expenseCats, ...incomeCats]) catNames.set(c.id, c.name);
  const accountNames = new Map<number, string>();
  for (const a of accounts) accountNames.set(a.id, a.name);
  const tagNames = new Map<number, string>();
  for (const t of tags) tagNames.set(t.id, t.name);
  const merchantNames = new Map<number, string>();
  for (const m of merchants) merchantNames.set(m.id, m.name);

  const win = rangeWindow();
  const tagIdsByEntry = new Map<number, number[]>();
  const tagNamesByEntry = new Map<number, string[]>();
  const tagLinks = await Promise.all(tags.map(async (tag) => ({ tag, entryIds: await listEntryIdsByTag(tag.id) })));
  for (const { tag, entryIds } of tagLinks) {
    for (const entryId of entryIds) {
      tagIdsByEntry.set(entryId, [...(tagIdsByEntry.get(entryId) ?? []), tag.id]);
      tagNamesByEntry.set(entryId, [...(tagNamesByEntry.get(entryId) ?? []), tag.name]);
    }
  }
  if (token !== searchToken || !resultsEl.isConnected) return;

  const parseAmount = (value: string): number | undefined => {
    if (!value.trim()) return undefined;
    const amount = Number(value);
    return Number.isFinite(amount) ? Math.round(amount * 100) : undefined;
  };
  const query: LedgerQuery = {
    from: win?.from,
    to: win?.to,
    types: queryTypes.length ? [...queryTypes] : undefined,
    categoryIds: filterState.categoryIds.length ? [...filterState.categoryIds] : undefined,
    accountIds: filterState.accountIds.length ? [...filterState.accountIds] : undefined,
    tagIds: filterState.tagIds.length ? [...filterState.tagIds] : undefined,
    merchantIds: filterState.merchantIds.length ? [...filterState.merchantIds] : undefined,
    amountMin: parseAmount(filterState.amountMin),
    amountMax: parseAmount(filterState.amountMax),
    keyword: kw || undefined,
    field: fieldMode,
  };
  const matchedEntries = filterLedgerEntries(entries, query, {
    categoryNames: catNames,
    accountNames,
    tagIdsByEntry,
    tagNamesByEntry,
    merchantNames,
  });
  const countReimburseAsIncome = await getSetting('reimburse.countAsIncome');
  let reimburseIncome = 0;
  let reimburseIncomeCount = 0;
  if (countReimburseAsIncome && (!query.types?.length || query.types.includes('income'))) {
    const nonDateQuery: LedgerQuery = { ...query, from: undefined, to: undefined, types: undefined };
    const eligible = filterLedgerEntries(entries, nonDateQuery, {
      categoryNames: catNames,
      accountNames,
      tagIdsByEntry,
      tagNamesByEntry,
      merchantNames,
    });
    const from = query.from ?? 0;
    const to = query.to ?? Number.MAX_SAFE_INTEGER;
    for (const entry of eligible) {
      if (entry.reimburseStatus !== 'done' || entry.reimbursedAt == null) continue;
      if (entry.reimbursedAt < from || entry.reimbursedAt >= to) continue;
      reimburseIncome += entry.reimbursedAmount ?? 0;
      reimburseIncomeCount += 1;
    }
  }
  const summary = summarizeLedgerEntries(matchedEntries, {
    reimburseMode: countReimburseAsIncome ? 'income' : 'offset',
    reimburseIncome,
    reimburseIncomeCount,
  });
  renderActiveFilters({ catNames, accountNames, tagNames, merchantNames });

  // 按汇总卡筛选显示
  let displayEntries = matchedEntries;
  if (summaryFilter === 'expense') displayEntries = matchedEntries.filter(e => e.type === 'expense');
  else if (summaryFilter === 'income') displayEntries = matchedEntries.filter(e => e.type === 'income');
  const hitEntries = displayEntries.slice(0, 100);

  // 生活记录搜索（仅 all/note 模式下）
  const hitNotes = !ledgerOnly && !!kw && (fieldMode === 'all' || fieldMode === 'note')
    ? notes.filter(n => (!win || (n.occurredAt >= win.from && n.occurredAt < win.to)) && ((n.title ?? '').includes(kw) || (n.body ?? '').includes(kw))).slice(0, 50)
    : [];

  const entryRow = (e: Entry) => {
    const states = [
      e.refundFlag ? '<span class="sr-state refund">退款到账</span>' : '',
      e.reimburseStatus === 'pending' ? '<span class="sr-state pending">待报销</span>' : '',
      e.reimburseStatus === 'done' ? '<span class="sr-state done">已报销</span>' : '',
      e.type === 'transfer' ? '<span class="sr-state neutral">转账</span>' : '',
      e.type === 'loan' ? '<span class="sr-state neutral">借贷</span>' : '',
    ].join('');
    return `
      <div class="entry-swipe" data-eid="${e.id}">
        ${entrySwipeActionsHtml(e)}
        <button class="row entry-swipe-content">
          <div class="e-main"><p class="e-title">${esc(entryTitle(e, catNames))}${states}</p>
            <p class="e-meta">${e.note ? esc(e.note.slice(0, 30)) : accountNames.get(e.accountId ?? e.fromAccountId ?? -1) ?? '无备注'}</p></div>
          ${amountHtml(e)}
        </button>
      </div>`;
  };
  const noteRow = (n: LifeNote) => `
    <button class="row" data-nid="${n.id}">
      <div class="e-main"><p class="e-title">${esc(n.title || '（无标题）')}</p>
        <p class="e-meta">${dayKey(n.occurredAt)}${n.body ? ` · ${esc(n.body.slice(0, 30))}` : ''}</p></div>
      <span class="chev">${iconHtml('ic-right', 15)}</span>
    </button>`;

  if (!hitEntries.length && !hitNotes.length) {
    resultsEl.innerHTML = `<p class="sr-empty">${kw ? `没有找到与「${esc(kw)}」相关的内容` : '当前筛选条件下没有账单'}</p>`;
    return;
  }

  const groupedEntries = groupLedgerEntries(hitEntries);

  resultsEl.innerHTML = `
    ${matchedEntries.length ? `
    <div class="sr-summary-row">
      <div class="sr-summary-card${summaryFilter === 'all' ? ' active' : ''}" data-sf="all">
        <div class="sc-label">结余</div>
        <div class="sc-amount">${summary.balance >= 0 ? '' : '-'}${formatFen(Math.abs(summary.balance))}</div>
      </div>
      <div class="sr-summary-card${summaryFilter === 'expense' ? ' active' : ''}" data-sf="expense">
        <div class="sc-label">支出(${summary.expenseCount})</div>
        <div class="sc-amount">${formatFen(summary.expense)}</div>
      </div>
      <div class="sr-summary-card${summaryFilter === 'income' ? ' active' : ''}" data-sf="income">
        <div class="sc-label">收入(${summary.incomeCount})</div>
        <div class="sc-amount">${formatFen(summary.income)}</div>
      </div>
    </div>` : ''}
    ${groupedEntries.map((group) => {
      const daySummary = summarizeLedgerEntries(group.entries);
      return `<div class="sr-day-head"><h3>${group.day}</h3><span>支出 ${formatFen(daySummary.expense)} · 收入 ${formatFen(daySummary.income)}</span></div>
        <section class="card list sr-day-card" aria-label="${group.day}账单">${group.entries.map(entryRow).join('')}</section>`;
    }).join('')}
    ${hitNotes.length ? `
    <section class="card list" aria-label="生活记录结果">
      <div class="sr-list-head"><h3>生活记录（${hitNotes.length}）</h3></div>
      ${hitNotes.map(noteRow).join('')}
    </section>` : ''}`;
}

/* ── 渲染搜索历史 ── */
function renderHistory(container: HTMLElement, history: string[]): void {
  if (!history.length) {
    container.innerHTML = `<p class="sr-empty">输入关键词搜索流水与生活记录</p>`;
    return;
  }
  container.innerHTML = `
    <div class="sr-history">
      <div class="sr-history-head">
        <h3>搜索历史</h3>
        <button class="sr-clear-history" aria-label="清除搜索历史">${iconHtml('ic-del', 16)}</button>
      </div>
      <div class="sr-history-chips">
        ${history.map(h => `<button class="chip sr-history-item">${esc(h)}</button>`).join('')}
      </div>
    </div>`;
}

/* ── 字段选择器 Sheet ── */
function openFieldSheet(onSelect: (mode: FieldMode) => void): void {
  const sheet = document.createElement('div');
  sheet.className = 'sr-field-sheet';
  const items: FieldMode[] = ['all', 'category', 'account', 'tag', 'merchant', 'note', 'amount'];
  sheet.innerHTML = `
    <div class="fs-mask"></div>
    <div class="fs-card">
      <div class="fs-head">
        <h3>选择匹配项</h3>
        <button class="fs-close">${iconHtml('ic-close', 18)}</button>
      </div>
      ${items.map(m => `
        <button class="fs-item" data-mode="${m}">
          <span>${esc(FIELD_LABELS[m])}</span>
          ${m === fieldMode ? '<span class="fs-check">✓</span>' : ''}
        </button>`).join('')}
    </div>`;

  function close(): void {
    sheet.classList.remove('open');
    setTimeout(() => sheet.remove(), 250);
  }

  sheet.querySelector('.fs-mask')!.addEventListener('click', close);
  sheet.querySelector('.fs-close')!.addEventListener('click', close);
  sheet.addEventListener('click', (e) => {
    const item = (e.target as HTMLElement).closest<HTMLElement>('[data-mode]');
    if (item) {
      onSelect(item.dataset.mode as FieldMode);
      close();
    }
  });

  document.body.appendChild(sheet);
  requestAnimationFrame(() => sheet.classList.add('open'));
}

/* ── 更新日期范围显示 ── */
function updateDateDisplay(): void {
  if (!body) return;
  const fromBtn = body.querySelector<HTMLElement>('#sr-date-from');
  const toBtn = body.querySelector<HTMLElement>('#sr-date-to');
  if (!fromBtn || !toBtn) return;

  const from = customFrom ?? getDefaultFrom();
  const to = customTo ?? getDefaultTo();
  fromBtn.textContent = `${dateStr(from)} ▾`;
  toBtn.textContent = `${dateStr(to)} ▾`;
}

/* ── 注册搜索子页 ── */
export function initSearch(): void {
  registerSubpage('sp-search', {
    title: '搜索',
    render(el) {
      body = el;
      const preset = pendingLedgerSearch;
      pendingLedgerSearch = undefined;
      // 重置状态
      dateRange = 'all';
      customFrom = null;
      customTo = null;
      fieldMode = 'all';
      filterState = emptyFilter();
      summaryFilter = 'all';
      queryTypes = [];
      ledgerOnly = false;

      if (preset) {
        const query = preset.query;
        ledgerOnly = true;
        if (query.from != null || query.to != null) {
          dateRange = 'custom';
          customFrom = query.from != null ? tsToDateResult(query.from) : null;
          customTo = query.to != null ? tsToDateResult(Math.max(0, query.to - 1)) : null;
        }
        queryTypes = [...(query.types ?? [])];
        filterState = {
          categoryIds: [...(query.categoryIds ?? [])],
          accountIds: [...(query.accountIds ?? [])],
          tagIds: [...(query.tagIds ?? [])],
          merchantIds: [...(query.merchantIds ?? [])],
          amountMin: query.amountMin == null ? '' : String(query.amountMin / 100),
          amountMax: query.amountMax == null ? '' : String(query.amountMax / 100),
        };
        fieldMode = query.field ?? 'all';
        if (queryTypes.length === 1 && queryTypes[0] === 'expense') summaryFilter = 'expense';
        else if (queryTypes.length === 1 && queryTypes[0] === 'income') summaryFilter = 'income';
        const title = el.closest<HTMLElement>('.subpage')?.querySelector<HTMLElement>('.sub-head h2');
        if (title) title.textContent = preset.title ?? '账单明细';
      }

      const defFrom = customFrom ?? getDefaultFrom();
      const defTo = customTo ?? getDefaultTo();
      const initialKeyword = preset?.query.keyword ?? '';

      el.innerHTML = `
        <div class="sr-topbar">
          <button class="sr-field-btn" id="sr-field-btn">${esc(FIELD_LABELS[fieldMode])} ▾</button>
          <div class="sr-input-wrap">
            <span class="sr-ic">${iconHtml('ic-search', 16)}</span>
            <input type="search" id="sr-input" placeholder="搜索分类、账户、标签、商家、备注或金额" aria-label="搜索关键词" value="${esc(initialKeyword)}">
            <button class="sr-clear" id="sr-clear-input"${initialKeyword ? '' : ' hidden'}>${iconHtml('ic-close', 14)}</button>
          </div>
          <button class="sr-cancel" id="sr-cancel-btn">取消</button>
        </div>
        <div class="sr-date-row">
          <button class="sr-date-btn" id="sr-date-from">${dateStr(defFrom)} ▾</button>
          <span class="sr-date-sep">~</span>
          <button class="sr-date-btn" id="sr-date-to">${dateStr(defTo)} ▾</button>
          <button class="sr-filter-icon${isFilterEmpty(filterState) ? '' : ' active'}" id="sr-adv-filter" aria-label="高级筛选">
            <svg class="ic" viewBox="0 0 24 24"><path d="M3 6h18M6 12h12M9 18h6"/></svg>
          </button>
        </div>
        <div class="sr-dates" id="sr-dates" role="group" aria-label="日期范围">
          <button class="chip${dateRangeClass('all')}" data-range="all">全部</button>
          <button class="chip${dateRangeClass('month')}" data-range="month">本月</button>
          <button class="chip${dateRangeClass('lastMonth')}" data-range="lastMonth">上月</button>
          <button class="chip${dateRangeClass('3m')}" data-range="3m">近三月</button>
          <button class="chip${dateRangeClass('custom')}" data-range="custom">自定义</button>
        </div>
        <div class="sr-active-filters" id="sr-active-filters" aria-label="已启用筛选" hidden></div>
        <div id="sr-results"></div>`;

      const input = el.querySelector<HTMLInputElement>('#sr-input')!;
      const clearBtn = el.querySelector<HTMLElement>('#sr-clear-input')!;
      let timer = 0;

      function triggerSearch(): void {
        window.clearTimeout(timer);
        timer = window.setTimeout(() => void doSearch(input.value.trim()), 250);
      }

      // 搜索输入
      input.addEventListener('input', () => {
        clearBtn.hidden = !input.value;
        triggerSearch();
      });

      // 清空输入
      clearBtn.addEventListener('click', () => {
        input.value = '';
        clearBtn.hidden = true;
        void doSearch('');
      });

      // 取消按钮
      el.querySelector('#sr-cancel-btn')!.addEventListener('click', () => closeSubpage());

      // 字段选择器
      el.querySelector('#sr-field-btn')!.addEventListener('click', () => {
        openFieldSheet((mode) => {
          fieldMode = mode;
          el.querySelector<HTMLElement>('#sr-field-btn')!.textContent = `${FIELD_LABELS[mode]} ▾`;
          triggerSearch();
        });
      });

      // 日期范围 chips
      el.querySelector('#sr-dates')!.addEventListener('click', (e) => {
        const chip = (e.target as HTMLElement).closest<HTMLElement>('[data-range]');
        if (!chip) return;
        const range = chip.dataset.range as DateRange;
        dateRange = range;
        for (const c of el.querySelectorAll<HTMLElement>('#sr-dates .chip')) c.classList.toggle('active', c === chip);
        if (range === 'custom') {
          // 打开开始日期选择
          openFromDateWheel();
        } else {
          // 根据选中的 chip 计算对应的起止日期并同步到顶部日期显示
          const now = new Date();
          const y = now.getFullYear();
          const m = now.getMonth();
          if (range === 'all') {
            customFrom = null;
            customTo = null;
          } else if (range === 'month') {
            customFrom = { year: y, month: m + 1, day: 1 };
            customTo = { year: y, month: m + 1, day: now.getDate() };
          } else if (range === 'lastMonth') {
            const lmDate = new Date(y, m, 0); // last day of previous month
            customFrom = { year: lmDate.getFullYear(), month: lmDate.getMonth() + 1, day: 1 };
            customTo = { year: lmDate.getFullYear(), month: lmDate.getMonth() + 1, day: lmDate.getDate() };
          } else if (range === '3m') {
            const tmDate = new Date(y, m - 2, 1);
            customFrom = { year: tmDate.getFullYear(), month: tmDate.getMonth() + 1, day: 1 };
            customTo = { year: y, month: m + 1, day: now.getDate() };
          }
          updateDateDisplay();
          triggerSearch();
        }
      });

      // 起止日期按钮
      el.querySelector('#sr-date-from')!.addEventListener('click', openFromDateWheel);
      el.querySelector('#sr-date-to')!.addEventListener('click', openToDateWheel);

      function openFromDateWheel(): void {
        const panel = openDateWheel({
          initial: customFrom ?? getDefaultFrom(),
          onConfirm(r) {
            customFrom = r;
            dateRange = 'custom';
            // 激活自定义chip
            for (const c of el.querySelectorAll<HTMLElement>('#sr-dates .chip')) {
              c.classList.toggle('active', c.dataset.range === 'custom');
            }
            updateDateDisplay();
            triggerSearch();
          },
        });
        document.body.appendChild(panel);
      }

      function openToDateWheel(): void {
        const panel = openDateWheel({
          initial: customTo ?? getDefaultTo(),
          onConfirm(r) {
            customTo = r;
            dateRange = 'custom';
            for (const c of el.querySelectorAll<HTMLElement>('#sr-dates .chip')) {
              c.classList.toggle('active', c.dataset.range === 'custom');
            }
            updateDateDisplay();
            triggerSearch();
          },
        });
        document.body.appendChild(panel);
      }

      // 高级筛选
      el.querySelector('#sr-adv-filter')!.addEventListener('click', async () => {
        const panel = await createFilterPanel({
          initial: filterState,
          onConfirm(state) {
            filterState = state;
            panel.remove();
            // 更新漏斗图标状态
            el.querySelector('#sr-adv-filter')!.classList.toggle('active', !isFilterEmpty(filterState));
            triggerSearch();
          },
          onCancel() {
            panel.remove();
          },
        });
        document.body.appendChild(panel);
      });

      // 结果区点击事件代理
      el.addEventListener('click', (e) => {
        const t = e.target as HTMLElement;

        const removeFilter = t.closest<HTMLElement>('[data-remove-filter]');
        if (removeFilter) {
          const kind = removeFilter.dataset.removeFilter;
          const id = Number(removeFilter.dataset.filterId);
          if (kind === 'date') {
            dateRange = 'all'; customFrom = null; customTo = null; updateDateDisplay();
            for (const dateChip of el.querySelectorAll<HTMLElement>('#sr-dates .chip')) {
              dateChip.classList.toggle('active', dateChip.dataset.range === 'all');
            }
          }
          else if (kind === 'type') queryTypes = [];
          else if (kind === 'category') filterState.categoryIds = filterState.categoryIds.filter((item) => item !== id);
          else if (kind === 'account') filterState.accountIds = filterState.accountIds.filter((item) => item !== id);
          else if (kind === 'tag') filterState.tagIds = filterState.tagIds.filter((item) => item !== id);
          else if (kind === 'merchant') filterState.merchantIds = filterState.merchantIds.filter((item) => item !== id);
          else if (kind === 'amount') { filterState.amountMin = ''; filterState.amountMax = ''; }
          el.querySelector('#sr-adv-filter')!.classList.toggle('active', !isFilterEmpty(filterState));
          void doSearch(input.value.trim());
          return;
        }

        // 汇总卡切换
        const sf = t.closest<HTMLElement>('[data-sf]');
        if (sf) {
          summaryFilter = sf.dataset.sf as 'all' | 'expense' | 'income';
          void doSearch(input.value.trim());
          return;
        }

        // 搜索历史清除
        if (t.closest('.sr-clear-history')) {
          void clearHistory().then(() => renderHistory(el.querySelector('#sr-results')!, []));
          return;
        }
        // 搜索历史点击
        const historyItem = t.closest<HTMLElement>('.sr-history-item');
        if (historyItem) {
          input.value = historyItem.textContent ?? '';
          clearBtn.hidden = !input.value;
          void doSearch(input.value.trim());
          return;
        }

        // 左滑操作
        const action = t.closest<HTMLElement>('[data-entry-action]');
        const entryRow = t.closest<HTMLElement>('[data-eid]');
        if (entryRow?.dataset.swipeSuppress === 'true') return;
        if (action && entryRow) {
          if (action.getAttribute('aria-disabled') === 'true') { showToast('仅普通支出账单支持退款'); return; }
          void getEntry(Number(entryRow.dataset.eid)).then((entry) => {
            if (entry) void runEntryQuickAction(action.dataset.entryAction as EntryQuickAction, entry);
          });
          return;
        }
        // 条目点击
        const nid = t.closest<HTMLElement>('[data-nid]')?.dataset.nid;
        if (entryRow) openEntryDetail(Number(entryRow.dataset.eid));
        else if (nid) {
          closeSubpage();
          switchPage('page-life');
        }
      });

      bindEntrySwipeActions(el.querySelector<HTMLElement>('#sr-results')!);

      // entries-changed 自动刷新
      const off = on('entries-changed', () => {
        if (!el.isConnected) { off(); return; }
        void doSearch(input.value.trim());
      });

      // 异步加载最早账单日期并刷新显示
      void loadEarliestDate().then(() => updateDateDisplay());

      // 初始加载历史
      void doSearch(input.value.trim());
      window.setTimeout(() => input.focus(), 350);
    },
  });
}
