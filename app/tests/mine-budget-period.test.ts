import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { db } from '../src/core/db';
import { setSetting } from '../src/core/repo/settingsRepo';
import { saveMonthlyBudget } from '../src/core/repo/budgetRepo';

const router = vi.hoisted(() => ({ registerPage: vi.fn() }));
vi.mock('../src/features/shell/router', () => ({ registerPage: router.registerPage, openSubpage: vi.fn() }));
vi.mock('../src/features/shell/toast', () => ({ showToast: vi.fn() }));
vi.mock('../src/features/settings/about', () => ({ openAbout: vi.fn() }));
vi.mock('../src/features/settings/settingsManual', () => ({ openSettingsManual: vi.fn() }));
vi.mock('../src/core/appVersion', () => ({
  getAppVersion: async () => ({ version: '1.0.0', platform: 'web' }),
  appVersionText: () => '1.0.0',
}));
import { initMine } from '../src/features/mine/mine';

let element: HTMLElement;
async function openMine(): Promise<void> {
  initMine();
  const hooks = router.registerPage.mock.calls.at(-1)![1];
  element = { isConnected: true, innerHTML: '', addEventListener: vi.fn() } as unknown as HTMLElement;
  hooks.render(element);
  await vi.waitFor(() => expect(element.innerHTML).toContain('预算中心'));
}
function budgetNote(): string {
  return element.innerHTML.match(/data-sub="sp-budget"[\s\S]*?class="row-note num">([^<]*)</)?.[1] ?? '';
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 18, 12));
  await db.delete(); await db.open();
  await setSetting('accounting.monthStartDay', 28);
  await saveMonthlyBudget('2026-09', 100000, [], false);
  await saveMonthlyBudget('2026-10', 900000, [], false);
  const stamp = { createdAt: Date.now(), updatedAt: Date.now() };
  await db.entries.bulkPut([
    { id: 1, type: 'expense', amount: 20000, occurredAt: new Date(2026, 8, 28, 12).getTime(), categoryId: 1, accountId: 1, reimburseStatus: 'none', deletedAt: 0, ...stamp },
    { id: 2, type: 'expense', amount: 30000, occurredAt: new Date(2026, 9, 18, 12).getTime(), categoryId: 1, accountId: 1, reimburseStatus: 'none', deletedAt: 0, ...stamp },
    { id: 3, type: 'expense', amount: 40000, occurredAt: new Date(2026, 9, 28, 12).getTime(), categoryId: 1, accountId: 1, reimburseStatus: 'none', deletedAt: 0, ...stamp },
  ]);
});
afterEach(() => { if (element) Object.assign(element, { isConnected: false }); vi.useRealTimers(); });

it('我的预算摘要使用与预算中心相同的当前记账周期', async () => {
  await openMine();
  expect(budgetNote()).toBe('本期剩余 ¥500.00');
});
it('调整起始日后，已打开的我的页立即更新预算摘要', async () => {
  await openMine();
  await setSetting('accounting.monthStartDay', 1);
  await vi.waitFor(() => expect(budgetNote()).toBe('本期剩余 ¥8,300.00'));
});
it('未进入预算中心时，也能显示自动延续后的本期余额', async () => {
  await db.budgets.clear();
  await saveMonthlyBudget('2026-08', 200000, [], true);
  await openMine();
  expect(budgetNote()).toBe('本期剩余 ¥1,500.00');
  expect((await db.budgets.where('month').equals('2026-09').first())?.totalLimit).toBe(200000);
});
