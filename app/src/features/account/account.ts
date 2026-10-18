/**
 * 拾光 · 账户页（features/account，PRD 4.6）
 * 顶部资产卡（净资产 + 近 6 个月走势线）、四组分组列表（折叠/小计）、
 * 添加/编辑账户、单账户流水、对账调整余额，以及分组账户管理。
 * 视觉结构与原型 index.html #page-acct（L680-738）一致；数据一律经 repo，
 * 金额格式化只走 money.ts。
 */
import './account.css';
import { balanceTrendHtml, bindTrendControls, type TrendViewState } from './balanceTrend';
import { iconHtml } from '../../assets/icons';
import { esc } from '../../core/esc';
import { on } from '../../core/store';
import { formatFen, formatFenCny, parseYuanToFen } from '../../core/money';
import {
  addAccount, creditLimitStatus, deleteAccount, getAccount, getNetWorth, listAccountsByGroup, previewReconcileAccount,
  reconcileAccount, reorderAccountWithinGroup, setAccountCountInNetWorth, setAccountHidden, updateAccount,
} from '../../core/repo/accountRepo';
import { netWorthTrend } from '../../core/repo/statsRepo';
import { getEntry, dayKey } from '../../core/repo/entryRepo';
import { getAccountViewData } from '../../core/repo/accountViewRepo';
import { accountFlows, accountMonthRows, accountStatement, accountActiveMonthRows, type LedgerItem } from '../../core/ledgerEvents';
import { accountEffects } from '../../core/entryEffects';
import { registerPage, registerSubpage, openSubpage, currentPage, SUBPAGE_CLOSE_EVENT } from '../shell/router';
import { openSheet, closeSheet } from '../shell/sheet';
import { openEntrySheet } from '../entry/entrySheet';
import { openEntryDetail } from '../detail/detail';
import {
  bindEntrySwipeActions, entrySwipeActionsHtml, runEntryQuickAction, type EntryQuickAction,
} from '../detail/entrySwipe';
import { showToast } from '../shell/toast';
import { confirmDialog } from '../shell/dialog';
import { entryRowText } from '../detail/entryRowText';
import { categoryDisplayMap } from '../../core/categoryIcons';
import {
  ACCOUNT_GROUPS, ACCOUNT_GROUP_NAMES,
  type Account, type AccountGroup, type Entry,
} from '../../core/types';

/* ── 模块状态 ── */
let root: HTMLElement | undefined;
/** 折叠中的分组（跨刷新保持） */
const folded = new Set<AccountGroup>();
/** 并发刷新令牌 */
let refreshToken = 0;
let needsRefresh = true;
let refreshedDay = '';

function showAccounts(): void {
  if (needsRefresh || refreshedDay !== dayKey(Date.now())) void refresh();
}

function invalidateAccounts(): void {
  needsRefresh = true;
  void refresh();
}
const netTrendState: TrendViewState = { open: false };
const accountTrendStates = new Map<number, TrendViewState>();
/** 抽屉监听器控制：#sheet 为复用容器，重开前必须废止上一次绑定，否则监听器叠加导致重复提交 */
let sheetAbort: AbortController | undefined;
let detailAccountId: number | undefined;

/** 废止上一抽屉的监听器并返回本次绑定用的 signal */
function sheetSignal(): AbortSignal {
  sheetAbort?.abort();
  sheetAbort = new AbortController();
  return sheetAbort.signal;
}

/** 账户组 → 行图标（与原型一致：现金钱包、卡片、网络支付） */
const GROUP_ICONS: Record<AccountGroup, string> = {
  cash: 'ic-wallet',
  credit: 'ic-card',
  debit: 'ic-card',
  online: 'ic-pay',
  investment: 'ic-chart',
  receivable: 'ic-coin',
  stored: 'ic-card',
  other: 'ic-wallet',
};

/** 解析可带负号的元输入（信用卡余额），符号在 UI 层处理，换算仍走 money.ts */
function parseSignedYuan(input: string): number {
  const s = input.trim();
  const neg = s.startsWith('-');
  const fen = parseYuanToFen(neg ? s.slice(1) : s);
  return neg ? -fen : fen;
}

/** 信用卡还款日 → 下一个还款日期文案，如 '9月10日 还款' */
function repayNote(a: Account): string | undefined {
  if (a.group !== 'credit' || !a.repayDay) return undefined;
  const today = new Date();
  let y = today.getFullYear();
  let m = today.getMonth();
  if (today.getDate() > a.repayDay) {
    m += 1;
    if (m > 11) { m = 0; y += 1; }
  }
  const day = Math.min(a.repayDay, new Date(y, m + 1, 0).getDate());
  return `${m + 1}月${day}日 还款`;
}

/** 行备注：信用卡展示还款日与剩余额度，其余展示备注 */
function rowNote(a: Account): string {
  const limit = creditLimitStatus(a);
  const limitNote = limit
    ? limit.overLimit > 0
      ? `已超额 ${formatFenCny(limit.overLimit)}`
      : `剩余额度 ${formatFenCny(limit.remaining)}`
    : undefined;
  const creditNotes = [limitNote, repayNote(a)].filter(Boolean);
  return creditNotes.length ? creditNotes.join(' · ') : a.note ?? '';
}

