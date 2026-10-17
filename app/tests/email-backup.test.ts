import { afterEach, describe, expect, it, vi } from 'vitest';
import { Capacitor } from '@capacitor/core';
const native = vi.hoisted(() => ({ test: vi.fn(), send: vi.fn() }));
vi.mock('@capacitor/core', async importOriginal => {
  const original = await importOriginal<typeof import('@capacitor/core')>();
  return { ...original, registerPlugin: (name: string) => name === 'GleamMail' ? native : original.registerPlugin(name) };
});
import { sendEmailBackup, testEmailService, validateEmailConfig, EMAIL_MAX_BYTES } from '../src/features/backup/emailTransport';
import { sanitizeDumpForBackup, TABLE_NAMES, type TableDump } from '../src/core/repo/backupRepo';
const cfg = { username: 'fictional@qq.com', recipient: 'fictional@example.test' };
const auth = 'abcdefghijklmnop';
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });
describe('Android QQ SMTP 备份', () => {
  it('网页版不调用原生插件或发送服务', async () => {
    await expect(testEmailService(cfg, auth)).rejects.toThrow('仅支持 Android');
    await expect(sendEmailBackup(cfg, auth, new Blob(), 'a.skbak', 'id')).rejects.toThrow('仅支持 Android');
    expect(native.test).not.toHaveBeenCalled(); expect(native.send).not.toHaveBeenCalled();
  });
  it('校验 QQ 发件地址、单一收件人和授权码，拒绝注入', () => {
    expect(validateEmailConfig(cfg, auth)).toEqual(cfg);
    for (const username of ['not-email', 'a@example.test', 'a@qq.com\r\nBcc:b@qq.com']) expect(() => validateEmailConfig({ ...cfg, username }, auth)).toThrow();
    expect(() => validateEmailConfig({ ...cfg, recipient: 'a@qq.com,b@qq.com' }, auth)).toThrow();
    expect(() => validateEmailConfig(cfg, 'login-password')).toThrow('16 位');
  });
  it('测试连接不携带附件，发送只传加密字节、不传备份口令', async () => {
    vi.spyOn(Capacitor, 'getPlatform').mockReturnValue('android');
    native.test.mockResolvedValue(undefined); native.send.mockResolvedValue({ status: 'accepted' });
    await testEmailService(cfg, auth);
    const text = 'SKBAK1E:' + 'x'.repeat(64);
    await sendEmailBackup(cfg, auth, new Blob([text]), 'test.skbak', 'request-123');
    expect(native.test).toHaveBeenCalledWith({ ...cfg, authCode: auth });
    const sent = native.send.mock.calls[0][0];
    expect(atob(sent.contentBase64)).toBe(text);
    expect(sent).not.toHaveProperty('password');
    expect(sent.requestId).toBe('request-123');
  });
  it('拒绝明文及超限附件', async () => {
    vi.spyOn(Capacitor, 'getPlatform').mockReturnValue('android');
    await expect(sendEmailBackup(cfg, auth, new Blob(['plain']), 'a.skbak', 'id')).rejects.toThrow('加密');
    await expect(sendEmailBackup(cfg, auth, new Blob([new Uint8Array(EMAIL_MAX_BYTES + 1)]), 'a.skbak', 'id')).rejects.toThrow('10 MB');
    expect(native.send).not.toHaveBeenCalled();
  });
  it('原生错误只展示固定文案，不泄露授权码或服务器回应', async () => {
    vi.spyOn(Capacitor, 'getPlatform').mockReturnValue('android');
    native.test.mockRejectedValue({ code: 'AUTH', message: auth });
    await expect(testEmailService(cfg, auth)).rejects.toThrow('验证失败');
    native.send.mockRejectedValue({ code: 'UNCERTAIN', message: auth });
    await expect(sendEmailBackup(cfg, auth, new Blob(['SKBAK1E:' + 'x'.repeat(64)]), 'a.skbak', 'id')).rejects.toThrow('先检查收件箱');
  });
  it('备份剔除 SMTP 授权码和旧服务配置', () => {
    const dump = Object.fromEntries(TABLE_NAMES.map(n => [n, []])) as TableDump;
    dump.settings = [{ key: 'cloud.email.authCode', value: auth }, { key: 'cloud.email.token', value: 'old-private' }, { key: 'cloud.email', value: { ...cfg, authCode: auth, endpoint: 'https://old-private.test' } }];
    const clean = sanitizeDumpForBackup(dump);
    expect(JSON.stringify(clean)).not.toContain(auth);
    expect(JSON.stringify(clean)).not.toContain('old-private');
    expect((clean.settings[2] as { value: unknown }).value).toEqual(cfg);
  });
});
