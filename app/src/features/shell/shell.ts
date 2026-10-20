/**
 * 拾光 · 应用外壳（shell）
 * 挂载 App 骨架：viewport（5 个一级页）、底部导航、子页容器宿主、
 * scrim/sheet/toast/dialog 公共节点，并注册全部占位页面。
 *
 * FAB 规则（与原型一致）：
 * - 首页时中央为 FAB(+)，点击打开「记一笔」抽屉；
 * - 进入其他 Tab 后中央位置替换为「首页」Tab 按钮；
 * - 拾光页另挂底部聊天入口(#fab-life，不进 tabbar)，
 *   仅 page-life 路由时显示；点击行为由 life 模块直接绑定，
 *   shell 不感知（样式 .life-chat-dock 在 life.css）。
 */
import { iconHtml } from '../../assets/icons';
import { on } from '../../core/store';
import {
  initRouter, registerPage, registerSubpage, switchPage, openSubpage,
  type PageId,
} from './router';
import { initSheet } from './sheet';
import { showToast } from './toast';

/** 「记一笔」FAB 点击回调（M1-A 注册记一笔抽屉后替换） */
let fabAction: () => void = () => showToast('记一笔功能开发中');

/** 注册 FAB 点击行为（记一笔模块调用） */
export function setFabAction(fn: () => void): void {
  fabAction = fn;
}

/** 一级页元信息 */
const PAGE_META: { id: PageId; name: string; icon: string }[] = [
  { id: 'page-home', name: '首页', icon: 'ic-home' },
  { id: 'page-acct', name: '账户', icon: 'ic-wallet' },
  { id: 'page-report', name: '报表', icon: 'ic-chart' },
  { id: 'page-life', name: '拾光', icon: 'ic-book' },
  { id: 'page-mine', name: '我的', icon: 'ic-user' },
];

/** 子页清单（占位标题；后续模块 registerSubpage 覆盖实现） */
export const SUBPAGE_META: { id: string; title: string; icon: string }[] = [
  { id: 'sp-backup', title: '备份与恢复', icon: 'ic-cloud' },
  { id: 'sp-calendar', title: '日历账单', icon: 'ic-cal' },
  { id: 'sp-recurring', title: '周期账', icon: 'ic-repeat' },
  { id: 'sp-budget', title: '预算中心', icon: 'ic-coin' },
  { id: 'sp-credit', title: '信用卡账单', icon: 'ic-card' },
  { id: 'sp-reimburse', title: '报销管理', icon: 'ic-file' },
  { id: 'sp-categories', title: '分类管理', icon: 'ic-set' },
  { id: 'sp-entry-detail', title: '账单明细', icon: 'ic-book' },
  { id: 'sp-trash', title: '回收站', icon: 'ic-trash' },
  { id: 'sp-home-custom', title: '首页自定义', icon: 'ic-home' },
  { id: 'sp-search', title: '搜索', icon: 'ic-search' },
  { id: 'sp-settings', title: '设置', icon: 'ic-set' },
];

/**
 * 挂载应用外壳到根节点，注册占位页并进入首页。
 * main.ts 在 DB/seed/scheduler 就绪后调用。
 */
