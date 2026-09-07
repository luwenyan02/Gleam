/**
 * 拾光 · 日期/时间滚轮选择器（共享组件）
 * 自搜索页 dateWheel 迁移并扩展：withTime=true 时面板顶部提供「时间/日期」双 tab——
 * 时间页月/日/时/分四列（默认页，年份取日期页当前选中值，不在时间页展示），
 * 日期页年/月/日三列；月/日列为两页共享的唯一实例，切 tab 时迁移 DOM 节点，状态不丢。
 * 支持 minDate/maxDate 越界收敛（年份范围收敛 + 月/日列联动裁剪）、顶部「今天」快捷按钮。
 * 选中行加粗居中放大，上下行渐隐缩小；触摸/鼠标拖拽 + 惯性 + 吸附。
 * 纯 DOM + CSS 实现，无第三方依赖；样式见 ./dw.css。
 */
import './dw.css';
import { manageOverlay } from './overlay';

export interface DateWheelResult {
  year: number;
  month: number;
  day: number;
}

/** withTime 时 hour/minute 必有；纯日期模式不携带 */
export interface DateTimeWheelResult extends DateWheelResult {
  hour?: number;
  minute?: number;
}

export interface DateWheelOptions {
  /** 初始日期 */
  initial?: { year: number; month: number; day: number };
  /** 确认回调 */
  onConfirm(result: DateWheelResult): void;
  /** 取消/关闭回调 */
  onCancel?(): void;
}

export interface DateTimeWheelOptions {
  /** 初始日期时间（withTime 时 hour/minute 缺省取当前时刻） */
  initial: { year: number; month: number; day: number; hour?: number; minute?: number };
  /**
   * true：顶部「时间/日期」双 tab——时间页 4 列（月/日/时/分，默认激活）+ 日期页 3 列（年/月/日）；
   * false（默认）：无 tab、纯 3 列日期（搜索页形态，行为视觉与原 dateWheel 一致）。
   */
  withTime?: boolean;
  /** 可选日期上界（含当天），越界选项从月/日列中裁剪 */
  maxDate?: { year: number; month: number; day: number };
  /** 可选日期下界（含当天）；不传则年列下界为 MIN_YEAR */
  minDate?: { year: number; month: number; day: number };
  /** 确认回调 */
  onConfirm(result: DateTimeWheelResult): void;
  /** 取消/关闭回调 */
  onCancel?(): void;
  /** 确认按钮文案，默认「确定」 */
  confirmText?: string;
}

/** 年列下界常量：无 minDate 时，滚轮可一直滚到该年（记一笔补账/搜索页 earliest 均依赖） */
const MIN_YEAR = 2000;

const ITEM_HEIGHT = 40;
const VISIBLE_COUNT = 7;
const HALF = Math.floor(VISIBLE_COUNT / 2);

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

