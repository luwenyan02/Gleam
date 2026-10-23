import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { db } from '../src/core/db';
import { setSetting } from '../src/core/repo/settingsRepo';
import { saveMonthlyBudget } from '../src/core/repo/budgetRepo';
import { emit } from '../src/core/store';
import { addLifeNote, softDeleteLifeNote, restoreLifeNote } from '../src/core/repo/lifeRepo';
import * as mineRepo from '../src/core/repo/mineRepo';

const router = vi.hoisted(() => ({ registerPage: vi.fn(), currentPage: vi.fn(() => 'page-mine') }));
const version = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../src/features/shell/router', () => ({ registerPage: router.registerPage, currentPage: router.currentPage, openSubpage: vi.fn() }));
vi.mock('../src/features/shell/toast', () => ({ showToast: vi.fn() }));
vi.mock('../src/features/settings/about', () => ({ openAbout: vi.fn() }));
vi.mock('../src/features/settings/settingsManual', () => ({ openSettingsManual: vi.fn() }));
vi.mock('../src/core/appVersion', () => ({
  getAppVersion: version.read,
  appVersionText: () => '1.0.0',
}));
import { initMine } from '../src/features/mine/mine';

let element: HTMLElement;
let nodes: Map<string, { textContent: string; hidden?: boolean }>;
async function openMine(): Promise<void> {
  initMine();
  const hooks = router.registerPage.mock.calls.at(-1)![1];
  nodes = new Map();
  element = { isConnected: true, innerHTML: '', addEventListener: vi.fn(), querySelector: (selector: string) => {
    if (!nodes.has(selector)) nodes.set(selector, { textContent: '' });
    return nodes.get(selector);
  } } as unknown as HTMLElement;
  hooks.render(element);
  expect(element.innerHTML).toContain('预算中心');
  hooks.onShow();
  await vi.waitFor(() => expect(budgetNote()).toContain('本期剩余'));
}
function budgetNote(): string {
  return nodes.get('[data-sub="sp-budget"] .row-note')?.textContent ?? '';
}

beforeEach(async () => {
  version.read.mockResolvedValue({ appVersion: '1.0.0', platform: 'PWA' });
  router.currentPage.mockReturnValue('page-mine');
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


it('版本读取未返回时，入口立即可见且预算摘要独立完成', async () => {
  let release!: (info: unknown) => void;
  version.read.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  await openMine();
  expect(element.innerHTML).toContain('应用设置');
  expect(budgetNote()).toBe('本期剩余 ¥500.00');
  release({ appVersion: '1.0.0', platform: 'PWA' });
  await vi.waitFor(() => expect(nodes.get('[data-app-version]')?.textContent).toContain('1.0.0'));
});

it('首次 render 加 onShow 只读取一次头部摘要，隐藏页不因账单变化重读', async () => {
  const read = vi.spyOn(mineRepo, 'getMineEntrySummary');
  try {
    await openMine();
    await vi.waitFor(() => expect(nodes.get('[data-app-version]')?.textContent).toContain('1.0.0'));
    expect(read).toHaveBeenCalledTimes(1);
    read.mockClear();
    router.currentPage.mockReturnValue('page-home');
    emit('entries-changed');
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(read).not.toHaveBeenCalled();
    router.currentPage.mockReturnValue('page-mine');
    router.registerPage.mock.calls.at(-1)![1].onShow();
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(nodes.get('[data-mine-stats]')?.textContent).toContain('3 条流水'));
  } finally { read.mockRestore(); }
});

it('我的页备份入口显示本机未备份状态，并预留可关闭的页内提醒', async () => {
  await openMine();
  await vi.waitFor(() => expect(nodes.get('[data-sub="sp-backup"] .row-note')?.textContent).toBe('未备份'));
  expect(element.innerHTML).toContain('data-backup-reminder');
  expect(element.innerHTML).toContain('data-dismiss-backup');
});


it('零流水但有照片生活记录时提醒备份，统计不读取正文或附件', async () => {
  await db.entries.clear();
  await addLifeNote({ kind: 'photo', occurredAt: Date.now(), body: '虚构生活记录'.repeat(1000), photoRefs: [1] });
  const indexValues = vi.spyOn(IDBIndex.prototype, 'getAll');
  const storeValues = vi.spyOn(IDBObjectStore.prototype, 'getAll');
  const indexCursor = vi.spyOn(IDBIndex.prototype, 'openCursor');
  const storeCursor = vi.spyOn(IDBObjectStore.prototype, 'openCursor');
  try {
    await openMine();
    await vi.waitFor(() => expect(nodes.get('[data-backup-reminder]')?.hidden).toBe(false));
    expect(nodes.get('[data-mine-stats]')?.textContent).toContain('0 条流水');
    for (const spy of [indexValues, indexCursor]) {
      expect(spy.mock.contexts.filter(index => ['lifeNotes', 'attachments'].includes(index.objectStore.name))).toHaveLength(0);
    }
    for (const spy of [storeValues, storeCursor]) {
      expect(spy.mock.contexts.filter(store => ['lifeNotes', 'attachments'].includes(store.name))).toHaveLength(0);
    }
  } finally { indexValues.mockRestore(); storeValues.mockRestore(); indexCursor.mockRestore(); storeCursor.mockRestore(); }
});

it('空账本打开我的页后新增、删除及恢复生活记录，备份提醒随真实事件刷新', async () => {
  await db.entries.clear();
  await openMine();
  await vi.waitFor(() => expect(nodes.get('[data-backup-reminder]')?.hidden).toBe(true));
  const id = await addLifeNote({ kind: 'diary', occurredAt: Date.now(), body: '虚构日记' });
  await vi.waitFor(() => expect(nodes.get('[data-backup-reminder]')?.hidden).toBe(false));
  await softDeleteLifeNote(id);
  await vi.waitFor(() => expect(nodes.get('[data-backup-reminder]')?.hidden).toBe(true));
  await restoreLifeNote(id);
  await vi.waitFor(() => expect(nodes.get('[data-backup-reminder]')?.hidden).toBe(false));
});