/* ── 顶部资产卡 ── */

/* ── 页面渲染 ── */

/** 重新取数并整页刷新 */
async function refresh(): Promise<void> {
  if (!root || root.inert || currentPage() !== 'page-acct') return;
  needsRefresh = true;
  const token = ++refreshToken;
  const [worth, groups] = await Promise.all([
    getNetWorth(),
    listAccountsByGroup(),
  ]);
  if (token !== refreshToken || !root || root.inert || currentPage() !== 'page-acct') return;

  const all = ACCOUNT_GROUPS.flatMap((g) => groups[g]);
  const hidden = all.filter((a) => a.hidden);
  const subHead = `${all.length} 个账户${hidden.length ? ` · ${hidden.length} 个已隐藏` : ''} · 数据仅保存在本机`;

  const groupCards = ACCOUNT_GROUPS.map((g) => {
    const rows = groups[g].filter((a) => !a.hidden);
    if (rows.length === 0) return '';
    const subtotal = rows.reduce((sum, a) => sum + a.balance, 0);
    return `
      <section class="card list acct-group${folded.has(g) ? ' folded' : ''}" aria-label="${ACCOUNT_GROUP_NAMES[g]}账户">
        <button class="row group-head" data-group="${g}" aria-expanded="${!folded.has(g)}">${ACCOUNT_GROUP_NAMES[g]}<span class="g-count">${rows.length} 个</span><span class="acct-amt num${subtotal < 0 ? ' neg' : ''}">${formatFenCny(subtotal)}</span><span class="chev">${iconHtml('ic-right')}</span></button>
        <div class="g-rows">
          ${rows.map((a) => `
            <button class="row acct-account-row" data-acct="${a.id}"><span class="e-ic">${iconHtml(GROUP_ICONS[g], 18)}</span><span class="acct-row-copy"><span class="acct-row-name">${esc(a.name)}</span>${rowNote(a) ? `<span class="row-note">${esc(rowNote(a))}</span>` : ''}</span><span class="acct-amt num${a.balance < 0 ? ' neg' : ''}">${formatFenCny(a.balance)}</span></button>`).join('')}
        </div>
      </section>`;
  }).join('');

  root.innerHTML = `
    <header class="page-head">
      <div>
        <h1 class="brand sm">账户</h1>
        <p class="sub">${subHead}</p>
      </div>
      <div class="account-head-actions"><button class="chip" data-account-manage>管理</button><button class="icon-btn" data-add aria-label="添加账户">${iconHtml('ic-plus')}</button></div>
    </header>

    <section class="card asset acct-hero">
      <div class="asset-summary overview-art">
        <p class="label">净资产</p>
        <p class="big num">${formatFenCny(worth.net)}</p>
        <div class="asset-row">
          <p>总资产<span class="num">${formatFenCny(worth.assets)}</span></p>
          <p>总负债<span class="num">${formatFenCny(worth.debts)}</span></p>
        </div>
      </div>
      <div data-net-trend><details class="balance-trend" ${netTrendState.open ? 'open' : ''} aria-label="净资产走势">
        <summary class="balance-trend-heading"><strong>净资产走势</strong><span class="trend-expand">展开</span><span class="trend-collapse">收起</span></summary>
        <p class="sub" role="status">正在读取走势…</p>
      </details></div>
    </section>

    ${groupCards || `
      <section class="card">
        <p class="sub" style="text-align:center;padding:18px 0">还没有可展示的账户<br>点右上角 <b>＋</b> 添加现金、储蓄卡、网络账户或信用卡</p>
      </section>`}
    <p class="tiny" style="text-align:center;padding:4px 0 10px">点账户看流水，更多设置见「管理」</p>`;

  // 账户列表可立即操作，不等待尚未展开的历史走势。
  const el = root;
  const trend = await netWorthTrend(6, netTrendState.endingMonth);
  if (token !== refreshToken || root !== el || !el.isConnected || el.inert || currentPage() !== 'page-acct') return;
  const host = el.querySelector<HTMLElement>('[data-net-trend]');
  if (!host) return;
  // toggle 事件可能尚未派发，直接保留用户刚刚展开／收起的实时状态。
  const details = host.querySelector<HTMLDetailsElement>('details');
  if (details) netTrendState.open = details.open;
  const focused = host.contains(document.activeElement);
  host.innerHTML = balanceTrendHtml(trend, '净资产', netTrendState);
  if (focused) host.querySelector<HTMLElement>('summary')?.focus();
  needsRefresh = false;
  refreshedDay = dayKey(Date.now());
}

/* ── 账户详情抽屉（流水 / 编辑 / 对账 / 隐藏） ── */

/** 单账户视角的金额增减（分；正 = 流入该账户） */
function flowDelta(e: Entry, acctId: number): number {
  return accountEffects({ ...e, reimbursedAmount: undefined })
    .filter(effect => effect.accountId === acctId).reduce((sum, effect) => sum + effect.delta, 0);
}

