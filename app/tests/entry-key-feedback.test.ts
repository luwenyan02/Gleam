import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { entryKeyFeedback } from '../src/features/entry/entryKeyFeedback';

const mocks = vi.hoisted(() => ({ platform: 'android', tap: vi.fn(), vibrate: vi.fn() }));
vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: () => mocks.platform },
  registerPlugin: () => ({ keyFeedback: mocks.tap }),
}));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.platform = 'android';
  mocks.tap.mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { vibrate: mocks.vibrate });
});
afterEach(() => vi.unstubAllGlobals());

it('Android 使用系统键盘触感，不叠加网页振动', async () => {
  await entryKeyFeedback();
  expect(mocks.tap).toHaveBeenCalledOnce();
  expect(mocks.vibrate).not.toHaveBeenCalled();
});

it('旧安装包缺少触感方法时仍可继续记账，不强制振动', async () => {
  mocks.tap.mockRejectedValue(new Error('not implemented'));
  await expect(entryKeyFeedback()).resolves.toBeUndefined();
  expect(mocks.vibrate).not.toHaveBeenCalled();
});

it('网页使用短促振动，浏览器拒绝时不影响输入', async () => {
  mocks.platform = 'web';
  mocks.vibrate.mockReturnValue(false);
  await expect(entryKeyFeedback()).resolves.toBeUndefined();
  expect(mocks.vibrate).toHaveBeenCalledWith(12);
  expect(mocks.tap).not.toHaveBeenCalled();
});

it('不支持振动的浏览器正常运行', async () => {
  mocks.platform = 'web';
  vi.stubGlobal('navigator', {});
  await expect(entryKeyFeedback()).resolves.toBeUndefined();
});

it('浏览器振动接口抛错不阻断计算或保存', async () => {
  mocks.platform = 'web';
  mocks.vibrate.mockImplementation(() => { throw new Error('blocked'); });
  await expect(entryKeyFeedback()).resolves.toBeUndefined();
});
