/**
 * 拾光 · 云备份通道抽象（features/backup/provider）[R06]
 * 红线：仅承载「整包 .skbak 上传 / 下载 / 删除 / 列表」，严禁任何增量同步语义；
 * 凭证只从 settings KV 读取，任何错误消息、日志不得包含服务器地址与凭证。
 * 具体实现见 providers/webdav.ts 与 providers/s3.ts。
 */
import { getSetting } from '../../core/repo/settingsRepo';

/** 云端备份文件元信息 */
export interface CloudFile {
  /** 文件名（不含目录前缀） */
  name: string;
  /** 字节数 */
  size: number;
  /** 最后修改时间（毫秒时间戳，解析失败为 0） */
  lastModified: number;
}

/** 云备份通道统一接口：整包上传 / 列表 / 下载 / 删除 / 连接测试 */
export interface BackupProvider {
  /** 通道类型（写 BackupRecord.provider 用） */
  readonly kind: 'webdav' | 's3';
  /** 测试连接：验证地址、凭证与目录可用性，失败抛 CloudError */
  test(): Promise<void>;
  /** 上传整包 .skbak（同名覆盖） */
  upload(name: string, blob: Blob): Promise<void>;
  /** 列出云端 .skbak 文件，lastModified 倒序 */
  list(): Promise<CloudFile[]>;
  /** 下载整包，供现有恢复五步流程消费 */
  download(name: string): Promise<Blob>;
  /** 删除云端文件 */
  delete(name: string): Promise<void>;
}

/* ── 错误分类与超时 ── */

/** 云操作错误类别：网络不通 / 认证失败 / 超时 / 服务端异常 */
export type CloudErrorKind = 'network' | 'auth' | 'timeout' | 'server';

/** 云操作错误：message 面向用户，不含地址与凭证 */
export class CloudError extends Error {
  readonly kind: CloudErrorKind;
  constructor(kind: CloudErrorKind, message: string) {
    super(message);
    this.name = 'CloudError';
    this.kind = kind;
  }
}

/** 单次云请求超时（毫秒） */
export const CLOUD_TIMEOUT_MS = 30000;

/**
 * 带 30s 超时执行一次云请求，并把底层异常归一为 CloudError：
 * AbortError → 超时；TypeError（fetch 网络层失败）→ 网络错误。
 * 注意：不把底层 err.message 透传给用户，避免泄露 URL / 凭证片段。
 */
export async function guardCloud<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), CLOUD_TIMEOUT_MS);
  try {
    return await fn(ctrl.signal);
  } catch (err) {
    if (err instanceof CloudError) throw err;
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new CloudError('timeout', '连接超时（30 秒），请检查网络或服务器地址');
    }
    if (err instanceof TypeError) {
      throw new CloudError('network', '网络请求失败：无法连通服务器（浏览器端可能受 CORS 限制）');
    }
    throw new CloudError('server', '云端操作失败，请稍后重试');
  } finally {
    window.clearTimeout(timer);
  }
}

/** 把非 2xx 响应归一为 CloudError（401/403 → 认证；其余 → 服务端） */
export function ensureOk(res: Response, action: string): void {
  if (res.ok) return;
  if (res.status === 401 || res.status === 403) {
    throw new CloudError('auth', '认证失败：用户名 / 密钥不正确或没有权限');
  }
  if (res.status === 404) {
    throw new CloudError('server', `${action}失败：目标不存在（404），请检查路径 / Bucket 配置`);
  }
  throw new CloudError('server', `${action}失败：服务器返回 ${res.status}`);
}

/* ── 工厂 ── */

/**
 * 按 settings 当前配置构建云备份通道；未启用或必填项缺失返回 undefined。
 * 动态 import 具体实现，避免未用到 S3 时把 aws4fetch 计入主包。
 */
export async function buildCurrentProvider(): Promise<BackupProvider | undefined> {
  const kind = await getSetting('cloud.provider');
  if (kind === 'webdav') {
    const cfg = await getSetting('cloud.webdav');
    if (!cfg.server || !cfg.username) return undefined;
    const { createWebdavProvider } = await import('./providers/webdav');
    return createWebdavProvider(cfg);
  }
  if (kind === 's3') {
    const cfg = await getSetting('cloud.s3');
    if (!cfg.bucket || !cfg.accessKey || !cfg.secretKey) return undefined;
    const { createS3Provider } = await import('./providers/s3');
    return createS3Provider(cfg);
  }
  return undefined;
}
