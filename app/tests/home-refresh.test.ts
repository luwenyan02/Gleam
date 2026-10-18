import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Entry } from '../src/core/types';

const mocks = vi.hoisted(() => ({
  registerPage: vi.fn(), on: vi.fn(), listEntries: vi.fn(),
  ledgerEntriesInRange: vi.fn(), monthSummary: vi.fn(), refreshRhythm: vi.fn(),
  modules: { month: true, quick: true, today: true, past: true },
}));
vi.mock('../src/features/home/spendingRhythm', () => ({
  spendingRhythmHtml: () => '', bindSpendingRhythm: vi.fn(), refreshSpendingRhythm: mocks.refreshRhythm,
}));
vi.mock('../src/assets/icons', () => ({ iconHtml: () => '' }));
vi.mock('../src/core/store', () => ({ on: mocks.on }));
vi.mock('../src/core/repo/entryRepo', () => ({
  listEntries: mocks.listEntries, getEntry: vi.fn(),
  dayKey: (at: number) => {
    const d = new Date(at);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  },
}));
vi.mock('../src/core/repo/categoryRepo', () => ({ listCategories: async () => [], listExpenseTree: async () => [] }));
vi.mock('../src/core/repo/accountRepo', () => ({ listAccounts: async () => [] }));
vi.mock('../src/core/repo/lifeRepo', () => ({ listLifeNotes: async () => [] }));
vi.mock('../src/core/repo/templateRepo', () => ({ listTemplates: async () => [] }));
vi.mock('../src/core/repo/settingsRepo', () => ({ getSetting: async (key: string) => key === 'home.modules' ? mocks.modules : false }));
vi.mock('../src/core/repo/statsRepo', () => ({
  monthSummary: mocks.monthSummary, budgetUsage: async () => ({}), ledgerEntriesInRange: mocks.ledgerEntriesInRange,
}));
vi.mock('../src/core/repo/budgetRepo', () => ({ getBudget: async () => undefined }));
vi.mock('../src/core/repo/periodRepo', () => ({
  getAccountingMonth: async () => '2026-10',
  getAccountingMonthStartDay: async () => 1,
  accountingMonthRange: async () => ({ from: 0, to: 1 }),
}));
vi.mock('../src/core/repo/homeLayoutRepo', () => ({
  getHomeLayout: async () => ({ quick: [], order: [] }), HOME_SERVICES: [],
}));
vi.mock('../src/features/search/search', () => ({ openLedgerSearch: vi.fn() }));
vi.mock('../src/core/notify', () => ({ listInAppReminders: async () => [] }));
vi.mock('../src/features/shell/router', () => ({ registerPage: mocks.registerPage, openSubpage: vi.fn() }));
vi.mock('../src/features/shell/toast', () => ({ showToast: vi.fn() }));
vi.mock('../src/features/entry/entrySheet', () => ({ openEntrySheet: vi.fn() }));
vi.mock('../src/features/detail/detail', () => ({
  bindEntrySwipeActions: vi.fn(), entrySwipeActionsHtml: () => '', openEntryDetail: vi.fn(), runEntryQuickAction: vi.fn(),
}));
vi.mock('../src/shared/pickList', () => ({ openPickList: vi.fn() }));

// Only the DOM surface used by home is needed; repository work remains independently deferred.
class ElementStub {
  innerHTML = ''; textContent = ''; hidden = false; inert = false; isConnected = true;
  scrollTop = 0; clientHeight = 844; scrollHeight = 6000;
  dataset: Record<string, string> = {}; disabled = false;
  style: Record<string, string> = {};
  classList = { toggle: vi.fn(), contains: () => true };
  children = new Map<string, ElementStub>();
  listeners = new Map<string, (event?: unknown) => void>();
  querySelector(selector: string): ElementStub {
    if (!this.children.has(selector)) this.children.set(selector, new ElementStub());
    return this.children.get(selector)!;
  }
  querySelectorAll(): ElementStub[] { return []; }
  addEventListener(event: string, fn: (event?: unknown) => void): void { this.listeners.set(event, fn); }
  scrollToBottom(pull = true): void {
    this.scrollTop = this.scrollHeight - this.clientHeight;
    this.listeners.get('scroll')?.();
    if (pull) this.listeners.get('wheel')?.({ deltaY: 100, deltaX: 0 });
  }
  rowCount(): number { return (this.querySelector('#hm-days').innerHTML.match(/data-entry-row=/g) ?? []).length; }
}

