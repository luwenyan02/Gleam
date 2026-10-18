import { entryDisplayAmount } from '../../core/entryAmount';
/**
 * 拾光 · 日历账单（features/calendar，PRD 4.5）
 * 月历 + 所选日汇总与统一明细列表：点明细进详情，任意可记账日期可补一笔；
 * 分类/账户/标签/商家/金额筛选与热力、汇总、明细同源；返回保留月份、日期、
 * 模式、筛选与滚动位置。三种视图模式（标准 / 支出热力 / 结余热力）。
 */
import './calendar.css';
import { iconHtml } from '../../assets/icons';
import { esc } from '../../core/esc';
import { categoryDisplayMap } from '../../core/categoryIcons';
import { compactCalendarAmount } from './calendarAmount';
import { on } from '../../core/store';
import { formatFen, formatFenCny } from '../../core/money';
import { ledgerEntriesInRange } from '../../core/repo/statsRepo';
import { listCategories } from '../../core/repo/categoryRepo';
import { listAccounts } from '../../core/repo/accountRepo';
import { listEntryTagLinks } from '../../core/repo/tagRepo';
import { listMerchants } from '../../core/repo/merchantRepo';
import { getSetting } from '../../core/repo/settingsRepo';
import { ledgerItems } from '../../core/ledgerEvents';
import { expandCategoryIds, parseAmountRange } from '../../core/queryValidation';
import { filterLedgerEntries, summarizeLedgerEntries, type LedgerQuery } from '../../core/ledgerQuery';
import { entryRowText } from '../detail/entryRowText';
import { createFilterPanel, emptyFilter, isFilterEmpty, type FilterState } from '../search/filterPanel';
import { manageOverlay } from '../../shared/overlay';
import { openEntrySheet } from '../entry/entrySheet';
import { openEntryDetail } from '../detail/detail';
import { registerSubpage } from '../shell/router';
import { showToast } from '../shell/toast';

type CalMode = 'std' | 'heat' | 'net';
interface DayAgg { expense: number; income: number; count: number }

/* ── 模块状态（跨开合保留，返回不丢位置） ── */
let body: HTMLElement | undefined;
/** 并发刷新令牌 */
let refreshToken = 0;
let viewY = 0;
let viewM = 0;
/** 选中日 'YYYY-MM-DD'，空串表示未选中 */
let selKey = '';
let mode: CalMode = 'std';
let calFilter: FilterState = emptyFilter();
let savedScroll = 0;
let initialized = false;
/** 待应用的切换过渡类（拼进 .cal-grid，随本次重渲染消费）：月份切换淡入 / 模式切换色彩渐显 */
let pendingAnim: '' | 'anim-month' | 'anim-mode' = '';

const WD = ['日', '一', '二', '三', '四', '五', '六'];
const TIPS: Record<CalMode, string> = {
  std: '金额按元简写 · 点日期看完整金额 · 金点表示收入',
  heat: '颜色越深 = 当日支出越多 · 按当月最高单日支出定色阶',
  net: '绿色 = 当日结余为正（收入大于支出）· 主色 = 当日净支出',
};

function pad2(n: number): string { return String(n).padStart(2, '0'); }
function ymStr(y: number, m: number): string { return `${y}-${pad2(m + 1)}`; }
function keyOf(y: number, m: number, d: number): string { return `${ymStr(y, m)}-${pad2(d)}`; }

/** 热力/结余模式的单元格底色（原型 calCellStyle，L1578-1588） */
function cellStyle(rec: DayAgg | undefined, maxOut: number): string {
  if (!rec || mode === 'std') return '';
  if (mode === 'heat') {
    const k = Math.max(0, Math.min(1, rec.expense / maxOut));
    return ` style="background:color-mix(in oklab, var(--seed-primary) ${(k * 38 + 4).toFixed(1)}%, transparent)"`;
  }
  const net = rec.income - rec.expense;
  if (net > 0) return ' style="background:color-mix(in oklab, #3E8E5A 26%, transparent)"';
  const k = Math.max(0, Math.min(1, rec.expense / maxOut));
  return ` style="background:color-mix(in oklab, var(--seed-primary) ${(k * 30 + 4).toFixed(1)}%, transparent)"`;
}

