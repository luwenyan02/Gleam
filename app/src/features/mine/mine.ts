/**
 * 拾光 · 我的页（features/mine，覆盖 shell 占位 page-mine）
 * 头部（头像/记账天数与笔数/设置入口）+ 功能入口列表。
 * 入口协作约定（leader 2026-08-09）：本模块归 M2-C 所有，入口一并挂
 * M2-D 模块（报销 sp-reimburse / 分类 sp-categories / 回收站 sp-trash /
 * 标签与商家 sp-tags，由 M2-D 注册实现）与 M3 占位（sp-backup / sp-settings）。
 * 视觉结构与原型 index.html #page-mine（L740-762）一致。
 */
import './mine.css';
import { appVersionText, getAppVersion, type AppVersionInfo } from '../../core/appVersion';
import { iconHtml } from '../../assets/icons';
import { on } from '../../core/store';
import { formatFenCny } from '../../core/money';
import { getMineEntrySummary, getMineLifeNoteCount } from '../../core/repo/mineRepo';
import { getLastLocalBackupAt } from '../backup/backupHistory';
import { dismissBackupReminder, shouldRemindBackup } from '../backup/backupStatus';
import { ensureMonthBudget } from '../../core/repo/budgetRepo';
import { getAccountingMonth } from '../../core/repo/periodRepo';
import { budgetUsage } from '../../core/repo/statsRepo';
import { listLoanAccounts } from '../../core/repo/loanRepo';
import { registerPage, openSubpage, currentPage } from '../shell/router';
import { showToast } from '../shell/toast';
import { openAbout } from '../settings/about';
import { openSettingsManual } from '../settings/settingsManual';

/* ── 模块状态 ── */
let body: HTMLElement | undefined;
/** 并发刷新令牌 */
let refreshToken = 0;
let pendingRefresh: Promise<void> | undefined;
let pendingBody: HTMLElement | undefined;
let displayedVersion: AppVersionInfo | undefined;

/** 入口行 */
function rowHtml(sub: string, icon: string, title: string, note: string): string {
  return `
    <button class="row" data-sub="${sub}">
      <span class="e-ic">${iconHtml(icon, 18)}</span>${title}
      <span class="row-note num">${note}</span>
      <span class="chev">${iconHtml('ic-right', 15)}</span>
    </button>`;
}

function groupHtml(title: string, rows: string, label: string, footer = ''): string {
  return `<section class="mine-group" aria-label="${label}">
    <h3>${title}</h3><div class="card list">${rows}</div>${footer}
  </section>`;
}

/* ── 页面渲染 ── */

function renderContent(el: HTMLElement): void {
  el.innerHTML = `
    <header class="mine-head" aria-label="我的">
      <span class="avatar" aria-hidden="true">拾</span>
      <div>
        <h2>我的拾光</h2>
        <p class="sub" data-mine-stats>正在统计流水</p>
      </div>
      <button class="icon-btn" data-sub="sp-settings" aria-label="应用设置">${iconHtml('ic-set')}</button>
    </header>
    ${groupHtml('记账偏好', `
      ${rowHtml('sp-reimburse', 'ic-file', '报销管理', '读取中')}
      ${rowHtml('sp-budget', 'ic-coin', '预算中心', '读取中')}
      ${rowHtml('sp-loan', 'ic-loan-in', '应收应付', '读取中')}
      ${rowHtml('sp-recurring', 'ic-repeat', '周期账', '固定支出自动入账')}
      ${rowHtml('sp-categories', 'ic-set', '分类管理', '支出两级 · 收入单级')}
      ${rowHtml('sp-template-manage', 'ic-bolt', '速记模板', '分类加金额 · 一键记账')}
      ${rowHtml('sp-tags', 'ic-tag', '标签与商家', '排行与筛选维度')}
    `, '记账偏好')}
    ${groupHtml('数据与备份', `
      ${rowHtml('sp-backup', 'ic-cloud', '备份与恢复', '读取中')}
      ${rowHtml('sp-trash', 'ic-trash', '回收站', '删除账单保留 30 天')}
    `, '数据与备份', `<aside class="mine-backup-reminder" data-backup-reminder hidden aria-label="备份提醒">
      <p>账本保存在本机，建议备份一份。</p>
      <div><button class="btn" data-backup-now>去备份</button><button class="btn" data-dismiss-backup>7 天后提醒</button></div>
    </aside>`)}
    ${groupHtml('智能能力与通知', `
      ${rowHtml('sp-ai-inbox', 'ic-ai', 'AI 记账收件箱', '分享截图 · 粘贴账单')}
    `, '智能能力与通知')}
    ${groupHtml('外观与安全', `
      ${rowHtml('sp-settings', 'ic-set', '设置中心', '通知 · 外观 · 应用锁')}
    `, '外观与安全')}
    <section class="mine-group" aria-label="关于和帮助">
      <h3>关于和帮助</h3><div class="card list">
      <button class="row" data-help-manual>
        <span class="e-ic">${iconHtml('ic-book', 18)}</span>使用手册
        <span class="row-note">操作说明与图解</span>
        <span class="chev">${iconHtml('ic-right', 15)}</span>
      </button>
      <button class="row" data-about>
        <span class="e-ic">${iconHtml('ic-file', 18)}</span>关于拾光
        <span class="row-note" data-app-version>读取中</span>
        <span class="chev">${iconHtml('ic-right', 15)}</span>
      </button>
      </div>
    </section>
    <p class="tiny" style="text-align:center;padding:4px 0 10px">账本数据本地保存 · 云备份、AI 识别和检查更新由你主动发起</p>`;
}

