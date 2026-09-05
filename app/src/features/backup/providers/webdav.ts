/**
 * 拾光 · WebDAV 云备份通道（features/backup/providers/webdav）[R06]
 * Basic Auth；PUT / GET / DELETE + PROPFIND(depth=1) 列目录，MKCOL 逐级确保目录存在。
 * PROPFIND 响应用 DOMParser 按 localName 宽松解析，兼容坚果云 / 群晖 / Nextcloud
 * 等实现的命名空间前缀差异。红线：错误消息不含服务器地址与凭证。
 */
import { CloudError, ensureOk, guardCloud, type BackupProvider, type CloudFile } from '../provider';

/** WebDAV 配置（settings 'cloud.webdav'） */
export interface WebdavConfig {
  /** 服务器根地址，如 https://dav.jianguoyun.com/dav */
  server: string;
  username: string;
  password: string;
  /** 备份目录（相对 server，可多级，如 拾光备份 或 apps/gleam） */
  path: string;
}

/** Unicode 安全的 Basic Auth 头（用户名/密码可能含非 ASCII） */
function basicAuth(username: string, password: string): string {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return `Basic ${btoa(bin)}`;
}

/** 目录路径拆段（去空段），供逐级 MKCOL 与 URL 拼接 */
function pathSegments(path: string): string[] {
  return path.split('/').map((s) => s.trim()).filter(Boolean);
}

/** 创建 WebDAV 通道 */
export function createWebdavProvider(cfg: WebdavConfig): BackupProvider {
  const base = cfg.server.replace(/\/+$/, '');
  const segs = pathSegments(cfg.path);
  /** 备份目录 URL（尾带 /），各段单独编码 */
  const dirUrl = [base, ...segs.map(encodeURIComponent)].join('/') + '/';
  const headers = { Authorization: basicAuth(cfg.username, cfg.password) };
  const fileUrl = (name: string) => dirUrl + encodeURIComponent(name);

  /** 逐级 MKCOL 确保备份目录存在（405/301 = 已存在，忽略） */
  async function ensureDir(signal: AbortSignal): Promise<void> {
    let cur = base;
    for (const seg of segs) {
      cur += '/' + encodeURIComponent(seg);
      const res = await fetch(cur + '/', { method: 'MKCOL', headers, signal });
      // 201 创建成功；405 已存在；301/302 服务器重定向到既有目录——其余状态按错误归一
      if (res.ok || res.status === 405 || res.status === 301 || res.status === 302) continue;
      ensureOk(res, '创建备份目录');
    }
  }

  /** PROPFIND depth:1 列目录并宽松解析（按 localName 取节点，忽略命名空间前缀） */
  async function propfind(signal: AbortSignal): Promise<CloudFile[]> {
    const res = await fetch(dirUrl, {
      method: 'PROPFIND',
      headers: { ...headers, Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' },
      body: '<?xml version="1.0" encoding="utf-8"?>\n<propfind xmlns="DAV:"><prop><getcontentlength/><getlastmodified/><resourcetype/></prop></propfind>',
      signal,
    });
    ensureOk(res, '读取云端列表');
    const doc = new DOMParser().parseFromString(await res.text(), 'application/xml');
    if (doc.querySelector('parsererror')) {
      throw new CloudError('server', '云端列表解析失败：服务器返回了无法识别的内容');
    }
    const pick = (el: Element, local: string): Element | undefined =>
      [...el.getElementsByTagName('*')].find((n) => n.localName === local);
    const files: CloudFile[] = [];
    for (const resp of [...doc.getElementsByTagName('*')].filter((n) => n.localName === 'response')) {
      const href = pick(resp, 'href')?.textContent ?? '';
      // href 可能是完整 URL 或绝对路径，统一取最后一段并解码为文件名
      const last = href.replace(/\/+$/, '').split('/').pop() ?? '';
      let name: string;
      try { name = decodeURIComponent(last); } catch { name = last; }
      // 跳过目录自身与子目录（collection），只收 .skbak 文件
      if (!name || pick(resp, 'collection') || !name.toLowerCase().endsWith('.skbak')) continue;
      const size = Number(pick(resp, 'getcontentlength')?.textContent ?? 0) || 0;
      const mtime = Date.parse(pick(resp, 'getlastmodified')?.textContent ?? '') || 0;
      files.push({ name, size, lastModified: mtime });
    }
    return files.sort((a, b) => b.lastModified - a.lastModified);
  }

  return {
    kind: 'webdav',

    async test() {
      await guardCloud(async (signal) => {
        await ensureDir(signal);
        await propfind(signal);
      });
    },

    async upload(name, blob) {
      await guardCloud(async (signal) => {
        await ensureDir(signal);
        const res = await fetch(fileUrl(name), {
          method: 'PUT',
          headers: { ...headers, 'Content-Type': 'application/octet-stream' },
          body: blob,
          signal,
        });
        ensureOk(res, '上传');
      });
    },

    async list() {
      return guardCloud((signal) => propfind(signal));
    },

    async download(name) {
      return guardCloud(async (signal) => {
        const res = await fetch(fileUrl(name), { method: 'GET', headers, signal });
        ensureOk(res, '下载');
        return res.blob();
      });
    },

    async delete(name) {
      await guardCloud(async (signal) => {
        const res = await fetch(fileUrl(name), { method: 'DELETE', headers, signal });
        // 404 视为已删除，幂等
        if (res.status !== 404) ensureOk(res, '删除');
      });
    },
  };
}
