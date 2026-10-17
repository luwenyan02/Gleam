/**
 * 拾光 · 本地通知（notify，R07）
 * 作为 scheduler 结果的外围消费方（scheduler.ts 完全不动）：
 * 自持 visibilitychange 回前台重排 + 监听 'settings-changed' 开关/频率变化重排。
 * 每次重排按固定 id 区间分组先撤销后重排未来 7 天：
 * - 周期账入账提醒（id 1000+）：enabled 规则 nextRunAt 落在 7 天内，当日 09:00；
 * - 信用卡还款日提醒（id 2000+）：credit 组含 repayDay 账户，还款日当天 10:00；
 * 全部通知非精确（isExactNotification: false）+ allowWhileIdle，接受分钟级偏差；
 * Web 不调系统通知 API；两开关控制首页应用内提醒。
 */
import { Capacitor } from '@capacitor/core';
import { LocalNotifications, type LocalNotificationSchema } from '@capacitor/local-notifications';
import { on } from './store';
import { getSetting } from './repo/settingsRepo';
import { listRules } from './repo/recurringRepo';
import { listAccounts } from './repo/accountRepo';
import { listCreditStatementSummaries } from './repo/creditRepo';
import { formatFen } from './money';
import { openSubpage, switchPage } from '../features/shell/router';

/** 通知 id 分组区间（每组重排时先 cancel 本组已排项） */
const ID_GROUPS = {
  /** 周期账：1000-1999 */
  recurring: { base: 1000, max: 1999 },
  /** 信用卡还款：2000-2999 */
  creditCard: { base: 2000, max: 2999 },
  /** 仅用于取消旧版备份通知；不再创建此组。 */
  backup: { base: 3000, max: 3999 },
} as const;

/** 重排窗口：未来 7 天 */
const WINDOW_MS = 7 * 86400000;
const CREDIT_WINDOW_MS = 3 * 86400000;

export interface InAppReminder {
  id: string;
  kind: 'recurring' | 'creditCard';
  title: string;
  body: string;
  dueAt: number;
  route: 'sp-recurring' | 'sp-credit';
  icon: 'ic-repeat' | 'ic-card' | 'ic-cloud';
}

function reminderDateText(dueAt: number, now: number): string {
  const due = new Date(dueAt);
  const today = new Date(now);
  due.setHours(0, 0, 0, 0);
  today.setHours(0, 0, 0, 0);
  const days = Math.round((due.getTime() - today.getTime()) / 86400000);
  if (days < 0) return `已逾期 ${-days} 天`;
  if (days === 0) return '今天到期';
  if (days === 1) return '明天到期';
  return `${due.getMonth() + 1}月${due.getDate()}日到期`;
}

/** 网页版首页提醒；只在打开拾光时计算，不承诺页面关闭后的系统推送。 */
export async function listInAppReminders(now = Date.now()): Promise<InAppReminder[]> {
  if (Capacitor.isNativePlatform()) return [];
  const [swRecurring, swCredit] = await Promise.all([
    getSetting('notification.recurring'),
    getSetting('notification.creditCard'),
  ]);
  const reminders: InAppReminder[] = [];
  if (swRecurring) {
    for (const rule of await listRules()) {
      if (!rule.enabled || rule.nextRunAt > now + WINDOW_MS) continue;
      reminders.push({
        id: `recurring-${rule.id}`,
        kind: 'recurring',
        title: `周期账 · ${rule.name}`,
        body: `${reminderDateText(rule.nextRunAt, now)}${rule.amountConfirm ? '，需确认金额' : `，${rule.type === 'income' ? '收入' : '支出'} ¥${formatFen(rule.amount)}`}`,
        dueAt: rule.nextRunAt,
        route: 'sp-recurring',
        icon: 'ic-repeat',
      });
    }
  }
  if (swCredit) {
    const cards = (await listAccounts()).filter((account) => account.group === 'credit' && account.creditReminderEnabled !== false);
    for (const card of cards) {
      for (const summary of await listCreditStatementSummaries(card.id!)) {
        if (summary.remaining <= 0 || summary.statement.reminderEnabled === false || summary.statement.dueAt > now + CREDIT_WINDOW_MS) continue;
        reminders.push({
          id: `credit-${summary.statement.id}`,
          kind: 'creditCard',
          title: `信用卡 · ${card.name}`,
          body: `${reminderDateText(summary.statement.dueAt, now)}，剩余应还 ¥${formatFen(summary.remaining)}`,
          dueAt: summary.statement.dueAt,
          route: 'sp-credit',
          icon: 'ic-card',
        });
      }
    }
  }
  return reminders.sort((a, b) => a.dueAt - b.dueAt).slice(0, 5);
}

/**
 * 检查并按需请求系统通知权限。
 * @returns 已授权 true；用户拒绝（或系统不支持）false
 */
export async function ensurePermission(): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return false;
  try {
    let { display } = await LocalNotifications.checkPermissions();
    if (display !== 'granted') ({ display } = await LocalNotifications.requestPermissions());
    return display === 'granted';
  } catch (err) {
    console.warn('[notify] 权限检查失败:', err);
    return false;
  }
}

/** 指定时间戳所在自然日的 hh:00 时刻 */
function atHour(ts: number, hour: number): number {
  const d = new Date(ts);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
}

/**
 * 收集周期账提醒：enabled 规则 nextRunAt 落在未来 7 天内的，
 * 当日 09:00 提醒（nextRunAt 早于当日 09:00 则用 nextRunAt 时刻）。
 */