const summary = { income: 0, expense: 0, balance: 0 };
let entries: Entry[];
function fixture(count = 60, older = true): Entry[] {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12).getTime();
  const olderMonth = new Date(now.getFullYear(), now.getMonth() - 3, 15, 12).getTime();
  return Array.from({ length: count + Number(older) }, (_, i) => ({
    id: i + 1, type: 'expense', amount: 100, occurredAt: i < count ? today : olderMonth,
    accountId: 1, reimburseStatus: 'none', deletedAt: 0, createdAt: today, updatedAt: today,
  }));
}
async function flush(): Promise<void> { for (let i = 0; i < 40; i++) await Promise.resolve(); }
async function mount(): Promise<ElementStub> {
  const { initHome } = await import('../src/features/home/home');
  initHome();
  const el = new ElementStub();
  mocks.registerPage.mock.calls[0][1].render(el);
  await flush();
  return el;
}
function holdMonth(): () => void {
  let release!: () => void;
  mocks.monthSummary.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(summary); }));
  return () => release();
}

beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 18, 12));
  vi.stubGlobal('window', { setTimeout, clearTimeout, requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0) });
  vi.stubGlobal('document', { hidden: false, addEventListener: vi.fn() });
  mocks.modules = { month: true, quick: true, today: true, past: true };
  entries = fixture();
  mocks.monthSummary.mockResolvedValue(summary);
  mocks.listEntries.mockImplementation(async ({ limit, to = Infinity }) =>
    entries.filter(entry => entry.occurredAt < to).slice(0, limit));
  mocks.ledgerEntriesInRange.mockImplementation(async (from: number, to: number) =>
    entries.filter(entry => entry.occurredAt >= from && entry.occurredAt < to).map(entry => ({ ...entry, kind: 'entry' })));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('首页仍在刷新总览时，单次触底请求不会丢失', async () => {
  const release = holdMonth();
  const el = await mount();
  expect(el.rowCount()).toBe(60);
  expect(el.querySelector('#hm-more').textContent).toBe('再上拉加载2026年7月');
  el.scrollToBottom();
  release(); await flush();
  expect(el.rowCount()).toBe(61);
  expect(el.querySelector('#hm-more').textContent).toBe('已展示全部流水');
});

it('刷新期间已到期的数据变更请求会在当前刷新结束后执行', async () => {
  const release = holdMonth();
  const el = await mount();
  entries = fixture(61, false);
  mocks.on.mock.calls.find(([name]) => name === 'entries-changed')![1]();
  await vi.advanceTimersByTimeAsync(50);
  expect(el.rowCount()).toBe(60);
  release(); await flush();
  expect(el.rowCount()).toBe(61);
});

it('同月超过百笔流水仍完整展示，一次继续上拉只增加一个月', async () => {
  entries = fixture(100);
  const el = await mount();
  expect(el.rowCount()).toBe(100);
  el.scrollToBottom(); await flush();
  expect(el.rowCount()).toBe(101);
});

it('等待刷新时滚离底部，不再执行过期的分页请求', async () => {
  const release = holdMonth();
  const el = await mount();
  el.scrollToBottom(); el.scrollTop = 0;
  release(); await flush();
  expect(el.rowCount()).toBe(60);
  expect(mocks.ledgerEntriesInRange).toHaveBeenCalledTimes(1);
});

