/**
 * 拾光 · 应用入口
 * 初始化顺序：注入图标 → 打开 DB + seed → scheduler 补跑 → 挂载外壳（默认进首页）。
 */
import './styles/tokens.css';
import './styles/base.css';
import { injectIcons } from './assets/icons';
import { db } from './core/db';
import { seedIfNeeded } from './core/seed';
import { initTheme } from './core/theme';
import { startScheduler } from './core/scheduler';
import { initNotifications } from './core/notify';
import { mountShell } from './features/shell/shell';
import { showToast } from './features/shell/toast';
import { registerAccountPage } from './features/account/account';
import { registerReportPage } from './features/report/report';
import { initEntry } from './features/entry/entrySheet';
import { initHome } from './features/home/home';
import { initDetail } from './features/detail/detail';
import { initBudget } from './features/budget/budget';
import { initRecurring } from './features/recurring/recurring';
import { initCalendar } from './features/calendar/calendar';
import { initLoan } from './features/loan/loan';
import { initMine } from './features/mine/mine';
import { initReimburse } from './features/reimburse/reimburse';
import { initCategoryManager } from './features/category/category';
import { initTrash } from './features/trash/trash';
import { initTagMerchant } from './features/tagmerchant/tagmerchant';
import { initLife } from './features/life/life';
import { initHomeEdit } from './features/homeedit/homeedit';
import { initBackup } from './features/backup/backup';
import { initImport } from './features/import/import';
import { initSettings } from './features/settings/settings';
import { initSearch } from './features/search/search';
import { initTemplateManage } from './features/template/template';
import { initShareListener } from './features/ai-inbox/shareListener';
import { initAiInbox } from './features/ai-inbox/aiInbox';
import { enforceAppLock } from './features/settings/lock';
import { migrateLegacySecrets } from './core/secretStore';

async function bootstrap(): Promise<void> {
  injectIcons();
  await db.open();
  await seedIfNeeded();
  const secretMigration = await migrateLegacySecrets();
  // 主题模式：尽早按设置应用（冷启动闪白由 index.html 内联脚本先行处理）
  initTheme();
  // [M3] 应用锁：开启 PIN 时先解锁再补跑/挂载
  await enforceAppLock();
  const { booked, backupDue } = await startScheduler();
  // [R07] 本地通知：消费调度结果重排未来 7 天提醒（Web 端 no-op）
  initNotifications();
  // [AI] 系统分享监听须在 mountShell 前注册，覆盖冷启动分享（子页未就绪时由收件箱缓冲）
  initShareListener();
  mountShell(document.getElementById('app')!);
  registerAccountPage();
  registerReportPage();
  initEntry();
  initHome();
  initDetail();
  initBudget();
  initRecurring();
  initCalendar();
  initLoan();
  initMine();
  initReimburse();
  initCategoryManager();
  initTrash();
  initTagMerchant();
  initLife();
  initHomeEdit();
  initBackup();
  initImport();
  initSettings();
  initSearch();
  initTemplateManage();
  initAiInbox();
  if (secretMigration.failed.length) showToast('部分旧凭据未能迁移，请在设置中重新输入', 3600);
  if (booked > 0) showToast(`周期账已自动入账 ${booked} 笔`);
  // [M3] 自动备份到期轻提醒（频率在设置/备份页配置）
  if (backupDue) showToast('该备份了：到「我的 → 备份与恢复」一键生成备份包');
}

bootstrap().catch((err) => {
  console.error('[main] 启动失败:', err);
  document.getElementById('app')!.innerHTML =
    `<p style="padding:40px 24px;text-align:center;color:#8A7A6A">启动失败，请刷新重试<br><small>${String(err)}</small></p>`;
});