/** 流水条目 HTML（复用原型 .entry 结构 + .entry-swipe 左滑外壳，与首页/明细同一套操作） */
function flowEntryHtml(
  e: LedgerItem,
  acctId: number,
  catMap: Map<number, { name: string; icon: string }>,
  acctNames: Map<number, string>,
  balanceAfter: number,
): string {
  const text = entryRowText(e, catMap, acctNames);
  const sub = text.note ? ` <span class="e-sub">· ${esc(text.note)}</span>` : '';
  const delta = flowDelta(e, acctId);
  return `<div class="entry-swipe" data-eid="${e.id}"${e.kind === 'reimbursement' ? ' data-reimbursement' : ''}>
    ${e.kind === 'reimbursement' ? '' : entrySwipeActionsHtml(e)}
    <article class="entry entry-swipe-content" role="button" tabindex="0">
      <span class="e-ic${text.neutral ? ' neutral' : ''}">${iconHtml(text.icon, 18)}</span>
      <div class="e-main"><p class="e-title">${esc(text.title)}${sub}</p><p class="e-meta">${esc(text.meta)}</p></div>
      <div class="account-entry-amounts">
        <p class="e-amt num ${delta < 0 ? 'out' : 'in'}">${formatFen(delta, { sign: true })}</p>
        <p class="account-entry-balance num" aria-label="本笔后余额 ${formatFenCny(balanceAfter)}">余额 ${formatFen(balanceAfter)}</p>
      </div>
    </article>
  </div>`;
}

/** 从账户一级页进入账户详情子页。 */
export function openAccountDetail(id: number): void {
  detailAccountId = id;
  openSubpage('sp-account-detail');
}

