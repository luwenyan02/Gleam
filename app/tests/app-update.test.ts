import { beforeEach, expect, it, vi } from 'vitest';
const platform = vi.hoisted(() => ({ native: false, name: 'web' }));
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => platform.native, getPlatform: () => platform.name },
  registerPlugin: vi.fn(() => ({})),
}));
import { supportsAppUpdate, updateError } from '../src/features/settings/appUpdate';
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
it('gives distinct recovery instructions for public-source access, integrity and installation', () => {
  expect(updateError({ code: 'AUTH' })).not.toMatch(/Token|凭据|重新配置/);
  expect(updateError({ code: 'CHECKSUM' })).toContain('重新下载');
  expect(updateError({ code: 'SIGNATURE' })).toContain('无法覆盖');
  expect(updateError({ code: 'RECHECK' })).toContain('重新检查');
});
