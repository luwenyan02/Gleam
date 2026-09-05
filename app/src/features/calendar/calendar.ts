/**
 * 拾光 · 日历账单（features/calendar，PRD 4.5）
 * 月历视图（statsRepo.dailyAggregates 聚合）：每日支出缩写 + 收入金点、
 * 月份切换、标题点击年月快速跳转浮层、三种视图模式（标准 / 支出热力 / 结余热力）、
 * 点日查看当日收支详情，空缺日期可「补一笔」（openEntrySheet 预设日期）。
 * 视觉结构与原型 index.html #page-cal（L843-866、JS L1561-1633）一致；
 * 热力色阶分母取当月最大单日支出（原型演示数据用固定值）。
 */
import './calendar.css';
import { iconHtml } from '../../assets/icons';
import { on } from '../../core/store';
import { formatFen } from '../../core/money';
import { dailyAggregates } from '../../core/repo/statsRepo';
import { openEntrySheet } from '../entry/entrySheet';
import { registerSubpage } from '../shell/router';
import { showToast } from '../shell/toast';

type CalMode = 'std' | 'heat' | 'net';
interface DayAgg { expense: number; income: number; count: number }

/* ── 模块状态（render 时重置到当月/今天） ── */
let body: HTMLElement | undefined;
/** 并发刷新令牌 */
let refreshToken = 0;
let viewY = 0;
/** 0-11 */
let viewM = 0;
/** 选中日 'YYYY-MM-DD'，空串表示未选中 */
let selKey = '';
let mode: CalMode = 'std';
/** 待应用的切换过渡类（拼进 .cal-grid，随本次重渲染消费）：月份切换淡入 / 模式切换色彩渐显 */
let pendingAnim: '' | 'anim-month' | 'anim-mode' = '';

const WD = ['日', '一', '二', '三', '四', '五', '六'];
const TIPS: Record<CalMode, string> = {
  std: '金点 = 当日有收入 · 点选日期查看当日收支，空缺日期可补账',
  heat: '颜色越深 = 当日支出越多 · 按当月最高单日支出定色阶',
  net: '绿色 = 当日结余为正（收入大于支出）· 主色 = 当日净支出',
};

function pad2(n: number): string { return String(n).padStart(2, '0'); }
function ymStr(y: number, m: number): string { return `${y}-${pad2(m + 1)}`; }
function keyOf(y: number, m: number, d: number): string { return `${ymStr(y, m)}-${pad2(d)}`; }
/** 元整数展示（原型 fmt0 语义） */
function fmtYuan0(fen: number): string { return formatFen(fen).split('.')[0]; }

/** 热力/结余模式的单元格底色（原型 calCellStyle，L1578-1588） */
function cellStyle(rec: DayAgg | undefined, maxOut: number): string {
  if (!rec || mode === 'std') return '';
  if (mode === 'heat') {
    const k = Math.min(1, rec.expense / maxOut);
    return ` style="background:color-mix(in oklab, var(--seed-primary) ${(k * 38 + 4).toFixed(1)}%, transparent)"`;
  }
  const net = rec.income - rec.expense;
  if (net > 0) return ' style="background:color-mix(in oklab, #3E8E5A 26%, transparent)"';
  const k = Math.min(1, rec.expense / maxOut);
  return ` style="background:color-mix(in oklab, var(--seed-primary) ${(k * 30 + 4).toFixed(1)}%, transparent)"`;
}

/* ── 页面渲染 ── */

