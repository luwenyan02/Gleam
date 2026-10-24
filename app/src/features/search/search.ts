import { ledgerEntriesInRange } from '../../core/repo/statsRepo';
import { entryDisplayAmount } from '../../core/entryAmount';
import { nextLocalDayStart } from '../../core/queryValidation';
/**
 * 拾光 · 全局搜索（重做版，参考挖财记账 UX）
 * 功能：字段选择器、iOS 风格日期滚轮选择器、搜索历史、结果汇总卡、
 * 高级筛选面板、关键词搜索（流水 + 生活记录）、左滑操作、entries-changed 自动刷新。
 */
import './search.css';
import { filterSearchSummary, searchExtraSummaries, SUMMARY_LABELS, type SearchSummaryFilter } from './searchSummary';
import { openEntityInsight } from '../tagmerchant/tagmerchant';
import { expandCategoryIds, parseAmountRange, validateDateRange } from '../../core/queryValidation';
import { iconHtml } from '../../assets/icons';
import { categoryDisplayMap } from '../../core/categoryIcons';
import { esc } from '../../core/esc';
import { formatFen } from '../../core/money';
import { listEntries, getEarliestEntryDate, getEntry, dayKey } from '../../core/repo/entryRepo';
import { listCategories } from '../../core/repo/categoryRepo';
import { listAccounts } from '../../core/repo/accountRepo';
import { listMerchants } from '../../core/repo/merchantRepo';
import { listTags, listEntryTagLinks } from '../../core/repo/tagRepo';
import { listLifeNotes } from '../../core/repo/lifeRepo';
import {
  applyBatchEntries, previewBatchEntries,
  type BatchEntryOperation, type BatchEntryPreview, type BatchEntryResult,
} from '../../core/repo/batchEntryRepo';
import { getSetting, setSetting } from '../../core/repo/settingsRepo';
import { registerSubpage, openSubpage, closeSubpage, switchPage } from '../shell/router';
import { showToast } from '../shell/toast';
import { confirmDialog } from '../shell/dialog';
import { on } from '../../core/store';
import { openEntryDetail } from '../detail/detail';
import {
  bindEntrySwipeActions, entrySwipeActionsHtml, runEntryQuickAction, type EntryQuickAction,
} from '../detail/entrySwipe';
import { type Account, type Category, type Entry, type EntryType, type LifeNote, type Tag } from '../../core/types';
import {
  filterLedgerEntries, groupLedgerEntries, summarizeLedgerEntries,
  type LedgerQuery,
} from '../../core/ledgerQuery';
import { openDateWheel, type DateWheelResult } from '../../shared/dateTimeWheel';
import { createFilterPanel, emptyFilter, isFilterEmpty, type FilterState } from './filterPanel';
import { ledgerItems, type LedgerItem } from '../../core/ledgerEvents';
import { manageOverlay } from '../../shared/overlay';
import { entryRowText } from '../detail/entryRowText';
import { sheetPick } from '../detail/detailShared';
import { focusLifeRecord } from '../life/life';

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
let summaryFilter: SearchSummaryFilter = 'all';
let queryTypes: EntryType[] = [];
let ledgerOnly = false;
let accountScope: number | undefined;
let batchMode = false;
let batchSelectAll = false;
const batchSelected = new Set<number>();
let batchResultIds: number[] = [];
let batchCategories: Category[] = [];
let batchAccounts: Account[] = [];
let batchTags: Tag[] = [];
const PAGE_SIZE = 20;
let shown = PAGE_SIZE;
let lastQueryKey = '';

interface PendingLedgerSearch {
  query: LedgerQuery;
  title?: string;
  accountScope?: number;
}

let pendingLedgerSearch: PendingLedgerSearch | undefined;

function updateBatchControls(): void {
  const subpage = body?.closest<HTMLElement>('.subpage');
  const button = subpage?.querySelector<HTMLButtonElement>('#sr-batch');
  const bar = subpage?.querySelector<HTMLElement>('#sr-batch-bar');
  if (!button || !bar) return;
  button.hidden = !batchMode && batchResultIds.length === 0;
  button.textContent = batchMode ? '完成' : '批量';
  button.classList.toggle('active', batchMode);
  bar.hidden = !batchMode;
  const count = bar.querySelector<HTMLElement>('#sr-batch-count');
  if (count) count.textContent = `已选 ${batchSelected.size} / ${batchResultIds.length} 笔`;
  const toggle = bar.querySelector<HTMLButtonElement>('#sr-batch-all');
  if (toggle) toggle.textContent = batchSelected.size === batchResultIds.length && batchResultIds.length ? '取消全选' : '全选结果';
}