export function mountShell(root: HTMLElement): void {
  root.innerHTML = `
    <div class="app">
      <main class="viewport">
        ${PAGE_META.map((p) => `<section class="page" id="${p.id}"></section>`).join('')}
      </main>
      <nav class="tabbar" aria-label="主导航">
        <button class="tab" data-page="page-report">${iconHtml('ic-chart')}报表</button>
        <button class="tab" data-page="page-acct">${iconHtml('ic-wallet')}账户</button>
        <button class="fab" id="fab" aria-label="记一笔">${iconHtml('ic-plus')}</button>
        <button class="tab" id="tab-home" data-page="page-home" hidden>${iconHtml('ic-home')}首页</button>
        <button class="tab" data-page="page-life">${iconHtml('ic-book')}拾光</button>
        <button class="tab" data-page="page-mine">${iconHtml('ic-user')}我的</button>
      </nav>
      <button class="life-chat-dock" id="fab-life" data-life-chat aria-label="和拾光聊聊" hidden><span class="life-chat-mark" aria-hidden="true">✦</span><span class="life-chat-copy"><strong>和拾光聊聊</strong><span>这一刻，最想留下什么？</span></span>${iconHtml('ic-right', 18)}</button>
      <div id="scrim"></div>
      <section class="sheet" id="sheet" role="dialog" aria-modal="true"></section>
      <div class="dialog-scrim" id="dialog-scrim" aria-hidden="true" inert></div>
      <div id="toast" role="status" aria-live="polite"></div>
    </div>`;

  const app = root.querySelector<HTMLElement>('.app')!;
  const viewport = app.querySelector<HTMLElement>('.viewport')!;
  initRouter(app, viewport);
  initSheet();

  // 底部导航：tab 切页 + FAB
  const tabbar = app.querySelector<HTMLElement>('.tabbar')!;
  tabbar.addEventListener('click', (e) => {
    const tab = (e.target as HTMLElement).closest<HTMLElement>('[data-page]');
    if (tab) switchPage(tab.dataset.page as PageId);
  });
  app.querySelector<HTMLElement>('#fab')!.addEventListener('click', () => fabAction());

  // FAB 规则与 tab 高亮：首页显示 FAB、隐藏「首页」tab；其他页反之；
  // 拾光页底部聊天入口仅在 page-life 显示
  on('route-changed', (payload) => {
    const pageId = (payload as { pageId: PageId }).pageId;
    const home = pageId === 'page-home';
    app.querySelector<HTMLElement>('#fab')!.hidden = !home;
    app.querySelector<HTMLElement>('#tab-home')!.hidden = home;
    app.querySelector<HTMLElement>('#fab-life')!.hidden = pageId !== 'page-life';
    for (const tab of tabbar.querySelectorAll<HTMLElement>('.tab')) {
      tab.classList.toggle('active', tab.dataset.page === pageId && !home);
    }
  });

  registerPlaceholders();
  switchPage('page-home');
}

/** 占位页渲染（后续模块 registerPage/registerSubpage 覆盖） */
function placeholder(name: string, icon: string): (el: HTMLElement) => void {
  return (el) => {
    el.innerHTML = `
      <div class="placeholder">
        <span class="e-ic neutral">${iconHtml(icon, 26)}</span>
        <p class="sub">「${name}」开发中</p>
        <p class="tiny">该模块由后续里程碑实现</p>
      </div>`;
  };
}

/** 注册全部一级页与子页的占位实现 */
function registerPlaceholders(): void {
  for (const p of PAGE_META) {
    if (p.id === 'page-home') {
      // 首页占位：额外提供子页入口便于验收外壳
      registerPage(p.id, {
        render(el) {
          el.innerHTML = `
            <header class="page-head">
              <div><h1 class="brand">拾光</h1><p class="sub">记录，是为了被时间照亮</p></div>
              <button class="icon-btn" data-sub="sp-search" aria-label="搜索">${iconHtml('ic-search')}</button>
            </header>
            <section class="card">
              <h2 class="card-title">子页速览（占位）</h2>
              ${SUBPAGE_META.map(
                (s) => `<button class="row" data-sub="${s.id}">
                  <span class="e-ic neutral">${iconHtml(s.icon, 18)}</span>${s.title}
                  <span class="chev" style="margin-left:auto">${iconHtml('ic-right', 15)}</span>
                </button>`,
              ).join('')}
            </section>`;
          el.addEventListener('click', (e) => {
            const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-sub]');
            if (btn) openSubpage(btn.dataset.sub!);
          });
        },
      });
    } else {
      registerPage(p.id, { render: placeholder(p.name, p.icon) });
    }
  }
  for (const s of SUBPAGE_META) {
    registerSubpage(s.id, { title: s.title, render: placeholder(s.title, s.icon) });
  }
}
