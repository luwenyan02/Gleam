import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';

export interface AppVersionInfo {
  /** Installed package version on native; compiled interface version on web. */
  appVersion: string | null;
  webVersion: string;
  platform: 'PWA' | 'Android' | 'iOS' | '原生';
}

const WEB_VERSION = __APP_VERSION__;
let verifiedNativeVersion: string | undefined;
let pendingNativeVersion: Promise<string | null> | undefined;

/** Local package metadata only. Failure stays unknown and is retried on a later render. */
function nativeVersion(): Promise<string | null> {
  if (verifiedNativeVersion) return Promise.resolve(verifiedNativeVersion);
  if (pendingNativeVersion) return pendingNativeVersion;
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 1_500); });
  const read = Promise.resolve().then(() => App.getInfo()).then(info =>
    typeof info?.version === 'string' ? info.version.trim() || null : null);
  const request = Promise.race([read, timeout]).catch(() => null).finally(() => clearTimeout(timer));
  pendingNativeVersion = request;
  void request.then(version => {
    if (version) verifiedNativeVersion = version;
    if (pendingNativeVersion === request) pendingNativeVersion = undefined;
  });
  return request;
}

export async function getAppVersion(): Promise<AppVersionInfo> {
  if (!Capacitor.isNativePlatform()) return { appVersion: WEB_VERSION, webVersion: WEB_VERSION, platform: 'PWA' };
  const platform = Capacitor.getPlatform();
  return { appVersion: await nativeVersion(), webVersion: WEB_VERSION,
    platform: platform === 'android' ? 'Android' : platform === 'ios' ? 'iOS' : '原生' };
}

export function appVersionText(info: AppVersionInfo): string {
  return info.appVersion ? `v${info.appVersion}` : '未读取';
}

/** Only mismatched/unverified native versions need a separate interface label. */
export function interfaceVersionText(info: AppVersionInfo): string | null {
  return info.platform !== 'PWA' && info.appVersion !== info.webVersion ? `v${info.webVersion}` : null;
}

export function aboutVersionText(info: AppVersionInfo): string {
  const frontend = interfaceVersionText(info);
  return `拾光 ${info.appVersion ? appVersionText(info) : '应用版本未读取'} · ${info.platform}${frontend ? ` · 界面 ${frontend}` : ''}`;
}