/** 账户详情：余额趋势、月度流入流出与逐笔流水。 */
async function renderAccountDetail(body: HTMLElement): Promise<void> {
  const accountId = detailAccountId;
  if (accountId == null) { body.innerHTML = '<p class="tiny">未指定账户</p>'; return; }
  const targetAccountId = accountId;
  const trendState = accountTrendStates.get(accountId) ?? { open: false };
  accountTrendStates.set(accountId, trendState);
  bindTrendControls(body, trendState, renderDetail);
  let currentAccount: Account | undefined;
  let monthsShown = 8;
  let detailToken = 0;
  const expandedMonths = new Set<string>();
  const monthEntryContent = new Map<string, (from?: number) => string>();
  const entriesShown = new Map<string, number>();
  const entryPageSize = 80;
  let snapshot: {
    account: Account;
    flows: ReturnType<typeof accountStatement>;
    balances: Map<LedgerItem, number>;
    catMap: ReturnType<typeof categoryDisplayMap>;
    acctNames: Map<number, string>;
    activeMonths: ReturnType<typeof accountActiveMonthRows>;
    totalIn: number;
    totalOut: number;
  } | undefined;
  let initializedMonths = false;
  body.classList.add('account-detail-body');
  const subpage = body.closest<HTMLElement>('.subpage')!;
  subpage.querySelector('.account-detail-footer')?.remove();
  const footer = document.createElement('div');
  footer.className = 'account-detail-footer';
  footer.hidden = true;
  subpage.appendChild(footer);
  footer.addEventListener('click', event => {
    if ((event.target as HTMLElement).closest('[data-account-action="entry"]') && currentAccount) {
      void openEntrySheet({ presetAccountId: currentAccount.id });
    }
  });

  async function refreshDetail(): Promise<void> {
    const token = ++detailToken;
    const data = await getAccountViewData(targetAccountId);
    if (token !== detailToken || !body.isConnected) return;
    if (!data) {
      snapshot = undefined; monthEntryContent.clear(); footer.hidden = true; currentAccount = undefined;
      body.innerHTML = '<div class="placeholder"><p class="sub">账户不存在</p></div>'; return;
    }
    const flows = accountStatement(accountFlows(data.entries, targetAccountId), data.account.balance);
    snapshot = {
      account: data.account, flows, balances: new Map(flows.map(flow => [flow.entry, flow.balanceAfter])),
      catMap: categoryDisplayMap(data.categories), acctNames: new Map(data.accounts.map(account => [account.id, account.name])),
      activeMonths: accountActiveMonthRows(flows),
      totalIn: flows.reduce((sum, flow) => Math.max(0, flow.delta) + sum, 0),
      totalOut: flows.reduce((sum, flow) => Math.max(0, -flow.delta) + sum, 0),
    };
    renderDetail();
  }

  function renderDetail(): void {
    if (!snapshot) return;
    const scroll = body.scrollTop;
    const { account: acct, flows, balances, catMap, acctNames, activeMonths, totalIn, totalOut } = snapshot;
    currentAccount = acct;
    body.closest<HTMLElement>('.subpage')!.querySelector<HTMLElement>('.sub-head h2')!.textContent = acct.name;
    const monthRows = activeMonths.slice(0, monthsShown);
    const availableMonths = activeMonths.length;
    if (!initializedMonths && monthRows.length) {
      expandedMonths.add(monthRows[0].key);
      initializedMonths = true;
    }
    const limit = creditLimitStatus(acct);
    const trendAt = trendState.endingMonth ? new Date(`${trendState.endingMonth}-01T12:00:00`).getTime() : Date.now();
    const trend = accountMonthRows(flows, acct.balance, trendAt, 6).reverse().map((row) => ({ month: row.key, net: row.closing }));

    // 收起的历史月份不生成账单 DOM，避免进入单条详情时处理大量不可见节点。
    monthEntryContent.clear();
    for (const row of monthRows) {
      monthEntryContent.set(row.key, (from = 0) => {
        const shown = entriesShown.get(row.key) ?? entryPageSize;
        return row.entries.slice(from, shown)
          .map(entry => flowEntryHtml(entry, targetAccountId, catMap, acctNames, balances.get(entry)!)).join('')
          + (shown < row.entries.length ? `<button class="account-more-entries" data-account-more-entries="${row.key}">查看更多流水（${shown} / ${row.entries.length} 笔）</button>` : '');
      });
    }
    body.innerHTML = `
      <section class="account-detail-hero">
        <div class="account-detail-overview overview-art">
          <div class="account-detail-top"><span>${ACCOUNT_GROUP_NAMES[acct.group]}</span><small>${esc(repayNote(acct) ?? acct.note ?? '人民币账户')}</small></div>
          <div class="account-balance-overview${limit ? ' has-limit' : ''}">
            <div class="account-current-balance"><p>当前余额</p><h3 class="num${acct.balance < 0 ? ' neg' : ''}">${formatFenCny(acct.balance)}</h3></div>
            ${limit ? `<div class="credit-limit-side">
              <p><span>信用额度</span><b class="num">${formatFenCny(limit.limit)}</b></p>
              <p><span>${limit.overLimit > 0 ? '已超额' : '剩余额度'}</span><b class="num${limit.overLimit > 0 ? ' neg' : ''}">${formatFenCny(limit.overLimit || limit.remaining)}</b></p>
            </div>` : ''}
          </div>
          <div class="account-flow-total"><span>总流入 <b class="num">${formatFenCny(totalIn)}</b></span><span>总流出 <b class="num">${formatFenCny(totalOut)}</b></span></div>
        </div>
        <div class="account-detail-controls">
          ${balanceTrendHtml(trend, '账户余额', trendState)}
          <div class="account-detail-actions">
            <button data-account-action="edit">${iconHtml('ic-pen', 17)}编辑</button>
            <button data-account-action="reconcile">${iconHtml('ic-swap', 17)}对账</button>
          </div>
        </div>
      </section>
      <div class="account-months" id="account-months">
        ${monthRows.map((row) => {
          const [year, month] = row.key.split('-');
          return `<section class="account-month${expandedMonths.has(row.key) ? ' expanded' : ''}" data-account-month="${row.key}">
            <button class="account-month-head" aria-expanded="${expandedMonths.has(row.key)}">
              <span class="account-month-date"><b>${Number(month)}月</b><small>${year}</small></span>
              <span class="account-month-flow"><i>流入 ${formatFenCny(row.income)}</i><i>流出 ${formatFenCny(row.expense)}</i></span>
              <span class="account-month-balance"><b class="num">${formatFen(row.closing)}</b><small>余额</small></span>
              <span class="chev">${iconHtml('ic-right', 15)}</span>
            </button>
            <div class="account-month-entries">
              ${expandedMonths.has(row.key) ? monthEntryContent.get(row.key)!() : ''}
            </div>
          </section>`;
        }).join('') || '<p class="acct-flow-empty">暂无流水</p>'}
      </div>
      ${monthsShown < availableMonths ? `<div class="account-history-actions">
        <button class="btn ghost" data-account-action="all-months">加载全部</button>
        <button class="btn ghost" data-account-action="more-months">查看更早的流水</button>
      </div>` : ''}`;
    footer.innerHTML = `<button class="account-detail-entry" id="account-detail-entry" data-account-action="entry">
        ${iconHtml('ic-plus', 18)}<span>从「${esc(acct.name)}」记一笔</span>
      </button>`;
    footer.hidden = false;
    body.scrollTop = scroll;
  }

  body.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const actionButton = target.closest<HTMLElement>('[data-entry-action]');
    const entryRow = target.closest<HTMLElement>('[data-eid]');
    if (entryRow?.dataset.swipeSuppress === 'true') return;
    if (actionButton && entryRow) {
      if (actionButton.getAttribute('aria-disabled') === 'true') { showToast('仅普通支出账单支持退款'); return; }
      void getEntry(Number(entryRow.dataset.eid)).then((entry) => {
        if (entry) void runEntryQuickAction(actionButton.dataset.entryAction as EntryQuickAction, entry);
      });
      return;
    }
    if (entryRow) { openEntryDetail(Number(entryRow.dataset.eid)); return; }
    const month = target.closest<HTMLElement>('[data-account-month]');
    if (month && target.closest('[data-account-more-entries]')) {
      const key = month.dataset.accountMonth!;
      entriesShown.set(key, (entriesShown.get(key) ?? entryPageSize) + entryPageSize);
      // 追加新行，保留现有行、滚动位置和键盘焦点。
      const rows = month.querySelector<HTMLElement>('.account-month-entries')!;
      const visible = rows.querySelectorAll('[data-eid]').length;
      target.closest('[data-account-more-entries]')!.remove();
      rows.insertAdjacentHTML('beforeend', monthEntryContent.get(key)?.(visible) ?? '');
      const nextFocus = rows.querySelector<HTMLElement>('[data-account-more-entries]')
        ?? rows.querySelectorAll<HTMLElement>('.entry-swipe-content')[visible];
      nextFocus?.focus({ preventScroll: true });
      return;
    }
    if (month && target.closest('.account-month-head')) {
      const expanded = month.classList.toggle('expanded');
      const key = month.dataset.accountMonth!;
      const rows = month.querySelector<HTMLElement>('.account-month-entries')!;
      if (expanded) {
        expandedMonths.add(key);
        rows.innerHTML = monthEntryContent.get(key)?.() ?? '';
      } else {
        expandedMonths.delete(key);
        rows.replaceChildren();
      }
      month.querySelector('.account-month-head')!.setAttribute('aria-expanded', String(expanded));
      return;
    }
    const action = target.closest<HTMLElement>('[data-account-action]')?.dataset.accountAction;
    const acct = currentAccount;
    if (!action || !acct) return;
    if (action === 'more-months') { monthsShown += 8; renderDetail(); }
    else if (action === 'all-months') { monthsShown = Infinity; renderDetail(); }
    else if (action === 'edit') void openAccountForm(acct);
    else if (action === 'reconcile') openReconcileSheet(acct);
  });
  body.addEventListener('keydown', event => {
    if (event.target instanceof HTMLElement && event.target.matches('.entry-swipe-content') && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault(); event.target.click();
    }
  });
  bindEntrySwipeActions(body);
  const offAccounts = on('accounts-changed', () => {
    if (!body.isConnected) { offAccounts(); return; }
    void refreshDetail();
  });
  const offEntries = on('entries-changed', () => {
    if (!body.isConnected) { offEntries(); return; }
    void refreshDetail();
  });
  subpage.addEventListener(SUBPAGE_CLOSE_EVENT, () => {
    detailToken++; snapshot = undefined; monthEntryContent.clear(); entriesShown.clear(); offAccounts(); offEntries();
  }, { once: true });
  await refreshDetail();
}