async function refresh(): Promise<void> {
  const el = body;
  if (!el?.isConnected) return;
  const token = ++refreshToken;
  const anim = pendingAnim;
  pendingAnim = '';
  const agg = await dailyAggregates(ymStr(viewY, viewM));
  if (token !== refreshToken || !el.isConnected) return;

  const today = new Date();
  const isCurMonth = viewY === today.getFullYear() && viewM === today.getMonth();
  const daysInMonth = new Date(viewY, viewM + 1, 0).getDate();
  // 热力分母：当月最大单日支出
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
    const future = isCurMonth && d > today.getDate();
    const sel = key === selKey;
    const cls = 'cal-day' + (isCurMonth && d === today.getDate() ? ' today' : '') + (sel ? ' sel' : '');
    const amt = rec && rec.expense > 0 && mode === 'std' ? `<span class="cd-amt">-${fmtYuan0(rec.expense)}</span>` : '';
    const dot = rec && rec.income > 0 && mode === 'std' ? '<span class="cd-in"></span>' : '';
    // 选中日不套热力底色（沿用原型 L1598）
    cells.push(`<button class="${cls}" data-d="${d}" type="button" role="option" aria-selected="${sel}"${future ? ' disabled' : ''}${sel ? '' : cellStyle(rec, maxOut)}><span class="d-num">${d}</span>${amt}${dot}</button>`);
  }

  /* 选中日详情卡 */
  let detailHtml = '<p class="sub" style="margin-top:6px">点选上方日期，查看当日收支</p>';
  if (selKey) {
    const [, , dStr] = selKey.split('-');
    const d = Number(dStr);
    const rec = agg.get(selKey);
    const isToday = isCurMonth && d === today.getDate();
    const wd = WD[new Date(viewY, viewM, d).getDay()];
    const addChip = `<button class="chip" data-act="add" style="margin-top:10px">给 ${viewM + 1}月${d}日 补一笔</button>`;
    const bodyHtml = rec
      ? `<div class="cd-sum"><span>支出<b>-¥${formatFen(rec.expense)}</b></span>${rec.income > 0 ? `<span>收入<b class="in">+¥${formatFen(rec.income)}</b></span>` : ''}<span>共 ${rec.count} 笔</span></div>
         ${isToday ? '' : addChip}`
      : `<p class="sub" style="margin-top:6px">这一天还没有记录</p>${addChip}`;
    detailHtml = `<h3 class="card-title">${viewM + 1}月${d}日 · 周${wd}${isToday ? ' <span class="tiny">今天</span>' : ''}</h3>${bodyHtml}`;
  }

  el.innerHTML = `
    <section class="card" aria-label="月历">
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
      </div>
      <p class="tiny" style="margin-top:10px">${TIPS[mode]}</p>
    </section>
    <section class="card" aria-live="polite" aria-label="当日收支详情">${detailHtml}</section>`;
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
  // 切月后默认选中：当月选今天，其余月选 1 日
  const isCur = viewY === today.getFullYear() && viewM === today.getMonth();
  selKey = keyOf(viewY, viewM, isCur ? today.getDate() : 1);
  pendingAnim = 'anim-month';
  void refresh();
}

/**
 * 年月快速跳转浮层：12 月宫格 + 年份左右步进（今年 ±5 年），
 * 当前查看月高亮、未来月禁用；遮罩挂 .subpage（与抽屉内 picker-mask 同风格）。
 */
function openYmPicker(host: HTMLElement): void {
  const mount = host.closest<HTMLElement>('.subpage') ?? host;
  if (mount.querySelector('.ym-mask')) return; // 连点标题防重复叠加，只保留一层浮层
  const today = new Date();
  const curYm = today.getFullYear() * 12 + today.getMonth();
  const minYear = today.getFullYear() - 5;
  const maxYear = today.getFullYear() + 5;
  let year = viewY;

  const mask = document.createElement('div');
  mask.className = 'ym-mask';
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
      mask.remove();
      pendingAnim = 'anim-month';
      void refresh();
      return;
    }
    if (t === mask) mask.remove();
  });
  renderPop();
  mount.appendChild(mask);
}

/* ── 装配 ── */

/** 注册日历账单子页（覆盖 shell 占位 sp-calendar），main.ts 调用一次 */
export function initCalendar(): void {
  registerSubpage('sp-calendar', {
    title: '日历账单',
    render(el) {
      body = el;
      // 每次打开回到当月并选中今天
      const today = new Date();
      viewY = today.getFullYear();
      viewM = today.getMonth();
      selKey = keyOf(viewY, viewM, today.getDate());
      mode = 'std';

      el.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const nav = target.closest<HTMLElement>('[data-nav]');
        if (nav) { shiftMonth(Number(nav.dataset.nav)); return; }
        if (target.closest('[data-act="ym"]')) { openYmPicker(el); return; }
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
        if (target.closest('[data-act="add"]') && selKey) {
          // 补账：预设为选中日中午 12:00，保存后归入当日流水
          const [y, m, d] = selKey.split('-').map(Number);
          void openEntrySheet({ presetDate: new Date(y, m - 1, d, 12, 0).getTime() });
          showToast(`记账日期已设为 ${m}月${d}日，保存后计入当日流水`);
        }
      });
      void refresh();
    },
    onShow() { void refresh(); },
  });

  // 账单变化时刷新（子页关闭即销毁，refresh 内部以 isConnected 兜底）
  on('entries-changed', () => void refresh());
}