it('全部流水已展示时，触底不会重复查询', async () => {
  entries = fixture(60, false);
  const el = await mount();
  el.scrollToBottom(); await flush();
  expect(el.rowCount()).toBe(60);
  expect(mocks.ledgerEntriesInRange).toHaveBeenCalledTimes(1);
});

it('刷新期间同一轮多次上拉只合并为一个月，不扩大正在执行的查询', async () => {
  const release = holdMonth();
  const el = await mount();
  el.scrollToBottom(); el.scrollToBottom(); el.scrollToBottom();
  expect(mocks.ledgerEntriesInRange).toHaveBeenCalledTimes(1);
  release(); await flush();
  expect(el.rowCount()).toBe(61);
  expect(mocks.ledgerEntriesInRange).toHaveBeenCalledTimes(2);
  expect(mocks.ledgerEntriesInRange.mock.calls.map(([from]) => from)).toEqual([new Date(2026, 7, 1).getTime(), new Date(2026, 6, 1).getTime()]);
});

it('等待刷新时页面变为不可交互，不执行过期的分页请求', async () => {
  const release = holdMonth();
  const el = await mount();
  el.scrollToBottom(); el.inert = true;
  release(); await flush();
  expect(el.rowCount()).toBe(60);
  expect(mocks.ledgerEntriesInRange).toHaveBeenCalledTimes(1);
});

it('数据刷新优先于排队分页，最新数据已无更早流水时不继续查询', async () => {
  const release = holdMonth();
  const el = await mount();
  el.scrollToBottom();
  entries = fixture(60, false);
  mocks.on.mock.calls.find(([name]) => name === 'entries-changed')![1]();
  await vi.advanceTimersByTimeAsync(50);
  release(); await flush();
  expect(el.rowCount()).toBe(60);
  expect(el.querySelector('#hm-more').textContent).toBe('已展示全部流水');
  expect(mocks.ledgerEntriesInRange).toHaveBeenCalledTimes(2);
  expect(mocks.ledgerEntriesInRange.mock.calls.map(([from]) => from)).toEqual([new Date(2026, 7, 1).getTime(), new Date(2026, 7, 1).getTime()]);
});

it('报销展示事件不扩大下一次加载的月份范围', async () => {
  mocks.ledgerEntriesInRange.mockImplementation(async (from: number, to: number) => [
    ...entries.filter(entry => entry.occurredAt >= from && entry.occurredAt < to).map(entry => ({ ...entry, kind: 'entry' })),
    ...entries.slice(0, 60).map(entry => ({ ...entry, kind: 'reimbursement', type: 'income' })),
  ]);
  const el = await mount();
  expect(el.rowCount()).toBe(120);
  el.scrollToBottom(); await flush();
  expect(el.rowCount()).toBe(121);
  expect(mocks.ledgerEntriesInRange.mock.calls.map(([from]) => from)).toEqual([new Date(2026, 7, 1).getTime(), new Date(2026, 6, 1).getTime()]);
});


it('本地午夜重新查询消费节奏；回到前台也更新日期窗口', async () => {
  vi.setSystemTime(new Date(2026, 9, 3, 23, 59, 59));
  await mount();
  expect(mocks.refreshRhythm).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1050);
  await flush();
  expect(mocks.refreshRhythm).toHaveBeenCalledTimes(2);
  const listener = vi.mocked(document.addEventListener).mock.calls.find(([event]) => event === 'visibilitychange')![1] as () => void;
  listener();
  await vi.advanceTimersByTimeAsync(50);
  await flush();
  expect(mocks.refreshRhythm).toHaveBeenCalledTimes(3);
});

it('只滚动到底部不自动加载，明确的继续上拉才加载一个月', async () => {
  const el = await mount();
  el.scrollToBottom(false); await flush();
  expect(el.rowCount()).toBe(60);
  expect(mocks.ledgerEntriesInRange).toHaveBeenCalledTimes(1);
  el.listeners.get('wheel')?.({ deltaY: 100, deltaX: 0 }); await flush();
  expect(el.rowCount()).toBe(61);
});