/* ── 隐藏 / 恢复显示 ── */

/** 隐藏或恢复账户；显示状态与净资产计入范围保持独立。 */
async function toggleHidden(acct: Account): Promise<void> {
  if (!acct.hidden) {
    const ok = await confirmDialog({
      title: `隐藏「${acct.name}」？`,
      message: '隐藏后该账户移入「已隐藏账户」分区，净资产计入范围保持不变，可随时恢复显示。',
      okText: '隐藏',
    });
    if (!ok) return;
  }
  closeSheet();
  await setAccountHidden(acct.id, !acct.hidden);
  showToast(acct.hidden ? `已恢复显示「${acct.name}」` : `已隐藏「${acct.name}」`);
}

/** 账户管理动作抽屉：集中承载编辑、净资产范围、隐藏恢复与受约束删除。 */
function openManagedAccountSheet(acct: Account): void {
  openSheet({
    ariaLabel: `管理账户：${acct.name}`,
    onClose: () => sheetAbort?.abort(),
    render(el) {
      el.innerHTML = `
        <div class="acct-sheet-head">
          <div><p class="sheet-title">${esc(acct.name)}</p><p class="tiny">${ACCOUNT_GROUP_NAMES[acct.group]} · ${formatFenCny(acct.balance)}</p></div>
          <button class="icon-btn" data-manage-action="close" aria-label="关闭">${iconHtml('ic-close')}</button>
        </div>
        <div class="sheet-scroll account-manage-sheet">
          <button class="row" data-manage-action="edit"><span class="e-ic">${iconHtml('ic-pen', 18)}</span><span>编辑账户</span><span class="row-note">名称、备注及信用卡信息</span></button>
          <button class="row" data-manage-action="networth"><span class="e-ic neutral">${iconHtml('ic-chart', 18)}</span><span>${acct.countInNetWorth === false ? '计入净资产' : '不计入净资产'}</span><span class="row-note">当前${acct.countInNetWorth === false ? '未计入' : '已计入'}</span></button>
          <button class="row" data-manage-action="visibility"><span class="e-ic neutral">${iconHtml('ic-eye', 18)}</span><span>${acct.hidden ? '恢复显示' : '隐藏账户'}</span><span class="row-note">${acct.hidden ? '重新显示在账户页' : '流水仍会保留'}</span></button>
          <button class="row danger" data-manage-action="delete"><span class="e-ic neutral">${iconHtml('ic-trash', 18)}</span><span>删除空账户</span><span class="row-note">仅无余额、无历史及引用时可删</span></button>
        </div>`;
      const signal = sheetSignal();
      el.addEventListener('click', (event) => {
        const action = (event.target as HTMLElement).closest<HTMLElement>('[data-manage-action]')?.dataset.manageAction;
        if (!action) return;
        if (action === 'close') closeSheet();
        else if (action === 'edit') void openAccountForm(acct);
        else if (action === 'networth') {
          void setAccountCountInNetWorth(acct.id, acct.countInNetWorth === false).then(() => {
            closeSheet();
            showToast(acct.countInNetWorth === false ? '已计入净资产' : '已不计入净资产');
          }).catch(error => showToast(error instanceof Error ? error.message : String(error)));
        } else if (action === 'visibility') {
          void toggleHidden(acct);
        } else if (action === 'delete') {
          closeSheet();
          void confirmDialog({
            title: `删除「${acct.name}」？`,
            message: '仅无余额、无历史流水及业务引用的空账户可以删除。',
            okText: '删除',
            danger: true,
          }).then(async (ok) => {
            if (!ok) return;
            try {
              await deleteAccount(acct.id);
              showToast(`已删除「${acct.name}」`);
            } catch (error) {
              showToast(error instanceof Error ? error.message : String(error));
            }
          });
        }
      }, { signal });
    },
  });
}

