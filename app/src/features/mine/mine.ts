/**
 * 拾光 · 我的页（features/mine，覆盖 shell 占位 page-mine）
 * 头部（头像/记账天数与笔数/设置入口）+ 功能入口列表。
 * 入口协作约定（leader 2026-08-09）：本模块归 M2-C 所有，入口一并挂
 * M2-D 模块（报销 sp-reimburse / 分类 sp-categories / 回收站 sp-trash /
 * 标签与商家 sp-tags，由 M2-D 注册实现）与 M3 占位（sp-backup / sp-settings）。
 * 视觉结构与原型 index.html #page-mine（L740-762）一致。
 */
import './mine.css';
import { APP_VERSION } from '../backup/skbak';
import { iconHtml } from '../../assets/icons';
import { on } from '../../core/store';
import { formatFenCny } from '../../core/money';
import { listEntries, dayKey } from '../../core/repo/entryRepo';
import { getBudget } from '../../core/repo/budgetRepo';
import { budgetUsage } from '../../core/repo/statsRepo';
import { listLoanContacts } from '../../core/repo/loanRepo';
import { registerPage, openSubpage } from '../shell/router';
import { showToast } from '../shell/toast';

/* ── 模块状态 ── */
let body: HTMLElement | undefined;
/** 并发刷新令牌 */
let refreshToken = 0;

function curMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** 入口行 */
function rowHtml(sub: string, icon: string, title: string, note: string): string {
  return `
    <button class="row" data-sub="${sub}">
      <span class="e-ic">${iconHtml(icon, 18)}</span>${title}
      <span class="row-note num">${note}</span>
      <span class="chev">${iconHtml('ic-right', 15)}</span>
    </button>`;
}

function groupHtml(title: string, rows: string, label: string): string {
  return `<section class="mine-group" aria-label="${label}">
    <h3>${title}</h3><div class="card list">${rows}</div>
  </section>`;
}

/* ── 页面渲染 ── */

async function refresh(): Promise<void> {
  const el = body;
  if (!el?.isConnected) return;
  const token = ++refreshToken;
  const month = curMonth();
  const [entries, budget, usage, contacts] = await Promise.all([
    listEntries(), getBudget(month), budgetUsage(month), listLoanContacts(),
  ]);
  if (token !== refreshToken || !el.isConnected) return;

  /* 头部统计：记账天数（有记录的自然日）与流水笔数 */
  const days = new Set(entries.map((e) => dayKey(e.occurredAt))).size;

  /* 动态入口备注 */
  const budgetNote = budget && budget.totalLimit > 0
    ? `本月剩余 ${formatFenCny(budget.totalLimit - usage.totalUsed)}` : '未设置';
  const owedToMe = contacts.reduce((s, c) => s + Math.max(0, c.balance), 0);
  const iOwe = contacts.reduce((s, c) => s + Math.max(0, -c.balance), 0);
  const loanNote = contacts.length
    ? (owedToMe > 0 || iOwe > 0
      ? [owedToMe > 0 ? `待收 ${formatFenCny(owedToMe)}` : '', iOwe > 0 ? `待还 ${formatFenCny(iOwe)}` : ''].filter(Boolean).join(' · ')
      : `${contacts.length} 位对象 · 已结清`)
    : '借入借出与还款收款';
  const pendingBx = entries.filter((e) => e.type === 'expense' && e.reimburseStatus === 'pending');
  const bxNote = pendingBx.length
    ? `${pendingBx.length} 笔 · ${formatFenCny(pendingBx.reduce((s, e) => s + e.amount, 0))}` : '待报销归集';

  el.innerHTML = `
    <header class="mine-head" aria-label="我的">
      <span class="avatar" aria-hidden="true">拾</span>
      <div>
        <h2>我的拾光</h2>
        <p class="sub">已记录 ${days} 天 · ${entries.length} 条流水</p>
      </div>
      <button class="icon-btn" data-sub="sp-settings" aria-label="应用设置">${iconHtml('ic-set')}</button>
    </header>
    ${groupHtml('记账偏好', `
      ${rowHtml('sp-reimburse', 'ic-file', '报销管理', bxNote)}
      ${rowHtml('sp-budget', 'ic-coin', '预算中心', budgetNote)}
      ${rowHtml('sp-loan', 'ic-loan-in', '借贷往来', loanNote)}
      ${rowHtml('sp-recurring', 'ic-repeat', '周期账', '固定支出自动入账')}
      ${rowHtml('sp-categories', 'ic-set', '分类管理', '支出两级 · 收入单级')}
      ${rowHtml('sp-template-manage', 'ic-bolt', '速记模板', '分类加金额 · 一键记账')}
      ${rowHtml('sp-tags', 'ic-tag', '标签与商家', '排行与筛选维度')}
    `, '记账偏好')}
    ${groupHtml('数据与备份', `
      ${rowHtml('sp-backup', 'ic-cloud', '备份与恢复', '备份 · 恢复 · Excel')}
      ${rowHtml('sp-trash', 'ic-trash', '回收站', '删除账单保留 30 天')}
    `, '数据与备份')}
    ${groupHtml('智能能力与通知', `
      ${rowHtml('sp-ai-inbox', 'ic-ai', 'AI 记账收件箱', '分享截图 · 粘贴账单')}
    `, '智能能力与通知')}
    ${groupHtml('外观与安全', `
      ${rowHtml('sp-settings', 'ic-set', '设置中心', '通知 · 外观 · 应用锁')}
    `, '外观与安全')}
    <section class="mine-group" aria-label="关于和帮助">
      <h3>关于和帮助</h3><div class="card list">
      <button class="row" data-about>
        <span class="e-ic">${iconHtml('ic-file', 18)}</span>关于拾光
        <span class="row-note">v${APP_VERSION} · PWA</span>
        <span class="chev">${iconHtml('ic-right', 15)}</span>
      </button>
      </div>
    </section>
    <p class="tiny" style="text-align:center;padding:4px 0 10px">账本数据本地保存 · 仅在你主动启用云备份或 AI 识别时连接外部服务</p>`;
}

/* ── 装配 ── */

/** 注册我的页（覆盖 shell 占位 page-mine），main.ts 调用一次 */
export function initMine(): void {
  registerPage('page-mine', {
    render(el) {
      body = el;
      el.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const sub = target.closest<HTMLElement>('[data-sub]');
        if (sub) {
          // sp-tags 等待并行模块注册期间可能尚未就绪，兜底提示而非抛错
          try { openSubpage(sub.dataset.sub!); } catch { showToast('该功能即将上线'); }
          return;
        }
        if (target.closest('[data-about]')) showToast(`拾光 v${APP_VERSION} · 记录，是为了被时间照亮`);
      });
      void refresh();
    },
    onShow() { void refresh(); },
  });

  // 流水/预算变化时刷新头部统计与入口备注（页面常驻，body 始终连接）
  on('entries-changed', () => void refresh());
  on('budgets-changed', () => void refresh());
}
