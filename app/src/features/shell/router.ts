/**
 * 拾光 · 页面路由（一级页 + 子页）
 * - 一级页（page-*）：常驻 DOM，.is-active 切换，带淡入动画；
 * - 子页（subpage）：openSubpage 时动态创建，右滑入场，关闭即销毁，支持叠放。
 * 后续模块通过 registerPage / registerSubpage 挂载内容（可重复注册覆盖占位页）。
 * 切换一级页后 emit 'route-changed'（payload: { pageId }）。
 */
import { emit } from '../../core/store';
import { iconHtml } from '../../assets/icons';
import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { closeSheet, isSheetOpen } from './sheet';
import { dismissTopOverlay } from '../../shared/overlay';
import { dismissEntrySwipe } from '../../shared/entrySwipeDismiss';
import { handleLayerHistory, pushPageHistory, withoutLayerHistory } from '../../shared/layerHistory';

/** 页面定义 */
export interface PageDef {
  /** 渲染内容到容器（首次显示时调用一次；重新 register 会重渲染） */
  render(el: HTMLElement): void | Promise<void>;
  /** 每次显示时调用（含首次），用于刷新数据 */
  onShow?(): void;
  /** 最后一层子页关闭后恢复可见，可补齐此前延后的数据刷新。 */
  onReveal?(): void;
}

/** 子页定义（标题显示在 sub-head） */
export interface SubpageDef extends PageDef {
  title: string;
}

/** 一级页 id */
export const PAGE_IDS = ['page-home', 'page-acct', 'page-report', 'page-life', 'page-mine'] as const;
export type PageId = (typeof PAGE_IDS)[number];

const pages = new Map<string, PageDef>();
const rendered = new Set<string>();
const subpages = new Map<string, SubpageDef>();
const subStack: HTMLElement[] = [];
const HISTORY_DEPTH_KEY = 'gleamSubDepth';
const SYSTEM_BACK_EVENT = 'gleam:system-back';
export const SUBPAGE_CLOSE_EVENT = 'gleam:subpage-close';

let viewport: HTMLElement | undefined;
let appEl: HTMLElement | undefined;
let activePage: PageId = 'page-home';
let historyReady = false;
let systemBackReady = false;
const subpageOpeners = new WeakMap<HTMLElement, HTMLElement | null>();
const cancelHistoryWrites = new WeakMap<HTMLElement, () => void>();

function syncNavigationState(): void {
  if (!viewport || !appEl) return;
  const hasSubpage = subStack.length > 0;
  for (const pageEl of viewport.querySelectorAll<HTMLElement>('.page')) {
    const exposed = pageEl.id === activePage && !hasSubpage;
    pageEl.inert = !exposed;
    pageEl.setAttribute('aria-hidden', String(!exposed));
  }
  subStack.forEach((subpage, index) => {
    const exposed = index === subStack.length - 1;
    subpage.inert = !exposed;
    subpage.setAttribute('aria-hidden', String(!exposed));
  });
  for (const chrome of appEl.querySelectorAll<HTMLElement>('.tabbar, #fab-life')) {
    chrome.inert = hasSubpage;
    chrome.setAttribute('aria-hidden', String(hasSubpage));
  }
}

/** 路由初始化（shell 挂载后调用一次） */
export function initRouter(app: HTMLElement, vp: HTMLElement): void {
  appEl = app;
  viewport = vp;
  if (!historyReady) {
    historyReady = true;
    window.history.replaceState({ ...withoutLayerHistory(window.history.state), [HISTORY_DEPTH_KEY]: 0 }, '');
    window.addEventListener('popstate', (event) => {
      const state = event.state as Record<string, unknown> | null;
      if (handleLayerHistory(state)) return;
      const requested = Number(state?.[HISTORY_DEPTH_KEY] ?? 0);
      const targetDepth = Number.isInteger(requested) && requested >= 0 ? requested : 0;
      while (subStack.length > targetDepth) closeTopSubpage();
      // 浏览器前进无法重建已销毁页面，收敛到当前真实层级。
      if (targetDepth > subStack.length) {
        window.history.replaceState({ ...(window.history.state ?? {}), [HISTORY_DEPTH_KEY]: subStack.length }, '');
      }
    });
  }
  if (!systemBackReady) {
    systemBackReady = true;
    document.addEventListener(SYSTEM_BACK_EVENT, handleSystemBack);
    if (Capacitor.isNativePlatform()) {
      void App.addListener('backButton', ({ canGoBack }) => {
        document.dispatchEvent(new CustomEvent(SYSTEM_BACK_EVENT, { detail: { canGoBack } }));
      }).catch((error) => console.warn('[router] Android 返回键监听失败', error));
    }
  }
}