/** 创建单列滚动器（列宽由外层页面容器 CSS 控制）；el 暴露列节点，供月/日列跨页迁移复用 */
function createColumn(
  container: HTMLElement,
  items: string[],
  initialIdx: number,
  onChange?: (idx: number) => void,
): { getIndex(): number; setItems(newItems: string[], idx?: number): void; destroy(): void; el: HTMLElement } {
  const wrap = document.createElement('div');
  wrap.className = 'dw-col';
  wrap.tabIndex = 0;
  wrap.setAttribute('role','spinbutton');
  wrap.setAttribute('aria-label',items[0]?.replace(/[\d\s]/g,'') || '日期');
  wrap.style.height = `${ITEM_HEIGHT * VISIBLE_COUNT}px`;

  const list = document.createElement('div');
  list.className = 'dw-list';
  wrap.appendChild(list);

  // 选中行指示器
  const indicator = document.createElement('div');
  indicator.className = 'dw-indicator';
  indicator.style.top = `${HALF * ITEM_HEIGHT}px`;
  indicator.style.height = `${ITEM_HEIGHT}px`;
  wrap.appendChild(indicator);

  let currentItems = items;
  let currentIdx = clamp(initialIdx, 0, items.length - 1);
  let offset = -currentIdx * ITEM_HEIGHT;
  let startY = 0;
  let startOffset = 0;
  let velocity = 0;
  let lastY = 0;
  let lastTime = 0;
  let animId = 0;
  let dragging = false;

  function renderItems(): void {
    list.innerHTML = currentItems
      .map((text, i) => `<div class="dw-item" data-i="${i}">${text}</div>`)
      .join('');
    for (const item of list.children) {
      (item as HTMLElement).style.height = `${ITEM_HEIGHT}px`;
      (item as HTMLElement).style.lineHeight = `${ITEM_HEIGHT}px`;
    }
  }

  function applyTransform(): void {
    wrap.setAttribute('aria-valuemin','0');
    wrap.setAttribute('aria-valuemax',String(currentItems.length-1));
    wrap.setAttribute('aria-valuenow',String(currentIdx));
    wrap.setAttribute('aria-valuetext',currentItems[currentIdx] ?? '');
    list.style.transform = `translateY(${offset + HALF * ITEM_HEIGHT}px)`;
    // 视觉效果：离中心越远越淡越小
    for (let i = 0; i < list.children.length; i++) {
      const el = list.children[i] as HTMLElement;
      const distPx = Math.abs(offset + i * ITEM_HEIGHT);
      const dist = distPx / ITEM_HEIGHT;
      const scale = Math.max(0.78, 1 - dist * 0.06);
      const opacity = Math.max(0.3, 1 - dist * 0.22);
      const weight = dist < 0.5 ? '700' : dist < 1.5 ? '500' : '400';
      const fontSize = dist < 0.5 ? '18px' : '14px';
      el.style.transform = `scale(${scale})`;
      el.style.opacity = String(opacity);
      el.style.fontWeight = weight;
      el.style.fontSize = fontSize;
    }
  }

  function snapToIndex(idx: number, animate = true): void {
    cancelAnimationFrame(animId);
    currentIdx = clamp(idx, 0, currentItems.length - 1);
    const target = -currentIdx * ITEM_HEIGHT;
    if (!animate) {
      offset = target;
      applyTransform();
      return;
    }
    const startOff = offset;
    const startTime = performance.now();
    const duration = 250;
    const step = (now: number) => {
      const t = Math.min(1, (now - startTime) / duration);
      const ease = 1 - Math.pow(1 - t, 3); // easeOutCubic
      offset = startOff + (target - startOff) * ease;
      applyTransform();
      if (t < 1) animId = requestAnimationFrame(step);
      else onChange?.(currentIdx);
    };
    animId = requestAnimationFrame(step);
  }

  function nearestIndex(): number {
    return clamp(Math.round(-offset / ITEM_HEIGHT), 0, currentItems.length - 1);
  }

  function momentumSnap(): void {
    // 使用惯性动画
    cancelAnimationFrame(animId);
    const decel = 0.94;
    const step = () => {
      velocity *= decel;
      offset += velocity;
      // 边界
      const minOff = -(currentItems.length - 1) * ITEM_HEIGHT;
      if (offset > 0) { offset = 0; velocity = 0; }
      if (offset < minOff) { offset = minOff; velocity = 0; }
      applyTransform();
      if (Math.abs(velocity) > 0.5) {
        animId = requestAnimationFrame(step);
      } else {
        snapToIndex(nearestIndex());
      }
    };
    if (Math.abs(velocity) > 2) {
      animId = requestAnimationFrame(step);
    } else {
      snapToIndex(nearestIndex());
    }
  }

  // 事件绑定
  const onPointerDown = (e: PointerEvent) => {
    cancelAnimationFrame(animId);
    dragging = true;
    startY = e.clientY;
    startOffset = offset;
    lastY = e.clientY;
    lastTime = performance.now();
    velocity = 0;
    wrap.setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!dragging) return;
    const dy = e.clientY - startY;
    offset = startOffset + dy;
    applyTransform();
    const now = performance.now();
    const dt = now - lastTime;
    if (dt > 0) {
      velocity = (e.clientY - lastY) / dt * 16;
      lastY = e.clientY;
      lastTime = now;
    }
    e.preventDefault();
  };
  const onPointerUp = (e: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    wrap.releasePointerCapture(e.pointerId);
    momentumSnap();
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    cancelAnimationFrame(animId);
    offset -= e.deltaY;
    applyTransform();
    // debounce snap
    clearTimeout((wrap as any)._wheelTimer);
    (wrap as any)._wheelTimer = setTimeout(() => snapToIndex(nearestIndex()), 120);
  };

  wrap.addEventListener('pointerdown', onPointerDown);
  wrap.addEventListener('pointermove', onPointerMove);
  wrap.addEventListener('pointerup', onPointerUp);
  wrap.addEventListener('pointercancel', onPointerUp);
  wrap.addEventListener('wheel', onWheel, { passive: false });
  wrap.addEventListener('keydown', event => {
    if (!['ArrowUp','ArrowDown','Home','End'].includes(event.key)) return;
    event.preventDefault();
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? currentItems.length-1 : currentIdx+(event.key === 'ArrowUp' ? -1 : 1);
    snapToIndex(index, false); onChange?.(currentIdx);
  });

  renderItems();
  offset = -currentIdx * ITEM_HEIGHT;
  applyTransform();
  container.appendChild(wrap);

  return {
    el: wrap,
    getIndex() { return currentIdx; },
    setItems(newItems: string[], idx?: number) {
      currentItems = newItems;
      currentIdx = clamp(idx ?? currentIdx, 0, newItems.length - 1);
      offset = -currentIdx * ITEM_HEIGHT;
      renderItems();
      applyTransform();
    },
    destroy() {
      cancelAnimationFrame(animId);
      wrap.removeEventListener('pointerdown', onPointerDown);
      wrap.removeEventListener('pointermove', onPointerMove);
      wrap.removeEventListener('pointerup', onPointerUp);
      wrap.removeEventListener('pointercancel', onPointerUp);
      wrap.removeEventListener('wheel', onWheel);
      wrap.remove();
    },
  };
}