/** 账户管理子页：全部账户按分组展示，排序与设置均在列表原位完成。 */
function renderAccountManager(body: HTMLElement): void {
  body.classList.add('account-manage-body');

  async function refreshManager(): Promise<void> {
    const groups = await listAccountsByGroup();
    if (!body.isConnected) return;
    const cards = ACCOUNT_GROUPS.map((group) => {
      const rows = groups[group];
      if (!rows.length) return '';
      return `<section class="card list account-manage-group" data-manage-group="${group}" aria-label="${ACCOUNT_GROUP_NAMES[group]}账户管理">
        <div class="account-manage-group-head"><b>${ACCOUNT_GROUP_NAMES[group]}</b><span>${rows.length} 个</span></div>
        ${rows.map((account, index) => `<div class="row account-manage-row${account.hidden ? ' is-hidden' : ''}" data-manage-account="${account.id}">
          <span class="e-ic${account.hidden ? ' neutral' : ''}">${iconHtml(GROUP_ICONS[group], 18)}</span>
          <span class="account-manage-copy"><b>${esc(account.name)}</b><small>${account.hidden ? '已隐藏' : '显示中'} · ${account.countInNetWorth === false ? '不计入净资产' : '计入净资产'}</small></span>
          <span class="account-manage-sort">
            <button class="icon-btn" data-move="up" aria-label="上移「${esc(account.name)}」"${index === 0 ? ' disabled' : ''}>↑</button>
            <button class="icon-btn" data-move="down" aria-label="下移「${esc(account.name)}」"${index === rows.length - 1 ? ' disabled' : ''}>↓</button>
          </span>
          <button class="account-settings-link" data-account-settings>设置</button>
        </div>`).join('')}
      </section>`;
    }).join('');
    body.innerHTML = `<p class="sub account-manage-tip">账户按类型分组。上下箭头调整组内顺序；设置中可编辑、隐藏或调整净资产范围。</p>${cards || '<section class="card"><p class="sub" style="text-align:center;padding:18px 0">还没有账户</p></section>'}`;
  }

  body.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const row = target.closest<HTMLElement>('[data-manage-account]');
    if (!row) return;
    const id = Number(row.dataset.manageAccount);
    const move = target.closest<HTMLElement>('[data-move]')?.dataset.move as 'up' | 'down' | undefined;
    if (move) {
      void reorderAccountWithinGroup(id, move).catch(error => showToast(error instanceof Error ? error.message : String(error)));
      return;
    }
    if (target.closest('[data-account-settings]')) {
      void getAccount(id).then(account => account && openManagedAccountSheet(account));
    }
  });
  const off = on('accounts-changed', () => {
    if (!body.isConnected) { off(); return; }
    void refreshManager();
  });
  void refreshManager();
}

/* ── 添加 / 编辑账户表单 ── */

