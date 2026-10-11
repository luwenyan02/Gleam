import { Capacitor } from '@capacitor/core';
import { registerSW } from 'virtual:pwa-register';

/** The native boot gate removes legacy workers; never install another in a native host. */
export function registerWebPwa(): void {
  if (Capacitor.isNativePlatform()) return;
  registerSW({ immediate: true });
}
