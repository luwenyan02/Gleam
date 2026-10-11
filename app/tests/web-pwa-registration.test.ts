import { beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const mocks = vi.hoisted(() => ({ native: false, register: vi.fn() }));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => mocks.native } }));
vi.mock('virtual:pwa-register', () => ({ registerSW: mocks.register }));
import { registerWebPwa } from '../src/core/registerWebPwa';

beforeEach(() => { vi.clearAllMocks(); mocks.native = false; });
it('native hosts do not register a new PWA worker after the legacy boot cleanup', () => {
  mocks.native = true;
  registerWebPwa();
  expect(mocks.register).not.toHaveBeenCalled();
});
it('browser hosts keep virtual-module worker registration', () => {
  registerWebPwa();
  expect(mocks.register).toHaveBeenCalledExactlyOnceWith({ immediate: true });
});
it('the build disables unconditional registration while preserving browser autoUpdate', () => {
  const config = readFileSync('vite.config.ts', 'utf8');
  expect(config).toContain('injectRegister: false');
  expect(config).toContain('skipWaiting: true');
  expect(config).toContain('clientsClaim: true');
  expect(config).toContain("registerType: 'autoUpdate'");
  expect(readFileSync('src/main.ts', 'utf8')).toContain('registerWebPwa();');
});