function batchPreviewText(preview: BatchEntryPreview): string {
  const reasons = new Map<string, number>();
  for (const item of preview.skipped) reasons.set(item.reason, (reasons.get(item.reason) ?? 0) + 1);
  const skipped = preview.skipped.length
    ? `；跳过 ${preview.skipped.length} 笔（${[...reasons].map(([reason, count]) => `${reason} ${count} 笔`).join('，')}）`
    : '';
  return `可处理 ${preview.processableIds.length} 笔${skipped}`;
}

/** 从报表或账户页进入携带相同条件的统一明细查询。 */
export function openLedgerSearch(query: LedgerQuery, title?: string): void {
  pendingLedgerSearch = { query, title };
  openSubpage('sp-search');
}

/** 账户详情内搜索始终限定该账户，日期和其他条件仍可调整。 */
export function openAccountSearch(accountId: number, name: string): void {
  pendingLedgerSearch = { query: { accountIds: [accountId] }, title: `${name} · 搜索`, accountScope: accountId };
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
      to: customTo ? nextLocalDayStart(dateToTs(customTo)) : Number.MAX_SAFE_INTEGER,
    };
  }
  return null;
}

let cachedEarliestDate: DateWheelResult | null = null;

function getDefaultFrom(): DateWheelResult {
  return cachedEarliestDate ?? { year: new Date().getFullYear(), month: new Date().getMonth() + 1, day: new Date().getDate() };
}