/** Android 返回顺序：抽屉 → 最上层子页 → 首页 → 退出 App。 */
function handleSystemBack(): void {
  if (dismissTopOverlay()) return;
  if (isSheetOpen()) {
    closeSheet();
    return;
  }
  if (dismissEntrySwipe()) return;
  if (subStack.length > 0) {
    closeSubpage();
    return;
  }
  if (activePage !== 'page-home') {
    switchPage('page-home');
    return;
  }
  if (Capacitor.isNativePlatform()) void App.exitApp();
}

/**
 * 注册一级页内容（可重复调用覆盖占位；若该页已渲染会立即重渲染）。
 * @param id 'page-home' | 'page-acct' | 'page-report' | 'page-life' | 'page-mine'
 */
export function registerPage(id: PageId, def: PageDef): void {
  pages.set(id, def);
  const el = viewport?.querySelector<HTMLElement>(`#${id}`);
  if (el && rendered.has(id)) {
    el.innerHTML = '';
    void def.render(el);
    if (id === activePage) def.onShow?.();
  }
}

/**
 * 注册子页（备份与恢复、日历账单、周期账等；可重复调用覆盖占位）。
 * @param id 子页 id，如 'sp-backup'
 */
export function registerSubpage(id: string, def: SubpageDef): void {
  subpages.set(id, def);
}

/** 当前激活的一级页 id */
export function currentPage(): PageId {
  return activePage;
}

/**
 * 切换一级页（tab 高亮与 FAB 规则由 shell 监听 'route-changed' 处理）。
 */
export function switchPage(id: PageId): void {
  if (!viewport) return;
  activePage = id;
  for (const pageEl of viewport.querySelectorAll<HTMLElement>('.page')) {
    pageEl.classList.toggle('is-active', pageEl.id === id);
  }
  syncNavigationState();
  const def = pages.get(id);
  const el = viewport.querySelector<HTMLElement>(`#${id}`);
  if (def && el && !rendered.has(id)) {
    rendered.add(id);
    void def.render(el);
  }
  def?.onShow?.();
  emit('route-changed', { pageId: id });
}

/**
 * 打开子页（右滑入场）。未注册的 id 会抛错。
 */
export function openSubpage(id: string): void {
  if (!appEl) return;
  const def = subpages.get(id);
  if (!def) throw new Error(`子页未注册：${id}`);
  const sp = document.createElement('section');
  sp.className = 'subpage';
  sp.id = id;
  sp.innerHTML = `
    <header class="sub-head">
      <button class="icon-btn" data-act="back" aria-label="返回">${iconHtml('ic-left')}</button>
      <h2>${def.title}</h2>
    </header>
    <div class="sub-body"></div>`;
  sp.querySelector('[data-act="back"]')!.addEventListener('click', closeSubpage);
  subpageOpeners.set(sp, document.activeElement instanceof HTMLElement ? document.activeElement : null);
  appEl.appendChild(sp);
  subStack.push(sp);
  syncNavigationState();
  cancelHistoryWrites.set(sp, pushPageHistory({ [HISTORY_DEPTH_KEY]: subStack.length }));
  void def.render(sp.querySelector<HTMLElement>('.sub-body')!);
  requestAnimationFrame(() => sp.classList.add('open'));
  requestAnimationFrame(() => sp.querySelector<HTMLElement>('[data-act="back"]')?.focus());
  def.onShow?.();
}

/** 关闭最上层子页（右滑出场后销毁） */
export function closeSubpage(): void {
  if (!subStack.length) return;
  const depth = Number((window.history.state as Record<string, unknown> | null)?.[HISTORY_DEPTH_KEY] ?? 0);
  if (depth >= subStack.length) {
    window.history.back();
    return;
  }
  closeTopSubpage();
}

/** 只操作 DOM 栈；系统返回/popstate 与标题栏返回共用。 */
function closeTopSubpage(): void {
  const sp = subStack.pop();
  if (!sp) return;
  cancelHistoryWrites.get(sp)?.();
  const opener = subpageOpeners.get(sp);
  sp.inert = true;
  sp.setAttribute('aria-hidden', 'true');
  sp.classList.remove('open');
  // 立即释放页面订阅和延迟渲染缓存，不等待退场动画结束。
  sp.dispatchEvent(new Event(SUBPAGE_CLOSE_EVENT));
  sp.addEventListener('transitionend', () => sp.remove(), { once: true });
  window.setTimeout(() => sp.remove(), 400); // transitionend 兜底
  syncNavigationState();
  // 最后一层子页退出后，一级页重新可见；补齐其延后的数据刷新。
  if (subStack.length === 0) pages.get(activePage)?.onReveal?.();
  requestAnimationFrame(() => opener?.isConnected && opener.focus());
}

/** 是否有子页开启 */
export function hasSubpage(): boolean {
  return subStack.length > 0;
}
