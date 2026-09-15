import { beforeEach, expect, it, vi } from 'vitest';
import { initNativeEntry } from '../src/features/entry/nativeEntry';

const mocks = vi.hoisted(() => ({
  open: vi.fn(), toast: vi.fn(), shortcuts: vi.fn(), sheetOpen: false,
  listener: undefined as undefined | ((event: {url: string}) => void),
  launch: 'shiguang://entry?type=income',
  events: new Map<string, () => void>(),
  templates: [{id: 2, name: '虚构咖啡'}],
}));
vi.mock('@capacitor/core', () => ({ Capacitor: { getPlatform: () => 'android' }, registerPlugin: () => ({setShortcuts: mocks.shortcuts}) }));
vi.mock('@capacitor/app', () => ({ App: {
  addListener: async (_: string, callback: (event: {url: string}) => void) => { mocks.listener = callback; },
  getLaunchUrl: async () => ({url: mocks.launch}),
} }));
vi.mock('../src/core/store', () => ({on: (event: string, callback: () => void) => mocks.events.set(event, callback)}));
vi.mock('../src/core/repo/templateRepo', () => ({listTemplates: async () => mocks.templates}));
vi.mock('../src/core/repo/settingsRepo', () => ({getSetting: async (key: string) => key === 'entry.recentTemplates' ? [2] : null}));
vi.mock('../src/features/shell/sheet', () => ({isSheetOpen: () => mocks.sheetOpen}));
vi.mock('../src/features/shell/toast', () => ({showToast: mocks.toast}));
vi.mock('../src/features/entry/entrySheet', () => ({openEntrySheet: mocks.open}));
beforeEach(() => {
  vi.clearAllMocks(); mocks.sheetOpen = false; mocks.launch = 'shiguang://entry?type=income';
  mocks.templates = [{id: 2, name: '虚构咖啡'}];
});

it('冷启动链接与重复 appUrlOpen 只打开一次，热启动可使用不同入口', async () => {
  await initNativeEntry();
  expect(mocks.open).toHaveBeenCalledWith({presetType: 'income'});
  mocks.listener?.({url: mocks.launch});
  expect(mocks.open).toHaveBeenCalledTimes(1);
  mocks.listener?.({url: 'shiguang://entry?type=expense'});
  await vi.waitFor(() => expect(mocks.open).toHaveBeenCalledTimes(2));
  expect(mocks.shortcuts).toHaveBeenCalledWith({templates: [{id: 2, name: '虚构咖啡'}]});
});
it('失效模板回退支出草稿，删除事件刷新快捷列表', async () => {
  mocks.launch = 'shiguang://entry?template=999';
  await initNativeEntry();
  expect(mocks.open).toHaveBeenCalledWith({presetType: 'expense'});
  expect(mocks.toast).toHaveBeenCalledWith('模板已删除，请重新填写');
  mocks.templates = [];
  mocks.events.get('templates-changed')?.();
  await vi.waitFor(() => expect(mocks.shortcuts).toHaveBeenLastCalledWith({templates: []}));
});
it('已有草稿时拒绝覆盖，未知链接不触发操作', async () => {
  mocks.sheetOpen = true;
  await initNativeEntry();
  expect(mocks.open).not.toHaveBeenCalled();
  expect(mocks.toast).toHaveBeenCalledWith('请先保存或关闭当前草稿');
  mocks.sheetOpen = false;
  mocks.listener?.({url: 'shiguang://entry?type=delete'});
  expect(mocks.open).not.toHaveBeenCalled();
});

it('无关设置广播不会重复发布相同快捷入口并耗尽系统更新配额', async () => {
  await initNativeEntry();
  for (let i = 0; i < 20; i++) mocks.events.get('settings-changed')?.();
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(mocks.shortcuts).toHaveBeenCalledTimes(1);
});
