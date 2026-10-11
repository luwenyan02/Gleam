import { db, now } from '../db';
import { emitAfterCommit } from './transactionEvents';
export const HOME_MODULES = ['month', 'quick', 'rhythm', 'today', 'past'] as const;
export type HomeModule = typeof HOME_MODULES[number];
export const HOME_SERVICES = [
  { key: 'note', name: '速记', icon: 'ic-bolt', route: 'sp-template-manage' },
  { key: 'detail', name: '明细', icon: 'ic-file', route: 'sp-entry-detail' },
  { key: 'cal', name: '日历', icon: 'ic-cal', route: 'sp-calendar' },
  { key: 'cycle', name: '周期账', icon: 'ic-repeat', route: 'sp-recurring' },
  { key: 'ai', name: 'AI 记账', icon: 'ic-ai', route: 'sp-ai-inbox' },
  { key: 'budget', name: '预算', icon: 'ic-coin', route: 'sp-budget' },
  { key: 'credit', name: '信用卡', icon: 'ic-card', route: 'sp-credit' },
  { key: 'reimburse', name: '报销', icon: 'ic-card', route: 'sp-reimburse' },
  { key: 'backup', name: '备份与导入', icon: 'ic-cloud', route: 'sp-backup' },
] as const;
export type HomeService = typeof HOME_SERVICES[number]['key'];
export interface HomeLayout { order: HomeModule[]; quick: HomeService[] }
export function normalizeHomeLayout(value: unknown): HomeLayout {
  const row = value && typeof value === 'object' ? value as Partial<HomeLayout> : {};
  const order = Array.isArray(row.order) ? row.order.filter(k => HOME_MODULES.includes(k)) : [];
  const quick = Array.isArray(row.quick) ? row.quick : ['note', 'detail', 'cal', 'cycle', 'ai'] as HomeService[];
  return { order: [...new Set([...order, ...HOME_MODULES])], quick: [...new Set(quick.filter(k => HOME_SERVICES.some(s => s.key === k)))].slice(0, 5) };
}
export async function getHomeLayout(): Promise<HomeLayout> { return normalizeHomeLayout((await db.settings.get('home.layout'))?.value); }
export async function saveHomeLayout(layout: HomeLayout): Promise<void> {
  await db.settings.put({ key: 'home.layout', value: normalizeHomeLayout(layout), updatedAt: now() });
  emitAfterCommit('settings-changed', { key: 'home.layout' });
}
