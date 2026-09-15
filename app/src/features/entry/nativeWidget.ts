import { Capacitor, registerPlugin } from '@capacitor/core';
import { App } from '@capacitor/app';
import { on } from '../../core/store';
import { getSetting } from '../../core/repo/settingsRepo';
import { getBudget } from '../../core/repo/budgetRepo';
import { budgetUsage } from '../../core/repo/statsRepo';
import { getAccountingMonth, accountingMonthRange } from '../../core/repo/periodRepo';
import { widgetSummary } from '../../core/widgetSummary';

const native = registerPlugin<{ updateWidget(options: ReturnType<typeof widgetSummary>): Promise<void> }>('GleamEntry');

/** 小组件只缓存衍生摘要；编辑、恢复、预算和口径变更后重新计算。 */
export function initNativeWidget(): void {
  if (Capacitor.getPlatform() !== 'android') return;
  let running = false;
  let dirty = false;
  const refresh = async () => {
    dirty = true;
    if (running) return;
    running = true;
    try {
      while (dirty) {
        dirty = false;
        const month = await getAccountingMonth();
        const [period, usage, budget, pin] = await Promise.all([
          accountingMonthRange(month), budgetUsage(month), getBudget(month), getSetting('security.pin'),
        ]);
        await native.updateWidget(widgetSummary({
          expense: usage.totalUsed, budget: budget?.totalLimit, ...period, locked: pin != null, now: Date.now(),
        }));
      }
    } catch (error) { console.warn('[widget] 摘要更新失败', error); }
    finally { running = false; }
  };
  for (const event of ['entries-changed', 'budgets-changed', 'settings-changed'] as const) on(event, () => { void refresh(); });
  void App.addListener('appStateChange', ({ isActive }) => { if (isActive) void refresh(); });
  void refresh();
}