async function loadEarliestDate(): Promise<void> {
  const earliest = await getEarliestEntryDate();
  if (earliest != null) {
    const d = new Date(earliest);
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
function amountHtml(e: Entry): string {
  if (e.type === 'expense' || e.type === 'income') {
    const amount = entryDisplayAmount(e);
    return `<span class="num" style="color:var(${amount >= 0 ? '--income' : '--danger,#d0552e'})">${formatFen(amount, { sign: true })}</span>`;
  }
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
  if (accountScope != null) {
    chips.push(`<span class="chip">账户：${esc(maps.accountNames.get(accountScope) ?? '已删除账户')}</span>`);
  } else {
    for (const id of filterState.accountIds) chip('account', maps.accountNames.get(id) ?? '已删除账户', id);
  }
  for (const id of filterState.tagIds) chip('tag', `#${maps.tagNames.get(id) ?? '已删除标签'}`, id);
  for (const id of filterState.merchantIds) chip('merchant', maps.merchantNames.get(id) ?? '已删除商家', id);
  for (const id of filterState.tagIds) chips.push(`<button class="chip" data-entity-kind="tag" data-entity-id="${id}">${esc(maps.tagNames.get(id) ?? '标签')}详情 ›</button>`);
  for (const id of filterState.merchantIds) chips.push(`<button class="chip" data-entity-kind="merchant" data-entity-id="${id}">${esc(maps.merchantNames.get(id) ?? '商家')}详情 ›</button>`);
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
  resultsEl.setAttribute('aria-busy', 'true');
  if (!resultsEl.querySelector('.sr-summary-row, .sr-day-card, .sr-batch-scope')) {
    resultsEl.innerHTML = '<p class="sr-empty" role="status">正在筛选账单…</p>';
  }

  const hasStructuredQuery = accountScope != null || dateRange !== 'all' || !isFilterEmpty(filterState) || queryTypes.length > 0;
  // 没有关键词也没有任何结构化条件时才显示历史；报表下钻可直接列出全部匹配账单。
  if (!kw && !hasStructuredQuery) {
    batchResultIds = [];
    batchSelected.clear();
    batchMode = false;
    batchSelectAll = false;
    const history = await loadHistory();
    if (token !== searchToken) return;
    renderHistory(resultsEl, history);
    resultsEl.setAttribute('aria-busy', 'false');
    const filters = body?.querySelector<HTMLElement>('#sr-active-filters');
    filters?.replaceChildren();
    if (filters) filters.hidden = true;
    updateBatchControls();
    return;
  }


  const win = rangeWindow();
  const countReimburseAsIncome = await getSetting('reimburse.countAsIncome');
  if (token !== searchToken || !resultsEl.isConnected) return;
  const [expenseCats, incomeCats, merchants, tags, entries, notes, accounts] = await Promise.all([
    listCategories('expense'), listCategories('income'), listMerchants(), listTags(),
    win ? ledgerEntriesInRange(win.from, win.to, countReimburseAsIncome)
      : listEntries({}).then(rows => ledgerItems(rows, countReimburseAsIncome)),
    !ledgerOnly && !!kw && (fieldMode === 'all' || fieldMode === 'note') ? listLifeNotes(win ?? {}) : Promise.resolve([]),
    listAccounts(),
  ]);
  if (token !== searchToken || !resultsEl.isConnected) return;

  const catNames = new Map<number, string>();
  const catMap = categoryDisplayMap([...expenseCats, ...incomeCats]);
  for (const c of [...expenseCats, ...incomeCats]) catNames.set(c.id, c.name);
  const accountNames = new Map<number, string>();
  for (const a of accounts) accountNames.set(a.id, a.name);
  const tagNames = new Map<number, string>();
  for (const t of tags) tagNames.set(t.id, t.name);
  const merchantNames = new Map<number, string>();
  for (const m of merchants) merchantNames.set(m.id, m.name);
  batchCategories = [...catMap.values()];
  batchAccounts = accounts;
  batchTags = tags;

  updateDateDisplay(win);
  const tagIdsByEntry = new Map<number, number[]>();
  const tagNamesByEntry = new Map<number, string[]>();
  const tagLinks = await listEntryTagLinks(win ? entries.map(entry => entry.id) : undefined);
  for (const { tagId, entryId } of tagLinks) {
    tagIdsByEntry.set(entryId, [...(tagIdsByEntry.get(entryId) ?? []), tagId]);
    tagNamesByEntry.set(entryId, [...(tagNamesByEntry.get(entryId) ?? []), tagNames.get(tagId) ?? '']);
  }
  if (token !== searchToken || !resultsEl.isConnected) return;

  const query: LedgerQuery = {
    from: win?.from,
    to: win?.to,
    types: queryTypes.length ? [...queryTypes] : undefined,
    categoryIds: filterState.categoryIds.length ? expandCategoryIds(filterState.categoryIds, [...expenseCats, ...incomeCats]) : undefined,
    accountIds: accountScope != null ? [accountScope] : filterState.accountIds.length ? [...filterState.accountIds] : undefined,
    tagIds: filterState.tagIds.length ? [...filterState.tagIds] : undefined,
    merchantIds: filterState.merchantIds.length ? [...filterState.merchantIds] : undefined,
    ...parseAmountRange(filterState.amountMin, filterState.amountMax),
    keyword: kw || undefined,
    field: fieldMode,
  };
  const queryKey = JSON.stringify([query, summaryFilter]);
  if (queryKey !== lastQueryKey) { shown = PAGE_SIZE; lastQueryKey = queryKey; }
  const matchedEntries = filterLedgerEntries(entries, query, {
    categoryNames: catNames,
    accountNames,
    tagIdsByEntry,
    tagNamesByEntry,
    merchantNames,
  });
  const summaryOptions = { reimburseMode: countReimburseAsIncome ? 'income' as const : 'offset' as const };
  const summary = summarizeLedgerEntries(matchedEntries, summaryOptions);
  const extras = searchExtraSummaries(matchedEntries);
  if (!['all', 'expense', 'income'].includes(summaryFilter) && !extras.some(card => card.filter === summaryFilter)) summaryFilter = 'all';
  renderActiveFilters({ catNames, accountNames, tagNames, merchantNames });

  // 按汇总卡筛选显示
  const displayEntries = filterSearchSummary(matchedEntries, summaryFilter);
  batchResultIds = [...new Set(displayEntries.filter((entry) => entry.kind === 'entry').map((entry) => entry.id))];
  if (batchMode && batchSelectAll) {
    batchSelected.clear();
    batchResultIds.forEach((id) => batchSelected.add(id));
  } else {
    for (const id of [...batchSelected]) if (!batchResultIds.includes(id)) batchSelected.delete(id);
  }
  const hitEntries = displayEntries.slice(0, shown);

  // 生活记录搜索（仅 all/note 模式下）
  const hitNotes = !ledgerOnly && !!kw && (fieldMode === 'all' || fieldMode === 'note')
    ? notes.filter(n => (!win || (n.occurredAt >= win.from && n.occurredAt < win.to)) && ((n.title ?? '').includes(kw) || (n.body ?? '').includes(kw))).slice(0, 50)
    : [];

  const entryRow = (e: LedgerItem) => {
    const text = entryRowText(e, catMap, accountNames);
    const note = text.note ? ` <span class="e-sub">· ${esc(text.note)}</span>` : '';
    const selectable = e.kind === 'entry';
    const lead = batchMode && selectable
      ? `<span class="ck${batchSelected.has(e.id) ? ' on' : ''}" aria-hidden="true"></span>`
      : `<span class="e-ic${text.neutral ? ' neutral' : ''}">${iconHtml(text.icon, 18)}</span>`;
    return `
      <div class="entry-swipe${batchMode ? ' sr-batch-row' : ''}" data-eid="${e.id}"${e.kind === 'reimbursement' ? ' data-reimbursement' : ''}>
        ${e.kind === 'reimbursement' || batchMode ? '' : entrySwipeActionsHtml(e)}
        <button class="row entry-swipe-content">
          ${lead}
          <div class="e-main"><p class="e-title">${esc(text.title)}${note}</p>
            <p class="e-meta">${esc(text.meta)}</p>
            ${e.kind === 'reimbursement' ? '<p class="e-meta">点击查看原支出</p>' : e.type === 'expense' && e.reimburseStatus === 'done' ? `<p class="sr-net">原额 ${formatFen(e.amount)} · 已报销 ${formatFen(e.reimbursedAmount ?? 0)}${!countReimburseAsIncome ? ` · 净支出 ${formatFen((e.refundFlag ? -e.amount : e.amount) - (e.reimbursedAmount ?? 0))}` : ''}</p>` : ''}</div>
          ${amountHtml(e)}
        </button>
      </div>`;
  };
  const noteRow = (n: LifeNote) => `
    <button class="row" data-nid="${n.id}" data-note-at="${n.occurredAt}">
      <div class="e-main"><p class="e-title">${esc(n.title || '（无标题）')}</p>
        <p class="e-meta">${dayKey(n.occurredAt)}${n.body ? ` · ${esc(n.body.slice(0, 30))}` : ''}</p></div>
      <span class="chev">${iconHtml('ic-right', 15)}</span>
    </button>`;

  const groupedEntries = groupLedgerEntries(hitEntries);
  const fullGroups = new Map(groupLedgerEntries(displayEntries).map(g => [g.day, summarizeLedgerEntries(g.entries, summaryOptions)]));

  const summaryScroll = resultsEl.querySelector<HTMLElement>('.sr-summary-row')?.scrollLeft ?? 0;
  const focusedSummary = resultsEl.contains(document.activeElement) ? (document.activeElement as HTMLElement)?.dataset.sf : undefined;
  resultsEl.innerHTML = `
    ${batchMode ? `<div class="sr-batch-scope"><b>批量处理当前全部结果</b><span>已载入 ${batchResultIds.length} 笔，不受分页限制</span></div>` : ''}
    <div class="sr-summary-row" role="group" aria-label="搜索结果汇总，可横向滑动">
      <button class="sr-summary-card${summaryFilter === 'all' ? ' active' : ''}" data-sf="all" aria-pressed="${summaryFilter === 'all'}">
        <div class="sc-label">结余</div>
        <div class="sc-amount">${summary.balance >= 0 ? '' : '-'}${formatFen(Math.abs(summary.balance))}</div>
      </button>
      <button class="sr-summary-card${summaryFilter === 'expense' ? ' active' : ''}" data-sf="expense" aria-pressed="${summaryFilter === 'expense'}">
        <div class="sc-label">支出(${summary.expenseCount})</div>
        <div class="sc-amount">${formatFen(summary.expense)}</div>
      </button>
      <button class="sr-summary-card${summaryFilter === 'income' ? ' active' : ''}" data-sf="income" aria-pressed="${summaryFilter === 'income'}">
        <div class="sc-label">收入(${summary.incomeCount})</div>
        <div class="sc-amount">${formatFen(summary.income)}</div>
      </button>
      ${extras.map(card => `<button class="sr-summary-card${summaryFilter === card.filter ? ' active' : ''}" data-sf="${card.filter}" aria-pressed="${summaryFilter === card.filter}"><div class="sc-label">${card.label}(${card.count})</div><div class="sc-amount">${formatFen(card.amount)}</div></button>`).join('')}
    </div>
    ${!hitEntries.length && !hitNotes.length ? `<p class="sr-empty">当前${SUMMARY_LABELS[summaryFilter]}筛选下没有记录，可切换上方类型或清除筛选条件</p>` : ''}
    ${groupedEntries.map((group) => {
      const daySummary = fullGroups.get(group.day)!;
      return `<div class="sr-day-head"><h3>${group.day}</h3><span>支出 ${formatFen(daySummary.expense)} · 收入 ${formatFen(daySummary.income)}</span></div>
        <section class="card list sr-day-card" aria-label="${group.day}账单">${group.entries.map(entryRow).join('')}</section>`;
    }).join('')}
    ${displayEntries.length > shown ? `<div class="sr-pagination"><div class="btn-row" role="group" aria-label="加载搜索结果"><button class="btn ghost" id="sr-load-more">加载更多 ${hitEntries.length}/${displayEntries.length}条</button><button class="btn ghost" id="sr-load-all">加载全部</button></div></div>` : displayEntries.length ? '<p class="tiny sr-list-end">已展示全部流水</p>' : ''}
    ${hitNotes.length ? `
    <section class="card list" aria-label="生活记录结果">
      <div class="sr-list-head"><h3>生活记录（${hitNotes.length}）</h3></div>
      ${hitNotes.map(noteRow).join('')}
    </section>` : ''}`;
  resultsEl.setAttribute('aria-busy', 'false');
  const summaryRow = resultsEl.querySelector<HTMLElement>('.sr-summary-row');
  if (summaryRow) summaryRow.scrollLeft = summaryScroll;
  if (focusedSummary) resultsEl.querySelector<HTMLButtonElement>(`[data-sf="${focusedSummary}"]`)?.focus({ preventScroll: true });
  updateBatchControls();
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
    releaseOverlay();
    sheet.classList.remove('open');
    setTimeout(() => sheet.remove(), 250);
  }
  sheet.setAttribute('aria-label','选择匹配项');
  const releaseOverlay = manageOverlay(sheet, close);

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
function updateDateDisplay(win = rangeWindow()): void {
  if (!body) return;
  const fromBtn = body.querySelector<HTMLElement>('#sr-date-from');
  const toBtn = body.querySelector<HTMLElement>('#sr-date-to');
  if (!fromBtn || !toBtn) return;

  // 预设日期从查询窗口派生：上界为下月 1 日（不包含），显示为月末。
  if (win && dateRange !== 'custom') {
    customFrom = tsToDateResult(win.from);
    customTo = tsToDateResult(win.to - 1);
  }
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
      accountScope = preset?.accountScope;
      batchMode = false;
      batchSelectAll = false;
      batchSelected.clear();
      batchResultIds = [];
      shown = PAGE_SIZE;
      lastQueryKey = '';

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
            <button class="sr-clear" id="sr-clear-input" type="button" aria-label="清空搜索"${initialKeyword ? '' : ' hidden'}>${iconHtml('ic-close', 14)}</button>
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

      const subpage = el.closest<HTMLElement>('.subpage')!;
      const head = subpage.querySelector<HTMLElement>('.sub-head')!;
      const batchButton = document.createElement('button');
      batchButton.className = 'chip sr-batch-button';
      batchButton.id = 'sr-batch';
      batchButton.textContent = '批量';
      batchButton.hidden = true;
      head.appendChild(batchButton);
      const batchBar = document.createElement('div');
      batchBar.className = 'batch-bar sr-batch-bar';
      batchBar.id = 'sr-batch-bar';
      batchBar.hidden = true;
      batchBar.innerHTML = `
        <span class="sub" id="sr-batch-count">已选 0 笔</span>
        <button class="chip" id="sr-batch-all">全选结果</button>
        <button class="chip" data-batch-act="category">改分类</button>
        <button class="chip" data-batch-act="account">改账户</button>
        <button class="chip" data-batch-act="tag-add">加标签</button>
        <button class="chip" data-batch-act="tag-remove">移标签</button>
        <button class="chip danger" data-batch-act="delete">回收站</button>`;
      subpage.appendChild(batchBar);

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

      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          window.clearTimeout(timer);
          if (input.value.trim()) void saveHistory(input.value.trim());
          void doSearch(input.value.trim());
        }
      });

      // 清空输入
      clearBtn.addEventListener('click', () => {
        window.clearTimeout(timer);
        input.value = '';
        clearBtn.hidden = true;
        input.focus();
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
        if (range === 'custom') {
          // 打开开始日期选择
          openFromDateWheel();
        } else {
          dateRange = range;
          for (const c of el.querySelectorAll<HTMLElement>('#sr-dates .chip')) c.classList.toggle('active', c === chip);
          customFrom = null;
          customTo = null;
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
            const end = customTo ?? getDefaultTo();
            try { validateDateRange(new Date(r.year, r.month - 1, r.day).getTime(), new Date(end.year, end.month - 1, end.day).getTime()); }
            catch (error) { showToast((error as Error).message); return; }
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
            const start = customFrom ?? getDefaultFrom();
            try { validateDateRange(new Date(start.year, start.month - 1, start.day).getTime(), new Date(r.year, r.month - 1, r.day).getTime()); }
            catch (error) { showToast((error as Error).message); return; }
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
        let releasePanel: () => void = () => {};
        const panel = await createFilterPanel({
          initial: filterState,
          accountScope,
          onConfirm(state) {
            filterState = state;
            releasePanel();
            panel.remove();
            // 更新漏斗图标状态
            el.querySelector('#sr-adv-filter')!.classList.toggle('active', !isFilterEmpty(filterState));
            triggerSearch();
          },
          onCancel() {
            releasePanel();
            panel.remove();
          },
        });
        document.body.appendChild(panel);
        panel.setAttribute('aria-label','高级筛选');
        releasePanel = manageOverlay(panel, () => { releasePanel(); panel.remove(); });
      });

      batchButton.addEventListener('click', () => {
        batchMode = !batchMode;
        batchSelectAll = batchMode;
        batchSelected.clear();
        if (batchMode) batchResultIds.forEach((id) => batchSelected.add(id));
        void doSearch(input.value.trim());
      });

      async function runBatch(
        operation: BatchEntryOperation,
        copy: { title: string; okText: string; success: string; danger?: boolean; recovery?: string },
      ): Promise<void> {
        if (!batchSelected.size) { showToast('当前没有已选账单'); return; }
        let preview: BatchEntryPreview;
        try {
          preview = await previewBatchEntries([...batchSelected], operation);
        } catch (error) {
          showToast(`批量操作无法执行：${error instanceof Error ? error.message : String(error)}`);
          return;
        }
        if (!preview.processableIds.length) {
          showToast(`没有可处理的账单。${batchPreviewText(preview)}`);
          return;
        }
        const ok = await confirmDialog({
          title: copy.title,
          message: `${batchPreviewText(preview)}${copy.recovery ? `。${copy.recovery}` : ''}`,
          okText: copy.okText,
          danger: copy.danger,
        });
        if (!ok) return;
        batchBar.setAttribute('aria-busy', 'true');
        batchBar.querySelectorAll<HTMLButtonElement>('button').forEach((button) => { button.disabled = true; });
        const progress = batchBar.querySelector<HTMLElement>('#sr-batch-count');
        if (progress) progress.textContent = `正在处理 ${preview.processableIds.length} 笔…`;
        let result: BatchEntryResult;
        try {
          result = await applyBatchEntries([...batchSelected], operation);
        } catch (error) {
          showToast(`批量操作失败，已回滚整批修改：${error instanceof Error ? error.message : String(error)}`);
          batchBar.setAttribute('aria-busy', 'false');
          batchBar.querySelectorAll<HTMLButtonElement>('button').forEach((button) => { button.disabled = false; });
          updateBatchControls();
          return;
        }
        try {
          batchMode = false;
          batchSelectAll = false;
          batchSelected.clear();
          showToast(`${copy.success} ${result.appliedIds.length} 笔${result.skipped.length ? `，跳过 ${result.skipped.length} 笔` : ''}`);
          await doSearch(input.value.trim());
        } catch (error) {
          showToast(`${copy.success}已完成，但结果刷新失败：${error instanceof Error ? error.message : String(error)}`);
        } finally {
          batchBar.setAttribute('aria-busy', 'false');
          batchBar.querySelectorAll<HTMLButtonElement>('button').forEach((button) => { button.disabled = false; });
          updateBatchControls();
        }
      }

      batchBar.addEventListener('click', (event) => {
        const target = event.target as HTMLElement;
        if (target.closest('#sr-batch-all')) {
          const allSelected = batchResultIds.length > 0 && batchSelected.size === batchResultIds.length;
          batchSelected.clear();
          if (!allSelected) batchResultIds.forEach((id) => batchSelected.add(id));
          batchSelectAll = !allSelected;
          void doSearch(input.value.trim());
          return;
        }
        const action = target.closest<HTMLElement>('[data-batch-act]')?.dataset.batchAct;
        if (!action) return;
        void (async () => {
          if (!batchSelected.size) { showToast('请先选择账单'); return; }
          if (action === 'category') {
            const categoryId = await sheetPick('改分类（不适用的账单会说明跳过原因）', batchCategories.map((category) => ({
              id: category.id,
              label: `${category.kind === 'expense' ? '支出' : '收入'} · ${category.name}`,
              icon: category.icon,
            })));
            if (categoryId != null) await runBatch(
              { kind: 'category', categoryId },
              { title: '确认修改全部已选账单的分类？', okText: '修改', success: '已改分类' },
            );
          } else if (action === 'account') {
            const accountId = await sheetPick('改账户（转账与借贷会跳过）', batchAccounts.map((account) => ({
              id: account.id, label: account.name, icon: 'ic-wallet', note: formatFen(account.balance),
            })));
            if (accountId != null) await runBatch(
              { kind: 'account', accountId },
              { title: '确认修改全部已选账单的账户？', okText: '修改', success: '已改账户' },
            );
          } else if (action === 'tag-add' || action === 'tag-remove') {
            if (!batchTags.length) { showToast('还没有可用标签，请先在设置中创建'); return; }
            const tagId = await sheetPick(action === 'tag-add' ? '添加标签' : '移除标签', batchTags.map((tag) => ({
              id: tag.id, label: tag.name, icon: 'ic-tag',
            })));
            if (tagId != null) {
              const adding = action === 'tag-add';
              await runBatch(
                { kind: 'tags', mode: adding ? 'add' : 'remove', tagIds: [tagId] },
                { title: `确认${adding ? '添加' : '移除'}所选标签？`, okText: adding ? '添加' : '移除', success: `已${adding ? '添加' : '移除'}标签` },
              );
            }
          } else if (action === 'delete') {
            await runBatch(
              { kind: 'delete' },
              {
                title: `将 ${batchSelected.size} 笔账单移入回收站？`, okText: '移入回收站', success: '已移入回收站',
                danger: true, recovery: '30 天内可从回收站恢复',
              },
            );
          }
        })();
      });

      // 结果区点击事件代理
      el.addEventListener('click', (e) => {
        const t = e.target as HTMLElement;
        const entity = t.closest<HTMLElement>('[data-entity-kind]');
        if (entity) { openEntityInsight(entity.dataset.entityKind as 'tag' | 'merchant', Number(entity.dataset.entityId)); return; }
        if (t.closest('#sr-load-all')) { shown = Number.MAX_SAFE_INTEGER; void doSearch(input.value.trim()); return; }
        if (t.closest('#sr-load-more')) { shown += PAGE_SIZE; void doSearch(input.value.trim()); return; }

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
          else if (kind === 'type') { queryTypes = []; summaryFilter = 'all'; }
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
          summaryFilter = sf.dataset.sf as SearchSummaryFilter;
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
        if (batchMode && entryRow) {
          if (entryRow.hasAttribute('data-reimbursement')) {
            showToast('报销到账是原支出的展示事件，请选择原账单操作');
            return;
          }
          const id = Number(entryRow.dataset.eid);
          if (batchSelected.has(id)) batchSelected.delete(id);
          else batchSelected.add(id);
          batchSelectAll = batchResultIds.length > 0 && batchSelected.size === batchResultIds.length;
          entryRow.querySelector('.ck')?.classList.toggle('on', batchSelected.has(id));
          updateBatchControls();
          return;
        }
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
          const noteRow = t.closest<HTMLElement>('[data-nid]')!;
          focusLifeRecord(Number(nid), Number(noteRow.dataset.noteAt));
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