/**
 * 打开日期/时间滚轮选择器（底部弹出面板）。
 * withTime=true：「时间/日期」双 tab（默认时间页），时间页 4 列 + 日期页 3 列，确定应用完整日期+时间；
 * withTime=false：无 tab 纯 3 列（搜索页形态）。
 * 返回面板 DOM（调用方负责 append 到 body 并显示）。
 */
export function openDateTimeWheel(opts: DateTimeWheelOptions): HTMLElement {
  const now = new Date();
  const withTime = opts.withTime ?? false;
  const init = opts.initial;

  // ── 年份范围：MIN_YEAR ~ 当前年+1，按 min/max 收敛（矛盾输入时以 max 侧为准）；
  //    无 minDate 时下界恒为 MIN_YEAR，滚轮可一直滚到 2000 年（v1.0.5 实测反馈的加固点） ──
  let minYear = Math.max(MIN_YEAR, opts.minDate?.year ?? MIN_YEAR);
  const maxYear = Math.min(now.getFullYear() + 1, opts.maxDate?.year ?? now.getFullYear() + 1);
  minYear = Math.min(minYear, maxYear);
  const years = Array.from({ length: maxYear - minYear + 1 }, (_, i) => `${minYear + i}年`);

  // ── 初始值 clamp 进可选范围 ──
  const initYear = clamp(init.year, minYear, maxYear);

  /** 指定年份下月列的可选范围 [lo, hi]（无约束时为 [1, 12]） */
  function monthRange(y: number): [number, number] {
    let lo = 1;
    let hi = 12;
    if (opts.minDate && y === opts.minDate.year) lo = Math.max(lo, opts.minDate.month);
    if (opts.maxDate && y === opts.maxDate.year) hi = Math.min(hi, opts.maxDate.month);
    if (lo > hi) lo = hi;
    return [lo, hi];
  }

  /** 指定年月下日列的可选范围 [lo, hi]（无约束时为 [1, 当月天数]） */
  function dayRange(y: number, m: number): [number, number] {
    let lo = 1;
    let hi = daysInMonth(y, m);
    if (opts.minDate && y === opts.minDate.year && m === opts.minDate.month) lo = Math.max(lo, opts.minDate.day);
    if (opts.maxDate && y === opts.maxDate.year && m === opts.maxDate.month) hi = Math.min(hi, opts.maxDate.day);
    if (lo > hi) lo = hi;
    return [lo, hi];
  }

  function monthItems(y: number): string[] {
    const [lo, hi] = monthRange(y);
    return Array.from({ length: hi - lo + 1 }, (_, i) => `${lo + i}月`);
  }

  function dayItems(y: number, m: number): string[] {
    const [lo, hi] = dayRange(y, m);
    return Array.from({ length: hi - lo + 1 }, (_, i) => `${lo + i}日`);
  }

  const [initMLo, initMHi] = monthRange(initYear);
  const initMonth = clamp(init.month, initMLo, initMHi);
  const [initDLo, initDHi] = dayRange(initYear, initMonth);
  const initDay = clamp(init.day, initDLo, initDHi);

  const panel = document.createElement('div');
  panel.className = 'dw-panel';
  panel.innerHTML = `
    <div class="dw-mask"></div>
    <div class="dw-content">
      <div class="dw-head">
        ${withTime ? `<div class="dw-tabs" role="tablist" aria-label="选择类型">
          <button class="dw-tab active" type="button" data-tab="time" role="tab" aria-selected="true">时间</button>
          <button class="dw-tab" type="button" data-tab="date" role="tab" aria-selected="false">日期</button>
        </div>` : ''}
        <button class="dw-today" type="button">今天</button>
      </div>
      <div class="dw-columns"></div>
      <button class="dw-confirm">确定</button>
    </div>`;

  const mask = panel.querySelector<HTMLElement>('.dw-mask')!;
  const colsWrap = panel.querySelector<HTMLElement>('.dw-columns')!;
  const confirmBtn = panel.querySelector<HTMLButtonElement>('.dw-confirm')!;
  const todayBtn = panel.querySelector<HTMLButtonElement>('.dw-today')!;
  confirmBtn.textContent = opts.confirmText ?? '确定';

  // ── 双页容器：withTime 时默认激活时间页（用户高频改时间），日期页初始隐藏。
  //    月/日列为两页共享的唯一实例（年列仅日期页、时/分列仅时间页），初始按时间页
  //    四列顺序挂载；切 tab 时由下方监听按目标页顺序 append 迁移节点（移动已有节点
  //    不重建，事件绑定与滚动状态原样保留） ──
  let datePage: HTMLElement | null = null;
  let timePage: HTMLElement | null = null;
  if (withTime) {
    datePage = document.createElement('div');
    datePage.className = 'dw-page dw-page-date';
    timePage = document.createElement('div');
    timePage.className = 'dw-page dw-page-time';
    datePage.hidden = true;
    colsWrap.append(datePage, timePage);
  }
  // 无 tab（搜索页）时三列直接挂 colsWrap；有 tab 时年列挂日期页、月/日列挂时间页（默认页）
  const dateHost = withTime ? datePage! : colsWrap;
  const timeHost = withTime ? timePage! : colsWrap;

  const yearCol = createColumn(dateHost, years, initYear - minYear, () => rebuildMonths());

  const monthCol = createColumn(timeHost, monthItems(initYear), initMonth - initMLo, () => rebuildDays());

  const dayCol = createColumn(timeHost, dayItems(initYear, initMonth), initDay - initDLo);

  // ── 时/分列（复用 createColumn，无联动；分钟两位数字对齐） ──
  const hours = Array.from({ length: 24 }, (_, i) => `${i}时`);
  const minutes = Array.from({ length: 60 }, (_, i) => `${String(i).padStart(2, '0')}分`);
  const initHour = clamp(init.hour ?? now.getHours(), 0, 23);
  const initMinute = clamp(init.minute ?? now.getMinutes(), 0, 59);
  const hourCol = withTime ? createColumn(timeHost, hours, initHour) : null;
  const minuteCol = withTime ? createColumn(timeHost, minutes, initMinute) : null;

  // ── tab 切换：即时切页显隐 + 月/日列唯一实例按目标页顺序迁移（不动列状态、不触发回调） ──
  if (withTime) {
    const tabsEl = panel.querySelector<HTMLElement>('.dw-tabs')!;
    const tabBtns = Array.from(tabsEl.querySelectorAll<HTMLButtonElement>('.dw-tab'));
    tabsEl.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.dw-tab');
      if (!btn) return;
      for (const b of tabBtns) {
        const active = b === btn;
        b.classList.toggle('active', active);
        b.setAttribute('aria-selected', String(active));
      }
      const isDate = btn.dataset.tab === 'date';
      datePage!.hidden = !isDate;
      timePage!.hidden = isDate;
      // append 按参数顺序移动节点：日期页 年/月/日，时间页 月/日/时/分
      if (isDate) datePage!.append(yearCol.el, monthCol.el, dayCol.el);
      else timePage!.append(monthCol.el, dayCol.el, hourCol!.el, minuteCol!.el);
    });
  }

  /** 当前各列取值（均从列索引推导，min/max 约束下仍成立） */
  function currentYear(): number { return minYear + yearCol.getIndex(); }
  function currentMonth(): number { return monthRange(currentYear())[0] + monthCol.getIndex(); }

  /** 年变化 → 重建月列（保持选中月 clamp）→ 级联重建日列 */
  function rebuildMonths(): void {
    const y = currentYear();
    const [mlo, mhi] = monthRange(y);
    const keep = clamp(mlo + monthCol.getIndex(), mlo, mhi);
    monthCol.setItems(monthItems(y), keep - mlo);
    rebuildDays();
  }

  /** 月变化 → 重建日列（保持选中日 clamp） */
  function rebuildDays(): void {
    const y = currentYear();
    const m = currentMonth();
    const [dlo, dhi] = dayRange(y, m);
    const keep = clamp(dlo + dayCol.getIndex(), dlo, dhi);
    dayCol.setItems(dayItems(y, m), keep - dlo);
  }

  /** 直接设定选中值（不触发回调）；e2e 钩子 __dwSet 与「今天」按钮共用 */
  function setSelection(y: number, m: number, d: number, h?: number, mi?: number): void {
    const cy = clamp(y, minYear, maxYear);
    yearCol.setItems(years, cy - minYear);
    const [mlo, mhi] = monthRange(cy);
    const cm = clamp(m, mlo, mhi);
    monthCol.setItems(monthItems(cy), cm - mlo);
    const [dlo, dhi] = dayRange(cy, cm);
    const cd = clamp(d, dlo, dhi);
    dayCol.setItems(dayItems(cy, cm), cd - dlo);
    if (hourCol) hourCol.setItems(hours, clamp(h ?? 0, 0, 23));
    if (minuteCol) minuteCol.setItems(minutes, clamp(mi ?? 0, 0, 59));
  }

  function close(): void {
    releaseOverlay();
    panel.classList.remove('dw-open');
    setTimeout(() => {
      yearCol.destroy();
      monthCol.destroy();
      dayCol.destroy();
      hourCol?.destroy();
      minuteCol?.destroy();
      panel.remove();
    }, 300);
  }

  const releaseOverlay = manageOverlay(panel, () => { close(); opts.onCancel?.(); });
  panel.setAttribute('aria-label','选择日期与时间');
  mask.addEventListener('click', () => {
    close();
    opts.onCancel?.();
  });

  todayBtn.addEventListener('click', () => {
    const t = new Date();
    // 「今天」通常在可选范围内；越界时按 min/max clamp
    setSelection(
      t.getFullYear(),
      t.getMonth() + 1,
      t.getDate(),
      withTime ? t.getHours() : undefined,
      withTime ? t.getMinutes() : undefined,
    );
  });

  confirmBtn.addEventListener('click', () => {
    const result: DateTimeWheelResult = {
      year: currentYear(),
      month: currentMonth(),
      day: dayRange(currentYear(), currentMonth())[0] + dayCol.getIndex(),
    };
    if (withTime) {
      result.hour = hourCol!.getIndex();
      result.minute = minuteCol!.getIndex();
    }
    close();
    opts.onConfirm(result);
  });

  // 测试钩子：e2e 直接设定各列选中索引并刷新（不触发回调）
  (panel as any).__dwSet = (y: number, m: number, d: number, h?: number, mi?: number): void => {
    setSelection(y, m, d, h, mi);
  };

  // 打开动画
  requestAnimationFrame(() => panel.classList.add('dw-open'));

  return panel;
}