/** 内容先显示，摘要分别更新；同一页面只保留一组读取，变化后再刷新。 */
function refresh(): Promise<void> {
  const el = body;
  if (!el?.isConnected || currentPage() !== 'page-mine') return Promise.resolve();
  if (pendingRefresh && pendingBody === el) return pendingRefresh;
  const token = refreshToken;
  const current = () => body === el && el.isConnected && token === refreshToken;
  const text = (selector: string, value: string) => {
    if (current()) { const node = el.querySelector(selector); if (node) node.textContent = value; }
  };
  const summary = getMineEntrySummary();
  const stats = summary.then(summary => {
    text('[data-mine-stats]', `已记录 ${summary.days} 天 · ${summary.count} 条流水`);
    text('[data-sub="sp-reimburse"] .row-note', summary.pendingCount
      ? `${summary.pendingCount} 笔 · ${formatFenCny(summary.pendingAmount)}` : '待报销归集');
  }).catch(() => {
    text('[data-mine-stats]', '流水统计暂不可用');
    text('[data-sub="sp-reimburse"] .row-note', '暂未读取');
  });
  const budget = (async () => {
    const month = await getAccountingMonth();
    const limit = await ensureMonthBudget(month);
    const usage = limit && limit.totalLimit > 0 ? await budgetUsage(month) : undefined;
    text('[data-sub="sp-budget"] .row-note', usage && limit
      ? `本期剩余 ${formatFenCny(limit.totalLimit - usage.totalUsed)}` : '未设置');
  })().catch(() => text('[data-sub="sp-budget"] .row-note', '暂未读取'));
  const loans = listLoanAccounts().then(contacts => {
    const owedToMe = contacts.reduce((sum, contact) => sum + Math.max(0, contact.balance), 0);
    const iOwe = contacts.reduce((sum, contact) => sum + Math.max(0, -contact.balance), 0);
    const note = contacts.length
      ? [owedToMe > 0 ? `待收 ${formatFenCny(owedToMe)}` : '', iOwe > 0 ? `待还 ${formatFenCny(iOwe)}` : ''].filter(Boolean).join(' · ') || `${contacts.length} 个账户 · 已结清`
      : '借入借出与还款收款';
    text('[data-sub="sp-loan"] .row-note', note);
  }).catch(() => text('[data-sub="sp-loan"] .row-note', '暂未读取'));
  const version = getAppVersion().then(info => {
    if (current()) displayedVersion = info;
    text('[data-app-version]', `${appVersionText(info)} · ${info.platform}`);
  }).catch(() => text('[data-app-version]', '暂未读取'));
  const backup = Promise.all([summary, getLastLocalBackupAt(), getMineLifeNoteCount()]).then(([summary, lastAt, lifeCount]) => {
    const date = new Date(lastAt);
    const time = `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
    text('[data-sub="sp-backup"] .row-note', lastAt ? `最近 ${time}` : '未备份');
    if (current()) {
      const reminder = el.querySelector<HTMLElement>('[data-backup-reminder]');
      if (reminder) reminder.hidden = !shouldRemindBackup(lastAt, summary.count > 0 || lifeCount > 0);
    }
  }).catch(() => text('[data-sub="sp-backup"] .row-note', '暂未读取'));
  const task = Promise.all([stats, budget, loans, version, backup]).then(() => undefined);
  pendingBody = el;
  pendingRefresh = task;
  void task.finally(() => {
    if (pendingRefresh !== task) return;
    pendingRefresh = undefined;
    if (body === el && el.isConnected && token !== refreshToken) void refresh();
  });
  return task;
}

function invalidate(): void {
  refreshToken++;
  void refresh();
}

/* ── 装配 ── */

/** 注册我的页（覆盖 shell 占位 page-mine），main.ts 调用一次 */
export function initMine(): void {
  registerPage('page-mine', {
    render(el) {
      body = el;
      displayedVersion = undefined;
      refreshToken++;
      renderContent(el);
      el.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        if (target.closest('[data-dismiss-backup]')) {
          dismissBackupReminder();
          const reminder = el.querySelector<HTMLElement>('[data-backup-reminder]');
          if (reminder) reminder.hidden = true;
          el.querySelector<HTMLElement>('[data-sub="sp-backup"]')?.focus();
          return;
        }
        if (target.closest('[data-backup-now]')) { openSubpage('sp-backup'); return; }
        const sub = target.closest<HTMLElement>('[data-sub]');
        if (sub) {
          // sp-tags 等待并行模块注册期间可能尚未就绪，兜底提示而非抛错
          try { openSubpage(sub.dataset.sub!); } catch { showToast('该功能即将上线'); }
          return;
        }
        if (target.closest('[data-help-manual]')) openSettingsManual();
        if (target.closest('[data-about]')) {
          if (displayedVersion) openAbout(displayedVersion);
          else showToast('正在读取应用版本，请稍后重试');
        }
      });
    },
    onShow() { invalidate(); },
  });

  // 隐藏页只标记失效，不在后台反复遍历账本；下次显示时读取。
  on('entries-changed', invalidate);
  on('life-changed', invalidate);
  on('accounts-changed', invalidate);
  on('categories-changed', invalidate);
  on('budgets-changed', invalidate);
  on('settings-changed', invalidate);
}