async function collectRecurring(now: number): Promise<LocalNotificationSchema[]> {
  const rules = await listRules();
  const out: LocalNotificationSchema[] = [];
  for (const rule of rules) {
    if (!rule.enabled || rule.nextRunAt <= now || rule.nextRunAt > now + WINDOW_MS) continue;
    const fireAt = Math.min(atHour(rule.nextRunAt, 9), rule.nextRunAt);
    if (fireAt <= now) continue; // 只排未来时刻
    out.push({
      id: ID_GROUPS.recurring.base + (out.length % 1000),
      title: '周期账提醒',
      body: `「${rule.name}」今天${rule.amountConfirm ? '到期，请确认金额入账' : `将自动入账 ¥${formatFen(rule.amount)}`}`,
      schedule: { at: new Date(fireAt), allowWhileIdle: true },
      extra: { route: 'sp-recurring' },
      isExactNotification: false,
    });
  }
  return out;
}

/**
 * 收集信用卡账单提醒：未还清且开启提醒的账单，到期前 3 天与到期当天 10:00 各一条；
 * 还清或修改到期日后由重排自动更新。
 */
async function collectCreditCard(now: number): Promise<LocalNotificationSchema[]> {
  const accounts = await listAccounts();
  const cards = accounts.filter((a) => a.group === 'credit' && a.creditReminderEnabled !== false);
  const out: LocalNotificationSchema[] = [];
  for (const card of cards) {
    const summaries = await listCreditStatementSummaries(card.id!);
    for (const summary of summaries) {
      if (summary.remaining <= 0 || summary.statement.reminderEnabled === false) continue;
      for (const offset of [3, 0]) {
        const fireAt = atHour(summary.statement.dueAt - offset * 86400000, 10);
        if (fireAt <= now || fireAt > now + WINDOW_MS) continue;
        out.push({
          id: ID_GROUPS.creditCard.base + (out.length % 1000),
          title: '信用卡还款提醒',
          body: offset === 0
            ? `「${card.name}」今天是还款日，剩余应还 ¥${formatFen(summary.remaining)}`
            : `「${card.name}」${offset} 天后到期，剩余应还 ¥${formatFen(summary.remaining)}`,
          schedule: { at: new Date(fireAt), allowWhileIdle: true },
          extra: { route: 'sp-credit' },
          isExactNotification: false,
        });
      }
    }
  }
  return out;
}

/** 撤销 id 落在本模块三个区间内的全部已排通知 */
async function cancelOurs(): Promise<void> {
  const { notifications } = await LocalNotifications.getPending();
  const mine = notifications.filter((n) =>
    Object.values(ID_GROUPS).some((g) => n.id >= g.base && n.id <= g.max));
  if (mine.length) await LocalNotifications.cancel({ notifications: mine.map((n) => ({ id: n.id })) });
}

let refreshing = false;

/**
 * 重排全部通知：先撤销本模块已排项，再按两个场景开关重排未来 7 天。
 * 两开关全关（或未授权）时只撤销、不再排。幂等防重入。
 */
export async function refreshSchedules(): Promise<void> {
  if (!Capacitor.isNativePlatform() || refreshing) return;
  refreshing = true;
  try {
    const [swRecurring, swCredit] = await Promise.all([
      getSetting('notification.recurring'), getSetting('notification.creditCard'),
    ]);
    await cancelOurs();
    if (!swRecurring && !swCredit) return;
    const { display } = await LocalNotifications.checkPermissions();
    if (display !== 'granted') return; // 未授权：开关引导授权后再重排
    const now = Date.now();
    const notifications: LocalNotificationSchema[] = [
      ...(swRecurring ? await collectRecurring(now) : []),
      ...(swCredit ? await collectCreditCard(now) : []),
    ];
    if (notifications.length) await LocalNotifications.schedule({ notifications });
  } catch (err) {
    console.warn('[notify] 通知重排失败:', err);
  } finally {
    refreshing = false;
  }
}

/** settings-changed 中会影响排期的键（开关） */
const WATCH_KEYS = new Set([
  'notification.recurring', 'notification.creditCard',
]);

/**
 * 初始化本地通知（main.ts 在 startScheduler 之后调用一次）：
 * 注册点击路由与两类重排触发（回前台 / 相关设置变化），并立即重排一次。
 * Web 非原生平台直接 no-op。
 */
export function initNotifications(): void {
  if (!Capacitor.isNativePlatform()) return;

  // 点击通知按 extra.route 跳转：一级页走 switchPage，子页走 openSubpage
  void LocalNotifications.addListener('localNotificationActionPerformed', (action) => {
    const route = (action.notification.extra as { route?: string } | undefined)?.route;
    if (!route) return;
    try {
      if (route === 'page-acct') switchPage('page-acct');
      else openSubpage(route);
    } catch (err) {
      console.warn('[notify] 通知跳转失败:', err);
    }
  }).catch((err) => console.warn('[notify] 通知点击监听注册失败:', err));

  // 回前台重排（scheduler 自身的 visibilitychange 已推进 nextRunAt，这里消费最新结果）
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void refreshSchedules();
  });
  // 开关变化时重排
  on('settings-changed', (payload) => {
    const key = (payload as { key?: string } | undefined)?.key;
    if (key && WATCH_KEYS.has(key)) void refreshSchedules();
  });
  void refreshSchedules();
}