/**
 * 打开纯日期滚轮（3 列，无时间）——搜索页兼容入口，行为与原 dateWheel 完全一致。
 */
export function openDateWheel(opts: DateWheelOptions): HTMLElement {
  const now = new Date();
  return openDateTimeWheel({
    initial: opts.initial ?? { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() },
    onConfirm: (r) => opts.onConfirm(r),
    onCancel: opts.onCancel,
  });
}

// ────────────────────────────────────────────────────────────────────────────
// 年/月两列滚轮（备份页月份选择等场景）
// ────────────────────────────────────────────────────────────────────────────

export interface MonthWheelOptions {
  initial: { year: number; month: number };
  minDate?: { year: number; month: number };
  maxDate?: { year: number; month: number };
  onConfirm(result: { year: number; month: number }): void;
  onCancel?(): void;
}

/**
 * 打开年/月滚轮选择器（两列，无日列、无 tab、无「今天」按钮）。
 * 复用 createColumn / .dw-panel DOM 结构 / 打开关闭动画，与其他滚轮形态共享样式。
 */
export function openMonthWheel(opts: MonthWheelOptions): HTMLElement {
  const now = new Date();

  // ── 年份范围（同 openDateTimeWheel 逻辑） ──
  let minYear = Math.max(MIN_YEAR, opts.minDate?.year ?? MIN_YEAR);
  const maxYear = Math.min(now.getFullYear() + 1, opts.maxDate?.year ?? now.getFullYear() + 1);
  minYear = Math.min(minYear, maxYear);
  const years = Array.from({ length: maxYear - minYear + 1 }, (_, i) => `${minYear + i}年`);

  const initYear = clamp(opts.initial.year, minYear, maxYear);

  /** 指定年份下月列可选范围 [lo, hi] */
  function mRange(y: number): [number, number] {
    let lo = 1;
    let hi = 12;
    if (opts.minDate && y === opts.minDate.year) lo = Math.max(lo, opts.minDate.month);
    if (opts.maxDate && y === opts.maxDate.year) hi = Math.min(hi, opts.maxDate.month);
    if (lo > hi) lo = hi;
    return [lo, hi];
  }

  function mItems(y: number): string[] {
    const [lo, hi] = mRange(y);
    return Array.from({ length: hi - lo + 1 }, (_, i) => `${lo + i}月`);
  }

  const [initMLo] = mRange(initYear);
  const initMonth = clamp(opts.initial.month, ...mRange(initYear));

  // ── 面板 DOM（精简：无 tab、无今天按钮） ──
  const panel = document.createElement('div');
  panel.className = 'dw-panel';
  panel.innerHTML = `
    <div class="dw-mask"></div>
    <div class="dw-content">
      <div class="dw-columns"></div>
      <button class="dw-confirm">确定</button>
    </div>`;

  const mask = panel.querySelector<HTMLElement>('.dw-mask')!;
  const colsWrap = panel.querySelector<HTMLElement>('.dw-columns')!;
  const confirmBtn = panel.querySelector<HTMLButtonElement>('.dw-confirm')!;

  // ── 两列：年 + 月（flex:1 自动均分） ──
  const yearCol = createColumn(colsWrap, years, initYear - minYear, () => rebuildMonths());
  const monthCol = createColumn(colsWrap, mItems(initYear), initMonth - initMLo);

  function currentYear(): number { return minYear + yearCol.getIndex(); }

  function rebuildMonths(): void {
    const y = currentYear();
    const [lo, hi] = mRange(y);
    const keep = clamp(lo + monthCol.getIndex(), lo, hi);
    monthCol.setItems(mItems(y), keep - lo);
  }

  function close(): void {
    releaseOverlay();
    panel.classList.remove('dw-open');
    setTimeout(() => {
      yearCol.destroy();
      monthCol.destroy();
      panel.remove();
    }, 300);
  }

  const releaseOverlay = manageOverlay(panel, () => { close(); opts.onCancel?.(); });
  panel.setAttribute('aria-label','选择年月');
  mask.addEventListener('click', () => { close(); opts.onCancel?.(); });

  confirmBtn.addEventListener('click', () => {
    const y = currentYear();
    const m = mRange(y)[0] + monthCol.getIndex();
    close();
    opts.onConfirm({ year: y, month: m });
  });

  requestAnimationFrame(() => panel.classList.add('dw-open'));

  // e2e 钩子：直接设定年/月选中值（不触发回调）
  (panel as any).__mwSet = (y: number, m: number): void => {
    const cy = clamp(y, minYear, maxYear);
    yearCol.setItems(years, cy - minYear);
    rebuildMonths();
    const [lo] = mRange(cy);
    const cm = clamp(m, ...mRange(cy));
    monthCol.setItems(mItems(cy), cm - lo);
  };

  return panel;
}
