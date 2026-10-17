import { Capacitor, CapacitorHttp } from '@capacitor/core';

export interface EmailConfig { endpoint: string; recipient: string }
export const EMAIL_MAX_BYTES = 10 * 1024 * 1024;
const TIMEOUT_MS = 65000;

export function validateEmailConfig(config: EmailConfig, token: string): EmailConfig {
  let url: URL;
  try { url = new URL(config.endpoint.trim()); }
  catch { throw new Error('请填写有效的 HTTPS 邮件服务地址'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('邮件服务地址须使用 HTTPS，且不能包含用户名、密码、查询参数或片段');
  }
  const recipient = config.recipient.trim();
  if (recipient.length > 254 || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(recipient)) {
    throw new Error('请填写一个有效的收件邮箱');
  }
  if (!token.trim() || /[\r\n]/.test(token)) throw new Error('请填写邮件服务访问令牌');
  return { endpoint: url.href.replace(/\/+$/, ''), recipient };
}

function statusError(status: number): Error {
  const messages: Record<number, string> = {
    401: '邮件服务访问令牌无效，请重新填写',
    403: '收件邮箱或当前网页来源未获邮件服务允许',
    409: '该次发送结果尚未确认，请先检查收件箱，勿连续重试',
    413: '邮箱备份最大支持 10 MB，请改用 WebDAV、S3 或本地备份',
    429: '邮件服务正在处理请求或发送过于频繁，请稍后再试',
    502: '邮件服务未能完成发送，请先检查收件箱，再核对 QQ 邮箱配置',
  };
  return new Error(messages[status] ?? '邮件服务请求失败，请检查服务配置；发送操作请先检查收件箱再重试');
}

async function request(config: EmailConfig, token: string, path: string, body: unknown): Promise<Record<string, unknown>> {
  const cfg = validateEmailConfig(config, token);
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token.trim()}` };
  let status: number, data: unknown;
  try {
    if (Capacitor.isNativePlatform()) {
      // 明确使用 JSON，避免原生桥的 Blob 序列化差异；不向重定向目标转发令牌。
      const response = await CapacitorHttp.request({
        url: `${cfg.endpoint}${path}`, method: 'POST', headers, data: JSON.stringify(body),
        responseType: 'json', disableRedirects: true, connectTimeout: 15000, readTimeout: TIMEOUT_MS,
      });
      status = response.status; data = response.data;
    } else {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const response = await fetch(`${cfg.endpoint}${path}`, {
          method: 'POST', headers, body: JSON.stringify(body), redirect: 'error',
          credentials: 'omit', cache: 'no-store', signal: controller.signal,
        });
        status = response.status;
        data = response.ok ? await response.json() : null;
      } finally { clearTimeout(timer); }
    }
  } catch {
    throw new Error(path === '/v1/backup'
      ? '发送结果未确认，请先检查收件箱，再决定是否重试'
      : '邮件服务连接失败，请检查网络、HTTPS 地址与网页跨域配置');
  }
  if (status < 200 || status >= 300) throw statusError(status);
  if (!data || typeof data !== 'object') throw new Error('邮件服务响应无效，请检查服务版本');
  return data as Record<string, unknown>;
}

export async function testEmailService(config: EmailConfig, token: string): Promise<void> {
  const cfg = validateEmailConfig(config, token);
  const data = await request(cfg, token, '/v1/test', { recipient: cfg.recipient });
  if (data.status !== 'ready' || data.recipient !== cfg.recipient) throw new Error('邮件服务响应与收件邮箱不匹配');
}

export async function sendEmailBackup(config: EmailConfig, token: string, blob: Blob, fileName: string, requestId: string): Promise<void> {
  const cfg = validateEmailConfig(config, token);
  if (blob.size > EMAIL_MAX_BYTES) throw statusError(413);
  if (blob.size < 52 || await blob.slice(0, 8).text() !== 'SKBAK1E:') throw new Error('邮箱备份必须使用口令加密');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += 0x8000) chunks.push(String.fromCharCode(...bytes.subarray(i, i + 0x8000)));
  const data = await request(cfg, token, '/v1/backup', {
    recipient: cfg.recipient, requestId, fileName, contentBase64: btoa(chunks.join('')),
  });
  if (data.status !== 'accepted' || data.requestId !== requestId) {
    throw new Error('发送结果未确认，请先检查收件箱，再决定是否重试');
  }
}
