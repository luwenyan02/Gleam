import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DOMParser } from '@xmldom/xmldom';
import { Capacitor } from '@capacitor/core';
import {
  createWebdavProvider,
  type WebdavRequest,
  type WebdavRequestInit,
} from '../src/features/backup/providers/webdav';
import { webdavRequest } from '../src/features/backup/webdavTransport';

const CONFIG = {
  server: 'https://example.invalid/dav/',
  username: 'demo@example.invalid',
  password: 'fiction-password',
  path: 'apps/拾光备份',
};

interface RequestCall {
  url: string;
  method: string;
  depth: string | null;
  body: BodyInit | null | undefined;
}

function fakeRequest(
  respond: (call: RequestCall) => Response,
): { request: WebdavRequest; calls: RequestCall[] } {
  const calls: RequestCall[] = [];
  const request: WebdavRequest = async (url: string, init: WebdavRequestInit) => {
    const headers = new Headers(init.headers);
    const call = {
      url,
      method: init.method ?? 'GET',
      depth: headers.get('Depth'),
      body: init.body,
    };
    calls.push(call);
    return respond(call);
  };
  vi.stubGlobal('fetch', request);
  return { request, calls };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
beforeEach(() => vi.stubGlobal('window', globalThis));

describe('WebDAV provider', () => {
  it('浏览器输入坚果云地址时直接说明 CORS 限制，不发无效预检', async () => {
    const fetchSpy = vi.fn(async () => new Response('', { status: 207 }));
    vi.stubGlobal('fetch', fetchSpy);
    vi.spyOn(Capacitor, 'getPlatform').mockReturnValue('web');

    await expect(webdavRequest('https://dav.jianguoyun.com/dav/', {
      method: 'PROPFIND',
    })).rejects.toMatchObject({
      kind: 'network',
      message: '坚果云不允许浏览器跨域直连，请在 Android 端使用',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('非 Android 平台保持标准 fetch，不误调 Android 原生插件', async () => {
    const fetchSpy = vi.fn(async () => new Response('', { status: 207 }));
    vi.stubGlobal('fetch', fetchSpy);
    vi.spyOn(Capacitor, 'getPlatform').mockReturnValue('ios');

    const response = await webdavRequest('https://webdav.example.invalid/dav/', {
      method: 'PROPFIND',
    });

    expect(response.status).toBe(207);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('测试连接只读：目标目录不存在时回查服务器根目录，不发 MKCOL', async () => {
    const { request, calls } = fakeRequest(({ url }) => new Response('', {
      status: url.endsWith('/dav/') ? 207 : 404,
    }));

    const result = await createWebdavProvider(CONFIG, request).test();

    expect(result).toEqual({ directoryReady: false });
    expect(calls.map(({ method, depth }) => [method, depth])).toEqual([
      ['PROPFIND', '0'],
      ['PROPFIND', '0'],
    ]);
    expect(calls.map(({ url }) => url)).toEqual([
      'https://example.invalid/dav/apps/%E6%8B%BE%E5%85%89%E5%A4%87%E4%BB%BD/',
      'https://example.invalid/dav/',
    ]);
  });

  it('测试连接在目标目录已存在时只发一次 Depth 0 PROPFIND', async () => {
    const { request, calls } = fakeRequest(() => new Response('', { status: 207 }));

    const result = await createWebdavProvider(CONFIG, request).test();

    expect(result).toEqual({ directoryReady: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'PROPFIND', depth: '0' });
  });

  it('只在上传时逐级创建目录，再原样 PUT 备份 Blob', async () => {
    const { request, calls } = fakeRequest(({ method }) => new Response('', {
      status: method === 'MKCOL' || method === 'PUT' ? 201 : 500,
    }));
    const blob = new Blob([new Uint8Array([0, 1, 2, 255])], {
      type: 'application/octet-stream',
    });

    await createWebdavProvider(CONFIG, request).upload('fiction.skbak', blob);

    expect(calls.map(({ method, url }) => [method, url])).toEqual([
      ['MKCOL', 'https://example.invalid/dav/apps/'],
      ['MKCOL', 'https://example.invalid/dav/apps/%E6%8B%BE%E5%85%89%E5%A4%87%E4%BB%BD/'],
      ['PUT', 'https://example.invalid/dav/apps/%E6%8B%BE%E5%85%89%E5%A4%87%E4%BB%BD/fiction.skbak'],
    ]);
    expect(calls[2].body).toBe(blob);
  });

  it('解析带命名空间的 multistatus，忽略目录与非 skbak 文件', async () => {
    vi.stubGlobal('DOMParser', DOMParser);
    const xml = `<?xml version="1.0" encoding="utf-8"?>
      <d:multistatus xmlns:d="DAV:">
        <d:response><d:href>/dav/apps/%E6%8B%BE%E5%85%89%E5%A4%87%E4%BB%BD/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>
        <d:response><d:href>/dav/apps/%E6%8B%BE%E5%85%89%E5%A4%87%E4%BB%BD/older.txt</d:href><d:propstat><d:prop><d:getcontentlength>2</d:getcontentlength></d:prop></d:propstat></d:response>
        <d:response><d:href>/dav/apps/%E6%8B%BE%E5%85%89%E5%A4%87%E4%BB%BD/fiction.skbak</d:href><d:propstat><d:prop><d:getcontentlength>4</d:getcontentlength><d:getlastmodified>Wed, 09 Sep 2026 00:00:00 GMT</d:getlastmodified><d:resourcetype/></d:prop></d:propstat></d:response>
      </d:multistatus>`;
    const { request } = fakeRequest(() => new Response(xml, {
      status: 207,
      headers: { 'Content-Type': 'application/xml; charset=utf-8' },
    }));

    const files = await createWebdavProvider(CONFIG, request).list();

    expect(files).toEqual([{
      name: 'fiction.skbak',
      size: 4,
      lastModified: Date.parse('Wed, 09 Sep 2026 00:00:00 GMT'),
    }]);
  });
});
