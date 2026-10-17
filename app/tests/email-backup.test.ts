import { afterEach, describe, expect, it, vi } from 'vitest';
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { validateEmailConfig, testEmailService, sendEmailBackup, EMAIL_MAX_BYTES } from '../src/features/backup/emailTransport';
import { sanitizeDumpForBackup, TABLE_NAMES, type TableDump } from '../src/core/repo/backupRepo';

vi.mock('@capacitor/core', async importOriginal => {
  const actual = await importOriginal<typeof import('@capacitor/core')>();
  return { ...actual, CapacitorHttp: { request: vi.fn() } };
});

const cfg = { endpoint: 'https://mail.example.test', recipient: 'fictional@example.test' };
const token = 'fictional-test-token';
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('邮箱备份发送协议', () => {
  it('只接受不带凭据、查询或片段的 HTTPS 服务地址和单一收件人', () => {
    expect(validateEmailConfig({ ...cfg, endpoint: `${cfg.endpoint}/relay/` }, token).endpoint).toBe(`${cfg.endpoint}/relay`);
    for (const endpoint of ['http://mail.example.test', 'https://u:p@mail.example.test', `${cfg.endpoint}?token=x`, `${cfg.endpoint}#x`]) {
      expect(() => validateEmailConfig({ ...cfg, endpoint }, token)).toThrow();
    }
    for (const recipient of ['a@example.test,b@example.test', 'a@example.test\r\nBcc:x@example.test', 'bad']) {
      expect(() => validateEmailConfig({ ...cfg, recipient }, token)).toThrow();
    }
    expect(() => validateEmailConfig(cfg, '')).toThrow();
  });

  it('测试连接不携带备份，发送只携带加密文件且禁止重定向', async () => {
    const fetcher = vi.fn(async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      return new Response(JSON.stringify(body.requestId
        ? { status: 'accepted', requestId: body.requestId }
        : { status: 'ready', recipient: cfg.recipient }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetcher);
    await testEmailService(cfg, token);
    const bytes = new TextEncoder().encode('SKBAK1E:' + 'x'.repeat(64));
    await sendEmailBackup(cfg, token, new Blob([bytes]), '拾光备份_20261017_1200.skbak', 'test-request-123');
    const [, init] = fetcher.mock.calls[1];
    expect(init.redirect).toBe('error');
    expect(init.credentials).toBe('omit');
    const data = JSON.parse(init.body as string);
    expect(atob(data.contentBase64)).toBe(new TextDecoder().decode(bytes));
    expect(data).not.toHaveProperty('password');
    expect(JSON.parse(fetcher.mock.calls[0][1].body as string)).toEqual({ recipient: cfg.recipient });
  });

  it('拒绝明文和超限文件，不发起网络请求', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await expect(sendEmailBackup(cfg, token, new Blob(['plain']), 'test.skbak', 'id')).rejects.toThrow('加密');
    await expect(sendEmailBackup(cfg, token, new Blob([new Uint8Array(EMAIL_MAX_BYTES + 1)]), 'test.skbak', 'id')).rejects.toThrow('10 MB');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('服务报错不回显服务端正文，未知发送结果提示先查邮箱', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('private credential', { status: 401 })));
    await expect(testEmailService(cfg, token)).rejects.toThrow('访问令牌');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('private url'); }));
    await expect(sendEmailBackup(cfg, token, new Blob(['SKBAK1E:' + 'x'.repeat(64)]), 'test.skbak', 'id')).rejects.toThrow('先检查收件箱');
  });

  it('Android 使用原生 JSON 通道、超时和禁止重定向，不依赖 Blob 桥转换', async () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    const native = vi.spyOn(CapacitorHttp, 'request').mockImplementation(async options => ({
      status: 200, headers: {}, url: options.url,
      data: { status: 'accepted', requestId: JSON.parse(options.data as string).requestId },
    }));
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await sendEmailBackup(cfg, token, new Blob(['SKBAK1E:' + 'x'.repeat(64)]), 'test.skbak', 'native-request-1');
    expect(native).toHaveBeenCalledWith(expect.objectContaining({
      method: 'POST', responseType: 'json', disableRedirects: true, connectTimeout: 15000, readTimeout: 65000,
    }));
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('拒绝不匹配的服务响应与原生重定向，不误报发送成功', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 'ready', recipient: 'other@example.test' }))));
    await expect(testEmailService(cfg, token)).rejects.toThrow('不匹配');
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    vi.spyOn(CapacitorHttp, 'request').mockResolvedValue({ status: 302, headers: {}, url: cfg.endpoint, data: {} });
    await expect(testEmailService(cfg, token)).rejects.toThrow('请求失败');
  });

  it('不把旧备份夹带的邮箱令牌、密码或 URL 凭据继续导出', () => {
    const dump = Object.fromEntries(TABLE_NAMES.map(n => [n, []])) as TableDump;
    dump.settings = [
      { key: 'cloud.email.token', value: 'private' },
      { key: 'cloud.email', value: { ...cfg, token: 'private', password: 'private' } },
    ];
    const clean = sanitizeDumpForBackup(dump);
    expect(JSON.stringify(clean)).not.toContain('private');
    expect((clean.settings[1] as { value: unknown }).value).toEqual(cfg);
  });
});
