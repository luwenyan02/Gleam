import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { TABLE_NAMES, type TableDump } from '../src/core/repo/backupRepo';
import { parseSkbak } from '../src/features/backup/skbak';

function emptyDump(): TableDump {
  return Object.fromEntries(TABLE_NAMES.map((name) => [name, []])) as TableDump;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

interface ArchiveOptions {
  data?: Record<string, unknown>;
  attachmentBytes?: ReadonlyMap<number, Uint8Array>;
  mutateManifest?: (manifest: Record<string, unknown>) => void;
}

async function archive({
  data = emptyDump(),
  attachmentBytes = new Map(),
  mutateManifest,
}: ArchiveOptions = {}): Promise<ArrayBuffer> {
  const dataJson = JSON.stringify(data);
  const counts = Object.fromEntries(TABLE_NAMES.map((name) => [
    name,
    Array.isArray(data[name]) ? data[name].length : 0,
  ]));
  const manifest: Record<string, unknown> = {
    app: '拾光',
    appVersion: '1.4.1',
    schemaVersion: 2,
    generatedAt: 1,
    counts,
    checksum: await sha256Hex(dataJson),
  };
  mutateManifest?.(manifest);

  const zip = new JSZip();
  zip.file('manifest.json', JSON.stringify(manifest));
  zip.file('data.json', dataJson);
  for (const [id, bytes] of attachmentBytes) zip.file(`attachments/${id}`, bytes);
  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

describe('SKBAK v1 解析完整性', () => {
  it('接受包含全部表和真实附件字节的合法 v2 包', async () => {
    const data = emptyDump();
    data.accounts = [{ id: 1, name: '虚构现金' }];
    data.attachments = [{
      id: 7,
      mime: 'image/png',
      name: '虚构照片.png',
      size: 4,
      blob: null,
      createdAt: 1,
      updatedAt: 1,
    }];

    const parsed = await parseSkbak(await archive({
      data,
      attachmentBytes: new Map([[7, new Uint8Array([1, 2, 3, 4])]]),
    }));

    expect(TABLE_NAMES).toHaveLength(20);
    expect(TABLE_NAMES.every((name) => Array.isArray(parsed.dump[name]))).toBe(true);
    expect(parsed.manifest.counts.accounts).toBe(1);
    expect([...new Uint8Array(await (parsed.dump.attachments[0] as { blob: Blob }).blob.arrayBuffer())])
      .toEqual([1, 2, 3, 4]);
  });

  it('拒绝缺少基本必需字段或字段类型错误的 manifest', async () => {
    const missingCounts = await archive({ mutateManifest: (manifest) => { delete manifest.counts; } });
    const stringSchema = await archive({ mutateManifest: (manifest) => { manifest.schemaVersion = '1'; } });

    await expect(parseSkbak(missingCounts)).rejects.toThrow(/manifest.*结构/i);
    await expect(parseSkbak(stringSchema)).rejects.toThrow(/manifest.*结构/i);
  });

  it('拒绝比当前应用更新的 schemaVersion', async () => {
    const source = await archive({ mutateManifest: (manifest) => { manifest.schemaVersion = 3; } });
    await expect(parseSkbak(source)).rejects.toThrow('请先升级应用');
  });

  it('兼容 v1 旧备份，为信用账单新表补空集合且不认领历史转账', async () => {
    const legacy = emptyDump() as Record<string, unknown>;
    delete legacy.creditStatements;
    delete legacy.creditPayments;
    legacy.entries = [{ id: 1, type: 'transfer', amount: 3000, fromAccountId: 1, toAccountId: 2 }];
    const source = await archive({
      data: legacy,
      mutateManifest: manifest => {
        manifest.schemaVersion = 1;
        const counts = manifest.counts as Record<string, number>;
        delete counts.creditStatements;
        delete counts.creditPayments;
      },
    });
    const parsed = await parseSkbak(source);
    expect(parsed.dump.creditStatements).toEqual([]);
    expect(parsed.dump.creditPayments).toEqual([]);
  });

  it('拒绝当前格式不支持的更旧 schemaVersion', async () => {
    const source = await archive({ mutateManifest: (manifest) => { manifest.schemaVersion = 0; } });
    await expect(parseSkbak(source)).rejects.toThrow(/不支持.*数据版本/);
  });

  it('拒绝缺表或必需表不是数组的 data.json', async () => {
    const missing = emptyDump() as Record<string, unknown>;
    delete missing.settings;
    const notArray = { ...emptyDump(), accounts: {} };

    await expect(parseSkbak(await archive({ data: missing }))).rejects.toThrow(/数据表.*settings.*数组/);
    await expect(parseSkbak(await archive({ data: notArray }))).rejects.toThrow(/数据表.*accounts.*数组/);
  });

  it('拒绝 manifest counts 与实际数组条数不一致', async () => {
    const data = emptyDump();
    data.accounts = [{ id: 1, name: '虚构现金' }];
    const source = await archive({
      data,
      mutateManifest: (manifest) => {
        (manifest.counts as Record<string, number>).accounts = 99;
      },
    });

    await expect(parseSkbak(source)).rejects.toThrow(/计数.*accounts/);
  });

  it('拒绝附件行对应的 zip 文件缺失', async () => {
    const data = emptyDump();
    data.attachments = [{ id: 7, mime: 'image/png', size: 4, blob: null }];
    await expect(parseSkbak(await archive({ data }))).rejects.toThrow(/附件.*7.*缺失/);
  });

  it('拒绝附件 zip 字节数与行内 size 声明不一致', async () => {
    const data = emptyDump();
    data.attachments = [{ id: 7, mime: 'image/png', size: 5, blob: null }];
    const source = await archive({
      data,
      attachmentBytes: new Map([[7, new Uint8Array([1, 2, 3, 4])]]),
    });

    await expect(parseSkbak(source)).rejects.toThrow(/附件.*7.*大小/);
  });
});