/* ── 页面渲染 ── */

async function refresh(): Promise<void> {
  const el = body;
  if (!el?.isConnected) return;
  const token = ++refreshToken;
  const anim = pendingAnim;
  pendingAnim = '';
  const monthStart = new Date(viewY, viewM, 1).getTime();
  const monthEnd = new Date(viewY, viewM + 1, 1).getTime();
  const countAsIncome = await getSetting('reimburse.countAsIncome');
  const [entries, expenseCats, incomeCats, accounts, merchants] = await Promise.all([
    ledgerEntriesInRange(monthStart, monthEnd, countAsIncome),
    listCategories('expense'), listCategories('income'), listAccounts(), listMerchants(),
  ]);
  if (token !== refreshToken || !el.isConnected) return;

  const catNames = new Map<number, string>();
  const catMap = categoryDisplayMap([...expenseCats, ...incomeCats]);
  for (const c of [...expenseCats, ...incomeCats]) catNames.set(c.id, c.name);
  const accountNames = new Map(accounts.map(a => [a.id, a.name]));
  const merchantNames = new Map(merchants.map(m => [m.id, m.name]));
  const tagIdsByEntry = new Map<number, number[]>();
  const tagNamesByEntry = new Map<number, string[]>();
  if (calFilter.tagIds.length) {
    const links = await listEntryTagLinks(entries.map(entry => entry.id));
    for (const link of links) {
      tagIdsByEntry.set(link.entryId, [...(tagIdsByEntry.get(link.entryId) ?? []), link.tagId]);
    }
  }
  if (token !== refreshToken || !el.isConnected) return;

  const query: LedgerQuery = {
    types: undefined,
    categoryIds: calFilter.categoryIds.length ? expandCategoryIds(calFilter.categoryIds, [...expenseCats, ...incomeCats]) : undefined,
    accountIds: calFilter.accountIds.length ? [...calFilter.accountIds] : undefined,
    tagIds: calFilter.tagIds.length ? [...calFilter.tagIds] : undefined,
    merchantIds: calFilter.merchantIds.length ? [...calFilter.merchantIds] : undefined,
    ...parseAmountRange(calFilter.amountMin, calFilter.amountMax),
  };
  const lookup = { categoryNames: catNames, accountNames, tagIdsByEntry, tagNamesByEntry, merchantNames };
  const matched = filterLedgerEntries(ledgerItems(entries, countAsIncome), query, lookup);

  /* 月历聚合（与明细同一筛选） */
  const agg = new Map<string, DayAgg>();
  for (const item of matched) {
    const key = keyOf(new Date(item.occurredAt).getFullYear(), new Date(item.occurredAt).getMonth(), new Date(item.occurredAt).getDate());
    const rec = agg.get(key) ?? { expense: 0, income: 0, count: 0 };
    const summary = summarizeLedgerEntries([item], { reimburseMode: countAsIncome ? 'income' : 'offset' });
    rec.expense += summary.expense;
    rec.income += summary.income;
    rec.count += 1;
    agg.set(key, rec);
  }

  const today = new Date();
  const isCurMonth = viewY === today.getFullYear() && viewM === today.getMonth();
  const daysInMonth = new Date(viewY, viewM + 1, 0).getDate();
  let maxOut = 0;
  for (const rec of agg.values()) maxOut = Math.max(maxOut, rec.expense);
  if (maxOut <= 0) maxOut = 1;

  /* 月历格子（周一起头，前置空白占位） */
  const cells: string[] = [];
  const lead = (new Date(viewY, viewM, 1).getDay() + 6) % 7;
  for (let i = 0; i < lead; i++) cells.push('<span class="cal-day" aria-hidden="true"></span>');
  for (let d = 1; d <= daysInMonth; d++) {
    const key = keyOf(viewY, viewM, d);
    const rec = agg.get(key);
    const sel = key === selKey;
    const cls = 'cal-day' + (isCurMonth && d === today.getDate() ? ' today' : '') + (sel ? ' sel' : '');
    const amt = rec && rec.expense !== 0 && mode === 'std'
      ? rec.expense > 0
        ? `<span class="cd-amt">-${compactCalendarAmount(rec.expense)}</span>`
        : `<span class="cd-amt refund" aria-label="退款净流入 ${formatFenCny(-rec.expense)}">+${compactCalendarAmount(-rec.expense)}</span>`
      : '';
    const dot = rec && rec.income !== 0 && mode === 'std' ? '<span class="cd-in"></span>' : '';
    cells.push(`<button class="${cls}" data-d="${d}" type="button" role="option" aria-label="${viewM + 1}月${d}日${rec ? `，净支出 ${formatFenCny(rec.expense)}，收入 ${formatFenCny(rec.income)}` : '，暂无记录'}" aria-selected="${sel}"${sel ? '' : cellStyle(rec, maxOut)}><span class="d-num">${d}</span>${amt}${dot}</button>`);
  }

  /* 选中日汇总 + 明细列表 */
  const dayEntries = selKey ? matched.filter(item => keyOf(new Date(item.occurredAt).getFullYear(), new Date(item.occurredAt).getMonth(), new Date(item.occurredAt).getDate()) === selKey) : [];
  let detailHtml = '<p class="sub" style="margin-top:6px">点选上方日期，查看当日明细</p>';
  if (selKey) {
    const [, , dStr] = selKey.split('-');
    const d = Number(dStr);
    const rec = agg.get(selKey);
    const wd = WD[new Date(viewY, viewM, d).getDay()];
    const addChip = `<button class="chip" data-act="add">给 ${viewM + 1}月${d}日 记一笔</button>`;
    const expenseText = rec?.expense != null
      ? rec.expense < 0 ? formatFenCny(rec.expense) : `-¥${formatFen(rec.expense)}`
      : '';
    const rows = dayEntries.map((item) => {
      const text = entryRowText(item, catMap, accountNames);
      const note = text.note ? ` <span class="e-sub">· ${esc(text.note)}</span>` : '';
      const signed = entryDisplayAmount(item);
      const amount = item.type === 'expense' || item.type === 'income'
        ? `<span class="num" style="color:var(${signed >= 0 ? '--income' : '--danger,#d0552e'})">${formatFen(signed, { sign: true })}</span>`
        : `<span class="num">${formatFen(item.amount)}</span>`;
      return `<button class="row" data-eid="${item.id}"><span class="e-ic${text.neutral ? ' neutral' : ''}">${iconHtml(text.icon, 18)}</span><div class="e-main"><p class="e-title">${esc(text.title)}${note}</p><p class="e-meta">${esc(text.meta)}</p></div>${amount}</button>`;
    }).join('');
    detailHtml = `
      <div class="card-heading cal-day-heading">
        <h3 class="card-title">${viewM + 1}月${d}日 · 周${wd}${isCurMonth && d === today.getDate() ? ' <span class="tiny">今天</span>' : ''}</h3>
        ${addChip}
      </div>
      ${rec
        ? `<div class="cd-sum"><span>${rec.expense < 0 ? '净支出' : '支出'}<b${rec.expense < 0 ? ' class="in"' : ''}>${expenseText}</b></span>${rec.income !== 0 ? `<span>收入${rec.income < 0 ? '净额' : ''}<b class="${rec.income < 0 ? 'out' : 'in'}">${rec.income > 0 ? '+' : ''}${formatFenCny(rec.income)}</b></span>` : ''}<span>共 ${rec.count} 笔</span></div>`
        : '<p class="sub" style="margin-top:6px">这一天还没有记录</p>'}
      ${rows ? `<div class="card list" style="margin-top:10px">${rows}</div>` : ''}`;
  }

  const filterLabel = isFilterEmpty(calFilter) ? '筛选' : '筛选中';
  el.innerHTML = `
    <section class="card calendar-card" aria-label="月历">
      <div class="cal-nav">
        <button class="icon-btn" data-nav="-1" aria-label="上一月">${iconHtml('ic-left')}</button>
        <button class="cal-title" type="button" data-act="ym" aria-label="选择年月">${viewY}年${viewM + 1}月<span class="cal-caret" aria-hidden="true">▾</span></button>
        <button class="icon-btn" data-nav="1" aria-label="下一月">${iconHtml('ic-right')}</button>
      </div>
      <div class="cal-head" aria-hidden="true"><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span><span>日</span></div>
      <div class="cal-grid${anim ? ` ${anim}` : ''}" role="listbox" aria-label="选择日期">${cells.join('')}</div>
      <div class="flt-row" style="padding:10px 2px 0" role="tablist" aria-label="日历视图">
        <button class="chip${mode === 'std' ? ' active' : ''}" data-m="std" role="tab" aria-selected="${mode === 'std'}">标准</button>
        <button class="chip${mode === 'heat' ? ' active' : ''}" data-m="heat" role="tab" aria-selected="${mode === 'heat'}">支出热力</button>
        <button class="chip${mode === 'net' ? ' active' : ''}" data-m="net" role="tab" aria-selected="${mode === 'net'}">结余热力</button>
        <button class="chip${isFilterEmpty(calFilter) ? '' : ' active'}" data-act="filter" style="margin-left:auto">${filterLabel}</button>
      </div>
      <p class="calendar-tip">${TIPS[mode]}</p>
    </section>
    <section class="card" aria-live="polite" aria-label="当日收支详情">${detailHtml}</section>`;
  el.scrollTop = savedScroll;
}

