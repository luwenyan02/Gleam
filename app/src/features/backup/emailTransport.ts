import { Capacitor, registerPlugin } from '@capacitor/core';

export interface EmailConfig { username: string; recipient: string }
export const EMAIL_MAX_BYTES = 10 * 1024 * 1024;
interface NativeMail {
  test(options: EmailConfig & { authCode: string }): Promise<void>;
  send(options: EmailConfig & { authCode: string; contentBase64: string; fileName: string; requestId: string }): Promise<{ status: string }>;
}
const mail = registerPlugin<NativeMail>('GleamMail');
const address = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
export function validateEmailConfig(config: EmailConfig, authCode: string): EmailConfig {
  const username = (config.username ?? '').trim();
  const recipient = config.recipient.trim();
  if (username.length > 254 || !address.test(username) || !/@(qq|foxmail)\.com$/i.test(username)) throw new Error('请填写 QQ 或 Foxmail 发件邮箱');
  if (recipient.length > 254 || !address.test(recipient)) throw new Error('请填写一个有效的收件邮箱');
  if (!/^[A-Za-z]{16}$/.test(authCode.trim())) throw new Error('请填写 QQ 邮箱生成的 16 位 SMTP 授权码，不是登录密码');
  return { username, recipient };
}
function requireAndroid(): void {
  if (Capacitor.getPlatform() !== 'android') throw new Error('邮箱备份仅支持 Android');
}
function safeError(error: unknown): Error {
  const code = (error as { code?: string })?.code;
  const messages: Record<string, string> = {
    AUTH: 'QQ 邮箱验证失败，请检查发件邮箱、授权码和 SMTP 开关',
    INVALID: '邮箱配置或备份格式无效，请检查后重试',
    BUSY: '正在处理邮箱请求，请稍候',
    UNCERTAIN: '发送结果未确认，请先检查收件箱；确认未收到后再重新生成发送',
    NETWORK: '无法连接 QQ 邮箱，请检查网络和 SMTP 设置',
  };
  return new Error(messages[code ?? ''] ?? '邮箱请求失败，请检查 QQ 邮箱设置；发送操作请先检查收件箱');
}
export async function testEmailService(config: EmailConfig, authCode: string): Promise<void> {
  requireAndroid();
  const cfg = validateEmailConfig(config, authCode);
  try { await mail.test({ ...cfg, authCode: authCode.trim() }); }
  catch (error) { throw safeError(error); }
}
export async function sendEmailBackup(config: EmailConfig, authCode: string, blob: Blob, fileName: string, requestId: string): Promise<void> {
  requireAndroid();
  const cfg = validateEmailConfig(config, authCode);
  if (blob.size > EMAIL_MAX_BYTES) throw new Error('邮箱备份最大支持 10 MB，请改用 WebDAV、S3 或本地备份');
  if (blob.size < 52 || await blob.slice(0, 8).text() !== 'SKBAK1E:') throw new Error('邮箱备份必须使用口令加密');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += 0x8000) parts.push(String.fromCharCode(...bytes.subarray(i, i + 0x8000)));
  try {
    const result = await mail.send({ ...cfg, authCode: authCode.trim(), fileName, requestId, contentBase64: btoa(parts.join('')) });
    if (result.status !== 'accepted') throw { code: 'UNCERTAIN' };
  } catch (error) { throw safeError(error); }
}
