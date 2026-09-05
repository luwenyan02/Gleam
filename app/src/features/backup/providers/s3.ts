/**
 * 拾光 · S3 兼容云备份通道（features/backup/providers/s3）[R06]
 * aws4fetch AwsClient 做 SigV4 签名；PutObject / GetObject / DeleteObject / ListObjectsV2。
 * 支持自定义 endpoint（Cloudflare R2 / MinIO / 阿里 OSS 等），统一走 path-style
 * （endpoint/bucket/key），对自建与兼容服务最稳。红线：错误消息不含 endpoint 与密钥。
 */
import { AwsClient } from 'aws4fetch';
import { CloudError, ensureOk, guardCloud, type BackupProvider, type CloudFile } from '../provider';

/** S3 配置（settings 'cloud.s3'） */
export interface S3Config {
  /** 自定义服务地址（留空按 AWS 规则 https://s3.{region}.amazonaws.com） */
  endpoint: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  /** 对象 key 前缀（相当于目录，如 gleam-backup/） */
  prefix: string;
}

/** 对象 key 编码：逐段 encodeURIComponent，保留 '/' 层级 */
function encodeKey(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}

/** 归一化前缀：去首斜杠，非空则保证尾斜杠 */
function normPrefix(prefix: string): string {
  const p = prefix.trim().replace(/^\/+/, '');
  if (!p) return '';
  return p.endsWith('/') ? p : `${p}/`;
}

/** 创建 S3 兼容通道 */
export function createS3Provider(cfg: S3Config): BackupProvider {
  const region = cfg.region.trim() || 'us-east-1';
  const endpoint = (cfg.endpoint.trim() || `https://s3.${region}.amazonaws.com`).replace(/\/+$/, '');
  const prefix = normPrefix(cfg.prefix);
  const client = new AwsClient({
    accessKeyId: cfg.accessKey,
    secretAccessKey: cfg.secretKey,
    region,
    service: 's3',
    retries: 0, // 重试交给用户手动触发，避免大包上传隐式重发
  });
  /** path-style 对象 URL：endpoint/bucket/prefix+name */
  const objectUrl = (name: string) => `${endpoint}/${encodeURIComponent(cfg.bucket)}/${encodeKey(prefix + name)}`;

  /** ListObjectsV2 并解析 XML（按 localName 宽松取节点，兼容各家实现） */
  async function listObjects(signal: AbortSignal, maxKeys: number): Promise<CloudFile[]> {
    const url = `${endpoint}/${encodeURIComponent(cfg.bucket)}/?list-type=2&max-keys=${maxKeys}` +
      (prefix ? `&prefix=${encodeURIComponent(prefix)}` : '');
    const res = await client.fetch(url, { method: 'GET', signal });
    ensureOk(res, '读取云端列表');
    const doc = new DOMParser().parseFromString(await res.text(), 'application/xml');
    if (doc.querySelector('parsererror')) {
      throw new CloudError('server', '云端列表解析失败：服务器返回了无法识别的内容');
    }
    const files: CloudFile[] = [];
    for (const item of [...doc.getElementsByTagName('*')].filter((n) => n.localName === 'Contents')) {
      const field = (local: string) =>
        [...item.getElementsByTagName('*')].find((n) => n.localName === local)?.textContent ?? '';
      const key = field('Key');
      if (!key.startsWith(prefix)) continue;
      const name = key.slice(prefix.length);
      // 只收本目录直属的 .skbak 文件，跳过更深层级
      if (!name || name.includes('/') || !name.toLowerCase().endsWith('.skbak')) continue;
      files.push({
        name,
        size: Number(field('Size')) || 0,
        lastModified: Date.parse(field('LastModified')) || 0,
      });
    }
    return files.sort((a, b) => b.lastModified - a.lastModified);
  }

  return {
    kind: 's3',

    async test() {
      await guardCloud((signal) => listObjects(signal, 1));
    },

    async upload(name, blob) {
      await guardCloud(async (signal) => {
        // aws4fetch 需可哈希的 body：Blob 先转 ArrayBuffer 参与 SigV4 payload 签名
        const body = await blob.arrayBuffer();
        const res = await client.fetch(objectUrl(name), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/octet-stream' },
          body,
          signal,
        });
        ensureOk(res, '上传');
      });
    },

    async list() {
      return guardCloud((signal) => listObjects(signal, 100));
    },

    async download(name) {
      return guardCloud(async (signal) => {
        const res = await client.fetch(objectUrl(name), { method: 'GET', signal });
        ensureOk(res, '下载');
        return res.blob();
      });
    },

    async delete(name) {
      await guardCloud(async (signal) => {
        const res = await client.fetch(objectUrl(name), { method: 'DELETE', signal });
        // 404 视为已删除，幂等
        if (res.status !== 404) ensureOk(res, '删除');
      });
    },
  };
}