/** 添加（不传 acct）或编辑（传 acct）账户表单抽屉 */
export async function openAccountForm(acct?: Account, presetGroup: AccountGroup = 'cash'): Promise<void> {
  let group: AccountGroup = acct?.group ?? presetGroup;
  let negative = group === 'credit';
  openSheet({
    ariaLabel: acct ? '编辑账户' : '添加账户',
    onClose: () => sheetAbort?.abort(),
    render(el) {
      el.innerHTML = `
        <div class="acct-sheet-head">
          <p class="sheet-title">${acct ? '编辑账户' : '添加账户'}</p>
          <button class="icon-btn" data-act="close" aria-label="关闭">${iconHtml('ic-close')}</button>
        </div>
        <div class="sheet-scroll acct-form">
          <div class="field"><span>类型</span>
            <div class="chip-group acct-type-grid" id="af-group">
              ${ACCOUNT_GROUPS.map((g) => `<button class="chip${g === group ? ' active' : ''}" data-g="${g}">${g === 'debit' ? '储蓄卡' : ACCOUNT_GROUP_NAMES[g]}</button>`).join('')}
            </div>
          </div>
          <div class="field"><span>名称</span><input class="note" id="af-name" maxlength="20" placeholder="如 招行储蓄卡 ·6688" value="${esc(acct?.name ?? '')}"></div>
          ${acct ? '' : `<div class="field"><span>初始余额</span><div class="signed-amount"><button class="sign-toggle" type="button" id="af-sign" aria-label="切换余额正负" aria-pressed="${negative}">${negative ? '− 欠款' : '+ 余额'}</button><input class="note num" id="af-balance" aria-label="初始余额金额" inputmode="decimal" placeholder="0.00" value=""></div></div>`}
          <div class="field"><span>备注</span><input class="note" id="af-note" maxlength="30" placeholder="选填，如 工资卡" value="${esc(acct?.note ?? '')}"></div>
          <div class="field" id="af-limit-field"${group === 'credit' ? '' : ' hidden'}><span>信用额度</span><input class="note num" id="af-limit" inputmode="decimal" placeholder="如 50000.00，选填" value="${acct?.creditLimit != null ? formatFen(acct.creditLimit).replace(/,/g, '') : ''}"></div>
          <div class="field" id="af-bill-field"${group === 'credit' ? '' : ' hidden'}><span>账单日</span><input class="note num" id="af-bill" inputmode="numeric" placeholder="每月几号（1-31），选填" value="${acct?.billingDay ?? ''}"></div>
          <div class="field" id="af-repay-field"${group === 'credit' ? '' : ' hidden'}><span>还款日</span><input class="note num" id="af-repay" inputmode="numeric" placeholder="每月几号（1-31），选填" value="${acct?.repayDay ?? ''}"></div>
          <button class="btn primary" data-act="save" style="margin-top:10px">${acct ? '保存修改' : '添加账户'}</button>
          ${acct ? '<p class="tiny" style="text-align:center;margin-top:10px">余额由账单驱动，不能直接修改 · 需要校准请使用「对账」</p>' : ''}
        </div>`;
      el.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        if (target.closest('#af-sign')) {
          negative = !negative;
          const button = el.querySelector<HTMLButtonElement>('#af-sign')!;
          button.textContent = negative ? '− 欠款' : '+ 余额';
          button.setAttribute('aria-pressed', String(negative));
          return;
        }
        const chip = target.closest<HTMLElement>('[data-g]');
        if (chip) {
          group = chip.dataset.g as AccountGroup;
          negative = group === 'credit';
          const sign = el.querySelector<HTMLButtonElement>('#af-sign');
          if (sign) { sign.textContent = negative ? '− 欠款' : '+ 余额'; sign.setAttribute('aria-pressed', String(negative)); }
          for (const c of el.querySelectorAll<HTMLElement>('[data-g]')) c.classList.toggle('active', c === chip);
          el.querySelector<HTMLElement>('#af-limit-field')!.hidden = group !== 'credit';
          el.querySelector<HTMLElement>('#af-repay-field')!.hidden = group !== 'credit';
          el.querySelector<HTMLElement>('#af-bill-field')!.hidden = group !== 'credit';
          return;
        }
        const act = target.closest<HTMLElement>('[data-act]')?.dataset.act;
        if (act === 'close') closeSheet();
        else if (act === 'save') void save();
      }, { signal: sheetSignal() });

      async function save(): Promise<void> {
        const name = el.querySelector<HTMLInputElement>('#af-name')!.value.trim();
        if (!name) { showToast('请填写账户名称'); return; }
        const note = el.querySelector<HTMLInputElement>('#af-note')!.value.trim() || undefined;
        const repayRaw = el.querySelector<HTMLInputElement>('#af-repay')?.value.trim();
        let repayDay: number | undefined;
        let billingDay: number | undefined;
        const billRaw = el.querySelector<HTMLInputElement>('#af-bill')!.value.trim();
        if (group === 'credit' && billRaw) {
          billingDay = Number(billRaw);
          if (!Number.isInteger(billingDay) || billingDay < 1 || billingDay > 31) { showToast('账单日须为 1-31 的整数'); return; }
        }
        if (group === 'credit' && repayRaw) {
          repayDay = Number(repayRaw);
          if (!Number.isInteger(repayDay) || repayDay < 1 || repayDay > 31) { showToast('还款日须为 1-31 的整数'); return; }
        }
        try {
          const limitRaw = el.querySelector<HTMLInputElement>('#af-limit')!.value.trim();
          const creditLimit = group === 'credit' && limitRaw ? parseYuanToFen(limitRaw) : undefined;
          if (creditLimit != null && creditLimit <= 0) { showToast('信用额度须大于 0'); return; }
          if (acct) {
            await updateAccount(acct.id, { name, group, note, creditLimit, billingDay: group === 'credit' ? billingDay : undefined, repayDay: group === 'credit' ? repayDay : undefined });
            closeSheet();
            showToast('账户已更新');
          } else {
            const balRaw = el.querySelector<HTMLInputElement>('#af-balance')!.value.trim();
            const parsed = balRaw ? parseSignedYuan(balRaw) : 0;
            const balance = negative ? -Math.abs(parsed) : parsed;
            await addAccount({ name, group, balance, note, creditLimit, billingDay, repayDay });
            closeSheet();
            showToast(`已添加「${name}」`);
          }
        } catch (err) {
          showToast(err instanceof Error ? err.message : String(err));
        }
      }
    },
  });
}

