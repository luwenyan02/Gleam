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
import { registerSubpage, closeSubpage, switchPage } from '../shell/router';
import { showToast } from '../shell/toast';
import { on } from '../../core/store';
import { openEntryDetail } from '../detail/detail';
import {
  bindEntrySwipeActions, entrySwipeActionsHtml, runEntryQuickAction, type EntryQuickAction,
} from '../detail/entrySwipe';
import { LOAN_KIND_META, type Entry, type LifeNote } from '../../core/types';
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

/* ── 核心搜索逻辑 ── */
async function doSearch(kw: string): Promise<void> {
  const resultsEl = body?.querySelector<HTMLElement>('#sr-results');
  if (!resultsEl) return;
  const token = ++searchToken;

  // 无关键词时显示历史
  if (!kw) {
    const history = await loadHistory();
    if (token !== searchToken) return;
    renderHistory(resultsEl, history);
    return;
  }

  // 保存搜索历史
  void saveHistory(kw);

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

  // 按字段模式确定命中逻辑
  const hitCatIds = new Set<number>();
  const hitMerchantIds = new Set<number>();
  const hitAccountIds = new Set<number>();
  const hitTagEntryIds = new Set<number>();
  let amountMatch: number | null = null;

  if (fieldMode === 'all' || fieldMode === 'category') {
    for (const c of [...expenseCats, ...incomeCats]) if (c.name.includes(kw)) hitCatIds.add(c.id);
  }
  if (fieldMode === 'all' || fieldMode === 'merchant') {
    for (const m of merchants) if (m.name.includes(kw)) hitMerchantIds.add(m.id);
  }
  if (fieldMode === 'all' || fieldMode === 'account') {
    for (const a of accounts) if (a.name.includes(kw)) hitAccountIds.add(a.id);
  }
  if (fieldMode === 'all' || fieldMode === 'tag') {
    for (const t of tags.filter(t => t.name.includes(kw))) {
      for (const id of await listEntryIdsByTag(t.id)) hitTagEntryIds.add(id);
    }
  }
  if (fieldMode === 'amount') {
    const numVal = parseFloat(kw);
    if (!isNaN(numVal)) amountMatch = Math.round(numVal * 100); // 元→分
  }

  if (token !== searchToken || !resultsEl.isConnected) return;

  const win = rangeWindow();
  const inRange = (ts: number) => !win || (ts >= win.from && ts < win.to);

  // 高级筛选
  const hasAdvFilter = !isFilterEmpty(filterState);
  const advFilterCatIds = filterState.categoryIds.length ? new Set(filterState.categoryIds) : null;
  const advFilterAcctIds = filterState.accountIds.length ? new Set(filterState.accountIds) : null;
  const advFilterTagIds = filterState.tagIds.length ? new Set(filterState.tagIds) : null;
  const advFilterMerchantIds = filterState.merchantIds.length ? new Set(filterState.merchantIds) : null;
  const advAmountMin = filterState.amountMin ? Math.round(parseFloat(filterState.amountMin) * 100) : null;
  const advAmountMax = filterState.amountMax ? Math.round(parseFloat(filterState.amountMax) * 100) : null;

  // 如果有高级筛选标签，预加载
  let advFilterTagEntryIds: Set<number> | null = null;
  if (advFilterTagIds) {
    advFilterTagEntryIds = new Set<number>();
    for (const tid of advFilterTagIds) {
      for (const eid of await listEntryIdsByTag(tid)) advFilterTagEntryIds.add(eid);
    }
  }

  function entryMatchesKw(e: Entry): boolean {
    if (fieldMode === 'amount') {
      return amountMatch !== null && e.amount === amountMatch;
    }
    if (fieldMode === 'category') return e.categoryId != null && hitCatIds.has(e.categoryId);
    if (fieldMode === 'account') {
      return (e.accountId != null && hitAccountIds.has(e.accountId))
        || (e.fromAccountId != null && hitAccountIds.has(e.fromAccountId))
        || (e.toAccountId != null && hitAccountIds.has(e.toAccountId));
    }
    if (fieldMode === 'tag') return hitTagEntryIds.has(e.id);
    if (fieldMode === 'merchant') return e.merchantId != null && hitMerchantIds.has(e.merchantId);
    if (fieldMode === 'note') return (e.note ?? '').includes(kw);
    // all
    return (e.categoryId != null && hitCatIds.has(e.categoryId))
      || (e.note ?? '').includes(kw)
      || (e.merchantId != null && hitMerchantIds.has(e.merchantId))
      || hitTagEntryIds.has(e.id)
      || (e.accountId != null && hitAccountIds.has(e.accountId))
      || (e.fromAccountId != null && hitAccountIds.has(e.fromAccountId))
      || (e.toAccountId != null && hitAccountIds.has(e.toAccountId));
  }

  function entryMatchesAdv(e: Entry): boolean {
    if (!hasAdvFilter) return true;
    if (advFilterCatIds && (e.categoryId == null || !advFilterCatIds.has(e.categoryId))) return false;
    if (advFilterAcctIds) {
      const matchAcct = (e.accountId != null && advFilterAcctIds.has(e.accountId))
        || (e.fromAccountId != null && advFilterAcctIds.has(e.fromAccountId))
        || (e.toAccountId != null && advFilterAcctIds.has(e.toAccountId));
      if (!matchAcct) return false;
    }
    if (advFilterTagEntryIds && !advFilterTagEntryIds.has(e.id)) return false;
    if (advFilterMerchantIds && (e.merchantId == null || !advFilterMerchantIds.has(e.merchantId))) return false;
    if (advAmountMin !== null && e.amount < advAmountMin) return false;
    if (advAmountMax !== null && e.amount > advAmountMax) return false;
    return true;
  }

  const matchedEntries = entries.filter(e => inRange(e.occurredAt) && entryMatchesKw(e) && entryMatchesAdv(e));

  // 汇总
  let sumExpense = 0; let cntExpense = 0;
  let sumIncome = 0; let cntIncome = 0;
  for (const e of matchedEntries) {
    if (e.type === 'expense') { sumExpense += e.refundFlag ? -e.amount : e.amount; cntExpense++; }
    else if (e.type === 'income') { sumIncome += e.amount; cntIncome++; }
  }
  const balance = sumIncome - sumExpense;

  // 按汇总卡筛选显示
  let displayEntries = matchedEntries;
  if (summaryFilter === 'expense') displayEntries = matchedEntries.filter(e => e.type === 'expense');
  else if (summaryFilter === 'income') displayEntries = matchedEntries.filter(e => e.type === 'income');
  const hitEntries = displayEntries.slice(0, 100);

  // 生活记录搜索（仅 all/note 模式下）
  const hitNotes = (fieldMode === 'all' || fieldMode === 'note')
    ? notes.filter(n => inRange(n.occurredAt) && ((n.title ?? '').includes(kw) || (n.body ?? '').includes(kw))).slice(0, 50)
    : [];

  const entryRow = (e: Entry) => `
    <div class="entry-swipe" data-eid="${e.id}">
      ${entrySwipeActionsHtml(e)}
      <button class="row entry-swipe-content">
        <div class="e-main"><p class="e-title">${esc(entryTitle(e, catNames))}</p>
          <p class="e-meta">${dayKey(e.occurredAt)}${e.note ? ` · ${esc(e.note.slice(0, 30))}` : ''}</p></div>
        ${amountHtml(e)}
      </button>
    </div>`;
  const noteRow = (n: LifeNote) => `
    <button class="row" data-nid="${n.id}">
      <div class="e-main"><p class="e-title">${esc(n.title || '（无标题）')}</p>
        <p class="e-meta">${dayKey(n.occurredAt)}${n.body ? ` · ${esc(n.body.slice(0, 30))}` : ''}</p></div>
      <span class="chev">${iconHtml('ic-right', 15)}</span>
    </button>`;

  if (!hitEntries.length && !hitNotes.length) {
    resultsEl.innerHTML = `<p class="sr-empty">没有找到与「${esc(kw)}」相关的内容</p>`;
    return;
  }

  resultsEl.innerHTML = `
    ${matchedEntries.length ? `
    <div class="sr-summary-row">
      <div class="sr-summary-card${summaryFilter === 'all' ? ' active' : ''}" data-sf="all">
        <div class="sc-label">结余</div>
        <div class="sc-amount">${balance >= 0 ? '' : '-'}${formatFen(Math.abs(balance))}</div>
      </div>
      <div class="sr-summary-card${summaryFilter === 'expense' ? ' active' : ''}" data-sf="expense">
        <div class="sc-label">支出(${cntExpense})</div>
        <div class="sc-amount">${formatFen(sumExpense)}</div>
      </div>
      <div class="sr-summary-card${summaryFilter === 'income' ? ' active' : ''}" data-sf="income">
        <div class="sc-label">收入(${cntIncome})</div>
        <div class="sc-amount">${formatFen(sumIncome)}</div>
      </div>
    </div>` : ''}
    ${hitEntries.length ? `
    <section class="card list" aria-label="账单结果">
      <div class="sr-list-head"><h3>账单明细</h3></div>
      ${hitEntries.map(entryRow).join('')}
    </section>` : ''}
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
      // 重置状态
      dateRange = 'all';
      customFrom = null;
      customTo = null;
      fieldMode = 'all';
      filterState = emptyFilter();
      summaryFilter = 'all';

      const defFrom = getDefaultFrom();
      const defTo = getDefaultTo();

      el.innerHTML = `
        <div class="sr-topbar">
          <button class="sr-field-btn" id="sr-field-btn">${esc(FIELD_LABELS[fieldMode])} ▾</button>
          <div class="sr-input-wrap">
            <span class="sr-ic">${iconHtml('ic-search', 16)}</span>
            <input type="search" id="sr-input" placeholder="请输入关键词" aria-label="搜索关键词">
            <button class="sr-clear" id="sr-clear-input" hidden>${iconHtml('ic-close', 14)}</button>
          </div>
          <button class="sr-cancel" id="sr-cancel-btn">取消</button>
        </div>
        <div class="sr-date-row">
          <button class="sr-date-btn" id="sr-date-from">${dateStr(defFrom)} ▾</button>
          <span class="sr-date-sep">~</span>
          <button class="sr-date-btn" id="sr-date-to">${dateStr(defTo)} ▾</button>
          <button class="sr-filter-icon" id="sr-adv-filter" aria-label="高级筛选">
            <svg class="ic" viewBox="0 0 24 24"><path d="M3 6h18M6 12h12M9 18h6"/></svg>
          </button>
        </div>
        <div class="sr-dates" id="sr-dates" role="group" aria-label="日期范围">
          <button class="chip active" data-range="all">全部</button>
          <button class="chip" data-range="month">本月</button>
          <button class="chip" data-range="lastMonth">上月</button>
          <button class="chip" data-range="3m">近三月</button>
          <button class="chip" data-range="custom">自定义</button>
        </div>
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
      void doSearch('');
      window.setTimeout(() => input.focus(), 350);
    },
  });
}
