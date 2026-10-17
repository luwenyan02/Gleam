import { Capacitor, registerPlugin } from '@capacitor/core';

export interface AppUpdate {
  available: boolean;
  releaseId?: string;
  version?: string;
  size?: number;
  notes?: string;
}
interface UpdateBridge {
  configuration(): Promise<void>;
  check(options: { requestId: string }): Promise<AppUpdate>;
  download(options: { requestId: string; releaseId: string }): Promise<void>;
  install(options: { requestId: string; releaseId: string }): Promise<{ permissionRequired: boolean }>;
  cancel(options: { requestId: string }): Promise<void>;
}
export const appUpdate = registerPlugin<UpdateBridge>('GleamUpdate');
export const supportsAppUpdate = () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';

/** Never display native exceptions, GitHub responses, download URLs or credentials. */
export function updateError(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  const messages: Record<string, string> = {
    AUTH: '暂时无法访问更新源，请稍后重试',
    FORBIDDEN: '更新请求暂时受限，请稍后重试',
    NOT_FOUND: '暂无可用的正式更新，请稍后重试',
    RELEASE_INVALID: '新版安装包或校验文件尚未准备好，请稍后重试',
    TIMEOUT: '连接 GitHub 超时，请稍后重试', NETWORK: '无法连接 GitHub，请检查网络后重试',
    DOWNLOAD_SOURCE: '下载地址校验失败，请稍后重新检查更新',
    CHECKSUM: '安装包校验失败，请重新下载', PACKAGE: '安装包版本或包名不匹配，已停止升级',
    SIGNATURE: '安装包签名不匹配，无法覆盖升级', INSTALL: '无法打开系统安装界面，请稍后重试',
    STORAGE: '无法保存安装包，请检查剩余空间',
    RECHECK: '安装包已失效，请重新检查更新', BUSY: '上一次操作尚未结束，请稍后重试',
    CANCELLED: '操作已取消', UNIMPLEMENTED: '当前安装包尚不支持检查新版，请先安装包含此功能的版本',
  };
  return messages[code] ?? '操作未完成，请重试';
}