/** 切换月份；下一月不能越过当前月 */
function shiftMonth(delta: number): void {
  const today = new Date();
  if (delta > 0 && viewY === today.getFullYear() && viewM === today.getMonth()) {
    showToast(`${viewM + 2 > 12 ? 1 : viewM + 2}月还没到，先把当下记好`);
    return;
  }
  const d = new Date(viewY, viewM + delta, 1);
  viewY = d.getFullYear();
  viewM = d.getMonth();
  const isCur = viewY === today.getFullYear() && viewM === today.getMonth();
  selKey = keyOf(viewY, viewM, isCur ? today.getDate() : 1);
  pendingAnim = 'anim-month';
  void refresh();
}

function openFilterPanel(host: HTMLElement): void {
  const mount = host.closest<HTMLElement>('.subpage') ?? host;
  let release: (() => void) | undefined;
  const closePanel = (): void => {
    release?.();
    mount.querySelector('.fp-panel')?.remove();
  };
  void createFilterPanel({
    initial: calFilter,
    onConfirm: (state) => {
      calFilter = state;
      closePanel();
      void refresh();
    },
    onCancel: closePanel,
  }).then((panel) => {
    mount.appendChild(panel);
    release = manageOverlay(panel, closePanel);
  });
}

/**
 * 年月快速跳转浮层：12 月宫格 + 年份左右步进（今年 ±5 年），
 * 当前查看月高亮、未来月禁用；遮罩挂 .subpage（与抽屉内 picker-mask 同风格）。
 */
