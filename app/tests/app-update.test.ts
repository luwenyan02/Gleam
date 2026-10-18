import { beforeEach, expect, it, vi } from 'vitest';
const platform = vi.hoisted(() => ({ native: false, name: 'web' }));
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => platform.native, getPlatform: () => platform.name },
  registerPlugin: vi.fn(() => ({})),
}));
import { supportsAppUpdate, updateError, updateProgress } from '../src/features/settings/appUpdate';
beforeEach(() => { platform.native = false; platform.name = 'web'; });
it('only Android exposes APK updates', () => {
  expect(supportsAppUpdate()).toBe(false);
  platform.native = true; platform.name = 'ios'; expect(supportsAppUpdate()).toBe(false);
  platform.name = 'android'; expect(supportsAppUpdate()).toBe(true);
});
it.each(['AUTH', 'FORBIDDEN', 'NOT_FOUND', 'CHECKSUM', 'SIGNATURE', 'NETWORK', 'UNKNOWN'])('sanitizes %s without reflecting native payloads', code => {
  const result = updateError({ code, message: 'PRIVATE_TOKEN_AND_RESPONSE', url: 'https://private.example' });
  expect(result).not.toMatch(/PRIVATE|private\.example/);
  expect(result.length).toBeGreaterThan(3);
});
it('gives distinct recovery instructions for credentials, integrity and installation', () => {
  expect(updateError({ code: 'AUTH' })).toContain('重新配置');
  expect(updateError({ code: 'CHECKSUM' })).toContain('重新下载');
  expect(updateError({ code: 'SIGNATURE' })).toContain('无法覆盖');
  expect(updateError({ code: 'RECHECK' })).toContain('重新检查');
});

it('下载进度只接受当前请求及版本，单调递增，校验完成前不显示百分之百', () => {
  const event = { requestId: 'current', releaseId: '17', received: 420, total: 1000 };
  expect(updateProgress(0, event, 'current', '17')).toBe(42);
  expect(updateProgress(60, event, 'current', '17')).toBe(60);
  expect(updateProgress(0, { ...event, received: 1000 }, 'current', '17')).toBe(99);
  for (const invalid of [null, undefined, { ...event, requestId: 'old' }, { ...event, releaseId: '18' },
    { ...event, total: 0 }, { ...event, total: NaN }, { ...event, received: -1 },
    { ...event, received: Infinity }, { ...event, received: 1001 }]) {
    expect(updateProgress(10, invalid, 'current', '17')).toBe(10);
  }
});