/* ── 对账 ── */

/** 对账抽屉：输入实际余额，生成「余额对账调整」记录而非直接改数 */
function openReconcileSheet(acct: Account): void {
  let negative = acct.balance < 0;
  openSheet({
    ariaLabel: `对账：${acct.name}`,
    onClose: () => sheetAbort?.abort(),
    render(el) {
      el.innerHTML = `
        <div class="acct-sheet-head">
          <p class="sheet-title">对账 · ${esc(acct.name)}</p>
          <button class="icon-btn" data-act="close" aria-label="关闭">${iconHtml('ic-close')}</button>
        </div>
        <div class="sheet-scroll acct-form">
          <div class="acct-hero-mini" style="padding-top:4px">
            <p class="label">账内余额</p>
            <p class="big num${acct.balance < 0 ? ' neg' : ''}">${formatFenCny(acct.balance)}</p>
          </div>
          <div class="field"><span>实际余额</span><div class="signed-amount"><button class="sign-toggle" type="button" data-act="sign" aria-label="切换余额正负" aria-pressed="${negative}">${negative ? '− 欠款' : '+ 余额'}</button><input class="note num" id="rc-target" aria-label="实际余额金额" inputmode="decimal" placeholder="0.00" value="${formatFen(Math.abs(acct.balance)).replace(/,/g, '')}"></div></div>
          <p class="tiny" id="rc-preview" style="padding:2px 0 6px"></p>
          <button class="btn primary" data-act="save" style="margin-top:10px">生成对账调整</button>
          <p class="tiny" style="text-align:center;margin-top:10px">差额增加记为收入，减少记为支出</p>
        </div>`;
      const signal = sheetSignal();
      el.addEventListener('click', (e) => {
        const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
        if (act === 'close') closeSheet();
        else if (act === 'sign') {
          negative = !negative;
          const button = el.querySelector<HTMLButtonElement>('[data-act="sign"]')!;
          button.textContent = negative ? '− 欠款' : '+ 余额';
          button.setAttribute('aria-pressed', String(negative));
        }
        else if (act === 'save') void save();
        void preview();
      }, { signal });
      el.addEventListener('input', () => void preview(), { signal });

      async function preview(): Promise<void> {
        const box = el.querySelector<HTMLElement>('#rc-preview');
        if (!box) return;
        try {
          const parsed = parseSignedYuan(el.querySelector<HTMLInputElement>('#rc-target')!.value);
          const target = negative ? -Math.abs(parsed) : parsed;
          const info = await previewReconcileAccount(acct.id, target);
          box.textContent = info.difference === 0
            ? '账内与实际一致，无需调整'
            : `当前 ${formatFenCny(info.currentBalance)} · 实际 ${formatFenCny(info.targetBalance)} · 将生成 ${formatFen(info.difference, { sign: true })} 元调整记录`;
        } catch {
          box.textContent = '';
        }
      }

      async function save(): Promise<void> {
        try {
          const parsed = parseSignedYuan(el.querySelector<HTMLInputElement>('#rc-target')!.value);
          const target = negative ? -Math.abs(parsed) : parsed;
          const entryId = await reconcileAccount(acct.id, target);
          closeSheet();
          showToast(entryId == null ? '余额一致，无需调整' : `已生成对账调整：${formatFen(target - acct.balance, { sign: true })} 元`);
        } catch (err) {
          showToast(err instanceof Error ? err.message : String(err));
        }
      }
    },
  });
}

/* ── 页面装配 ── */

/** 渲染账户页并绑定交互（registerPage render，事件委托只绑一次） */
function render(el: HTMLElement): void {
  root = el;
  bindTrendControls(el, netTrendState, refresh);

  el.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target.closest('[data-account-manage]')) { openSubpage('sp-account-manage'); return; }
    if (target.closest('[data-add]')) { void openAccountForm(); return; }
    const head = target.closest<HTMLElement>('[data-group]');
    if (head) {
      const g = head.dataset.group as AccountGroup;
      const card = head.closest('.acct-group')!;
      if (folded.has(g)) folded.delete(g);
      else folded.add(g);
      card.classList.toggle('folded', folded.has(g));
      head.setAttribute('aria-expanded', String(!folded.has(g)));
      return;
    }
    const row = target.closest<HTMLElement>('[data-acct]');
    if (row) {
      void openAccountDetail(Number(row.dataset.acct));
    }
  });

  on('accounts-changed', invalidateAccounts);
  on('entries-changed', invalidateAccounts);

}

/** 注册账户一级页（覆盖占位页），main.ts 在 mountShell 后调用 */
export function registerAccountPage(): void {
  registerPage('page-acct', { render, onShow: showAccounts, onReveal: showAccounts });
  registerSubpage('sp-account-detail', {
    title: '账户详情',
    render(body) { void renderAccountDetail(body); },
  });
  registerSubpage('sp-account-manage', {
    title: '账户管理',
    render: renderAccountManager,
  });
}