function openYmPicker(host: HTMLElement): void {
  const mount = host.closest<HTMLElement>('.subpage') ?? host;
  if (mount.querySelector('.ym-mask')) return;
  const today = new Date();
  const curYm = today.getFullYear() * 12 + today.getMonth();
  const minYear = today.getFullYear() - 5;
  const maxYear = today.getFullYear() + 5;
  let year = viewY;

  const mask = document.createElement('div');
  mask.className = 'ym-mask';
  let releaseOverlay: () => void = () => {};
  const close = (): void => {
    releaseOverlay();
    mask.remove();
  };
  const renderPop = (): void => {
    mask.innerHTML = `
      <div class="ym-pop" role="dialog" aria-label="选择年月">
        <div class="ym-nav">
          <button class="icon-btn" data-y="-1" aria-label="上一年"${year <= minYear ? ' disabled' : ''}>${iconHtml('ic-left')}</button>
          <b class="num">${year}年</b>
          <button class="icon-btn" data-y="1" aria-label="下一年"${year >= maxYear ? ' disabled' : ''}>${iconHtml('ic-right')}</button>
        </div>
        <div class="ym-grid" role="listbox" aria-label="选择月份">
          ${Array.from({ length: 12 }, (_, i) => {
            const sel = year === viewY && i === viewM;
            return `<button type="button" data-mo="${i}" role="option" aria-selected="${sel}"${sel ? ' class="sel"' : ''}${year * 12 + i > curYm ? ' disabled' : ''}>${i + 1}月</button>`;
          }).join('')}
        </div>
      </div>`;
  };
  mask.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const yBtn = t.closest<HTMLElement>('[data-y]');
    if (yBtn) {
      year += Number(yBtn.dataset.y);
      renderPop();
      return;
    }
    const moBtn = t.closest<HTMLElement>('[data-mo]');
    if (moBtn) {
      viewY = year;
      viewM = Number(moBtn.dataset.mo);
      const isCur = viewY === today.getFullYear() && viewM === today.getMonth();
      selKey = keyOf(viewY, viewM, isCur ? today.getDate() : 1);
      close();
      pendingAnim = 'anim-month';
      void refresh();
      return;
    }
    if (t === mask) close();
  });
  renderPop();
  mount.appendChild(mask);
  releaseOverlay = manageOverlay(mask, close);
}

