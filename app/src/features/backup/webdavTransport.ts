import { Capacitor, registerPlugin } from '@capacitor/core';
import { CloudError } from './provider';

/** Android WebDAV 通道的原始数据上限；base64 还会在桥上额外膨胀约 1/3。 */
export const NATIVE_WEBDAV_MAX_BYTES = 50 * 1024 * 1024;

export type WebdavRequestInit = Omit<RequestInit, 'body'> & { body?: BodyInit | null };
export type WebdavRequest = (url: string, init: WebdavRequestInit) => Promise<Response>;

interface NativeWebdavResponse {
  status: number;
  bodyBase64: string;
  contentType?: string;
}

interface NativeWebdavPlugin {
  request(options: {
    id: string;
    url: string;
    method: string;
    authorization: string;
    depth?: string;
    contentType?: string;
    bodyBase64?: string;
  }): Promise<NativeWebdavResponse>;
  cancel(options: { id: string }): Promise<void>;
}

const NativeWebdav = registerPlugin<NativeWebdavPlugin>('GleamWebDav');

function requestId(): string {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function bodyAsBlob(body: BodyInit | null | undefined): Promise<Blob | undefined> {
  if (body === undefined || body === null) return undefined;
  if (body instanceof Blob) return body;
  if (typeof body === 'string') return new Blob([body]);
  if (body instanceof ArrayBuffer) return new Blob([body]);
  if (ArrayBuffer.isView(body)) return new Blob([
    body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
  ]);
  throw new CloudError('server', 'Android WebDAV 不支持该请求数据格式');
}

async function blobAsBase64(blob: Blob | undefined): Promise<string | undefined> {
  if (!blob) return undefined;
  if (blob.size > NATIVE_WEBDAV_MAX_BYTES) {
    throw new CloudError('server', 'Android WebDAV 单个文件最大支持 50 MB，请先减少照片附件');
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new CloudError('server', '备份数据读取失败'));
    reader.onload = () => {
      const value = String(reader.result ?? '');
      resolve(value.includes(',') ? value.slice(value.indexOf(',') + 1) : value);
    };
    reader.readAsDataURL(blob);
  });
}

function bytesFromBase64(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer as ArrayBuffer;
}

function nativeError(error: unknown): CloudError | DOMException {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : '';
  if (code === 'ABORTED') return new DOMException('请求已取消', 'AbortError');
  if (code === 'TIMEOUT') return new CloudError('timeout', '连接超时（30 秒），请检查网络或服务器地址');
  if (code === 'NETWORK' || code === 'TLS') {
    return new CloudError('network', code === 'TLS'
      ? 'TLS 安全连接失败，请检查服务器证书'
      : '网络请求失败：无法连通服务器');
  }
  if (code === 'BODY_TOO_LARGE') {
    return new CloudError('server', 'Android WebDAV 单个文件最大支持 50 MB，请先减少照片附件');
  }
  if (code === 'INVALID_REQUEST') {
    return new CloudError('server', 'WebDAV 请求配置无效：Android 端仅允许 HTTPS 服务器');
  }
  return new CloudError('server', 'Android WebDAV 请求失败');
}

async function nativeRequest(url: string, init: WebdavRequestInit): Promise<Response> {
  const headers = new Headers(init.headers);
  const authorization = headers.get('Authorization') ?? '';
  const bodyBase64 = await blobAsBase64(await bodyAsBlob(init.body));
  const id = requestId();
  const signal = init.signal ?? undefined;
  if (signal?.aborted) throw new DOMException('请求已取消', 'AbortError');

  let abort: (() => void) | undefined;
  const aborted = signal ? new Promise<never>((_, reject) => {
    abort = () => {
      void NativeWebdav.cancel({ id }).catch(() => undefined);
      reject(new DOMException('请求已取消', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
  }) : undefined;

  try {
    const pending = NativeWebdav.request({
      id,
      url,
      method: init.method ?? 'GET',
      authorization,
      depth: headers.get('Depth') ?? undefined,
      contentType: headers.get('Content-Type') ?? undefined,
      bodyBase64,
    });
    const native = await (aborted ? Promise.race([pending, aborted]) : pending);
    if (!Number.isInteger(native.status) || native.status < 100 || native.status > 599) {
      throw new CloudError('server', 'Android WebDAV 返回了无效状态');
    }
    const bytes = native.bodyBase64 ? bytesFromBase64(native.bodyBase64) : undefined;
    const noBody = [101, 103, 204, 205, 304].includes(native.status);
    return new Response(noBody ? null : bytes, {
      status: native.status,
      headers: native.contentType ? { 'Content-Type': native.contentType } : undefined,
    });
  } catch (error) {
    if (error instanceof CloudError || error instanceof DOMException) throw error;
    throw nativeError(error);
  } finally {
    if (signal && abort) signal.removeEventListener('abort', abort);
  }
}

function isJianguoyun(url: string): boolean {
  try { return new URL(url).hostname.toLowerCase() === 'dav.jianguoyun.com'; }
  catch { return false; }
}

/** Web 保留标准 fetch；Android 绕开 CapacitorHttp 不支持 WebDAV 方法的限制。 */
export const webdavRequest: WebdavRequest = async (url, init) => {
  if (Capacitor.getPlatform() === 'android') return nativeRequest(url, init);
  if (isJianguoyun(url)) {
    throw new CloudError('network', '坚果云不允许浏览器跨域直连，请在 Android 端使用');
  }
  return fetch(url, { ...init, redirect: 'error' });
};
