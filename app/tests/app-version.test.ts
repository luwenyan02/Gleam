import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const mocks = vi.hoisted(() => ({ native: false, platform: 'android', getInfo: vi.fn() }));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => mocks.native, getPlatform: () => mocks.platform } }));
vi.mock('@capacitor/app', () => ({ App: { getInfo: mocks.getInfo } }));
const webVersion = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version;
const load = () => import('../src/core/appVersion');

beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); mocks.native = false; mocks.platform = 'android'; });
afterEach(() => vi.useRealTimers());

it('web keeps the compiled frontend version and never calls the native App bridge', async () => {
  const { getAppVersion, appVersionText, interfaceVersionText, aboutVersionText } = await load();
  const info = await getAppVersion();
  expect(info).toEqual({ appVersion: webVersion, webVersion, platform: 'PWA' });
  expect(appVersionText(info)).toBe(`v${webVersion}`);
  expect(interfaceVersionText(info)).toBeNull();
  expect(aboutVersionText(info)).toBe(`拾光 v${webVersion} · PWA`);
  expect(mocks.getInfo).not.toHaveBeenCalled();
});
it('Android reports the installed package version and omits redundant interface version when matched', async () => {
  mocks.native = true; mocks.getInfo.mockResolvedValue({ version: webVersion, build: '999999' });
  const { getAppVersion, interfaceVersionText, aboutVersionText } = await load();
  const info = await getAppVersion();
  expect(info).toEqual({ appVersion: webVersion, webVersion, platform: 'Android' });
  expect(interfaceVersionText(info)).toBeNull();
  expect(aboutVersionText(info)).toBe(`拾光 v${webVersion} · Android`);
  expect(mocks.getInfo).toHaveBeenCalledExactlyOnceWith();
});
it('a package/frontend mismatch shows the genuine installed version and labels the interface separately', async () => {
  mocks.native = true; mocks.getInfo.mockResolvedValue({ version: '91.2.3', build: '91203' });
  const { getAppVersion, appVersionText, interfaceVersionText, aboutVersionText } = await load();
  const info = await getAppVersion();
  expect(appVersionText(info)).toBe('v91.2.3');
  expect(interfaceVersionText(info)).toBe(`v${webVersion}`);
  expect(aboutVersionText(info)).toBe(`拾光 v91.2.3 · Android · 界面 v${webVersion}`);
});
it.each([undefined, null, '', '   ', 11007])('missing or malformed package version %s remains unknown rather than falling back to the interface', async version => {
  mocks.native = true; mocks.getInfo.mockResolvedValue({ version });
  const { getAppVersion, appVersionText, interfaceVersionText, aboutVersionText } = await load();
  const info = await getAppVersion();
  expect(info.appVersion).toBeNull(); expect(appVersionText(info)).toBe('未读取');
  expect(interfaceVersionText(info)).toBe(`v${webVersion}`);
  expect(aboutVersionText(info)).toBe(`拾光 应用版本未读取 · Android · 界面 v${webVersion}`);
});
it('a rejected bridge read is sanitized and can be retried on the next page render', async () => {
  mocks.native = true;
  mocks.getInfo.mockRejectedValueOnce(new Error('PRIVATE_NATIVE_MESSAGE')).mockResolvedValueOnce({ version: webVersion });
  const { getAppVersion, aboutVersionText } = await load();
  const unavailable = await getAppVersion();
  expect(unavailable.appVersion).toBeNull();
  expect(aboutVersionText(unavailable)).not.toContain('PRIVATE');
  expect((await getAppVersion()).appVersion).toBe(webVersion);
  expect(mocks.getInfo).toHaveBeenCalledTimes(2);
});
it('concurrent renders share a read and verified package information is cached in memory', async () => {
  mocks.native = true;
  let resolve!: (info: { version: string }) => void;
  mocks.getInfo.mockImplementation(() => new Promise(done => { resolve = done; }));
  const { getAppVersion } = await load();
  const one = getAppVersion(); const two = getAppVersion();
  await Promise.resolve(); expect(mocks.getInfo).toHaveBeenCalledOnce();
  resolve({ version: webVersion });
  expect(await one).toEqual(await two);
  await getAppVersion(); expect(mocks.getInfo).toHaveBeenCalledOnce();
});
it('a stalled read is bounded and its late result cannot replace a newer verified version', async () => {
  vi.useFakeTimers(); mocks.native = true;
  let late!: (info: { version: string }) => void;
  mocks.getInfo.mockImplementationOnce(() => new Promise(done => { late = done; })).mockResolvedValueOnce({ version: '92.0.0' });
  const { getAppVersion } = await load();
  const pending = getAppVersion();
  await vi.advanceTimersByTimeAsync(1_500);
  expect((await pending).appVersion).toBeNull();
  expect((await getAppVersion()).appVersion).toBe('92.0.0');
  late({ version: '90.0.0' }); await Promise.resolve();
  expect((await getAppVersion()).appVersion).toBe('92.0.0');
  expect(mocks.getInfo).toHaveBeenCalledTimes(2);
});
it('mine and about own shared version display without relabeling the backup manifest', () => {
  const settings = readFileSync('src/features/settings/settings.ts', 'utf8');
  const mine = readFileSync('src/features/mine/mine.ts', 'utf8');
  expect(settings).not.toContain('data-app-version');
  expect(settings).not.toContain('data-interface-version');
  expect(mine).toContain('getAppVersion()'); expect(mine).toContain('openAbout(displayedVersion)');
  expect(readFileSync('src/features/settings/about.ts', 'utf8')).toContain('aboutVersionText(info)');
  expect(mine).not.toContain('v${APP_VERSION} · PWA');
  expect(readFileSync('src/features/backup/skbak.ts', 'utf8')).toContain('appVersion: APP_VERSION');
});