/* ── 装配 ── */

/** 注册日历账单子页（覆盖 shell 占位 sp-calendar），main.ts 调用一次 */
export function initCalendar(): void {
  registerSubpage('sp-calendar', {
    title: '日历账单',
    render(el) {
      body = el;
      if (!initialized) {
        const today = new Date();
        viewY = today.getFullYear();
        viewM = today.getMonth();
        selKey = keyOf(viewY, viewM, today.getDate());
        mode = 'std';
        initialized = true;
      }

      el.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const nav = target.closest<HTMLElement>('[data-nav]');
        if (nav) { shiftMonth(Number(nav.dataset.nav)); return; }
        if (target.closest('[data-act="ym"]')) { openYmPicker(el); return; }
        if (target.closest('[data-act="filter"]')) { openFilterPanel(el); return; }
        const modeBtn = target.closest<HTMLElement>('[data-m]');
        if (modeBtn) {
          mode = modeBtn.dataset.m as CalMode;
          pendingAnim = 'anim-mode';
          void refresh();
          return;
        }
        const dayBtn = target.closest<HTMLElement>('.cal-day[data-d]');
        if (dayBtn) {
          selKey = keyOf(viewY, viewM, Number(dayBtn.dataset.d));
          void refresh();
          return;
        }
        const entryRow = target.closest<HTMLElement>('[data-eid]');
        if (entryRow) { openEntryDetail(Number(entryRow.dataset.eid)); return; }
        if (target.closest('[data-act="add"]') && selKey) {
          const [y, m, d] = selKey.split('-').map(Number);
          void openEntrySheet({ presetDate: new Date(y, m - 1, d, 12, 0).getTime() });
          showToast(`记账日期已设为 ${m}月${d}日，保存后计入当日流水`);
        }
      });
      el.addEventListener('scroll', () => { savedScroll = el.scrollTop; }, { passive: true });
    },
    onShow() { void refresh(); },
  });

  on('entries-changed', () => void refresh());
}
