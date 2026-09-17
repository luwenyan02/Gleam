/**
 * 拾光 · .skbak 备份包格式（features/backup/skbak）
 * 包结构（明文）：zip（JSZip）内含
 *   - manifest.json：appVersion / schemaVersion / 各表条数 / 生成时间 / data.json 的 SHA-256；
 *   - data.json：全部表全量导出（attachments 行剥离 blob）；
 *   - attachments/{id}：照片 Blob 按附件 id 存文件。
 * 加密包（可选口令）：自定义头 MAGIC(8B ascii) + salt(16B) + iv(12B) + AES-256-GCM 密文（整 zip）。
 * 密钥派生：PBKDF2(SHA-256, 150000 迭代)。口令不存储、不可找回。
 * jszip 按需动态 import（类型保留 import type），Vite 自动拆为独立 chunk。
 */
import type JSZipType from 'jszip';
import { countDump, TABLE_NAMES, type TableDump } from '../../core/repo/backupRepo';
import type { Attachment, LifeDraft, LifeEdition } from '../../core/types';
import { validateLifeDraft } from '../../core/repo/lifeDraftRepo';
import { validateLifeEdition } from '../../core/repo/lifeEditionRepo';

/** 按需加载 JSZip（仅备份/恢复时才需要） */
async function loadJSZip(): Promise<typeof JSZipType> {
  return (await import('jszip')).default;
}

/** 应用版本（构建时从 package.json 注入，也是 Android versionName 的唯一来源） */
export const APP_VERSION = __APP_VERSION__;
/** v4 增加生活草稿与周刊；仍兼容 v1–v3。 */
export const SKBAK_SCHEMA_VERSION = 4;
/** 加密包头 magic（8 字节 ASCII） */
const MAGIC = 'SKBAK1E:';
/** PBKDF2 迭代次数（≥100k） */
const PBKDF2_ITERATIONS = 150000;

/** manifest.json 结构 */
export interface SkbakManifest {
  app: string;
  appVersion: string;
  schemaVersion: number;
  /** 生成时间（毫秒时间戳） */
  generatedAt: number;
  /** 各表记录条数 */
  counts: Record<string, number>;
  /** data.json 文本的 SHA-256（十六进制） */
  checksum: string;
  attachmentChecksums?: Record<string, string>;
}

/* ── Web Crypto 工具 ── */

async function sha256Hex(text: string | ArrayBuffer): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', typeof text === 'string' ? new TextEncoder().encode(text) : text);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** PBKDF2(SHA-256) 派生 AES-256-GCM 密钥 */
async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** 备份文件名：拾光备份_YYYYMMDD_HHmm.skbak */
export function backupFileName(d = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `拾光备份_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}.skbak`;
}

/* ── 打包 ── */

/**
 * 把全库导出打包为 .skbak Blob。
 * @param dump backupRepo.exportAll() 结果
 * @param password 可选口令；传入时输出加密包
 */
export async function buildSkbak(dump: TableDump, password?: string): Promise<Blob> {
  const JSZip = await loadJSZip();
  // attachments 剥离 blob：行内 blob 置空，Blob 单独存 attachments/{id}
  const atts = (dump.attachments ?? []) as Attachment[];
  const dataDump: Record<string, unknown[]> = {};
  for (const name of TABLE_NAMES) dataDump[name] = dump[name] ?? [];
  dataDump.attachments = atts.map((a) => ({ ...a, blob: null }));

  const dataJson = JSON.stringify(dataDump);
  const manifest: SkbakManifest = {
    app: '拾光',
    appVersion: APP_VERSION,
    schemaVersion: SKBAK_SCHEMA_VERSION,
    generatedAt: Date.now(),
    counts: countDump(dump),
    checksum: await sha256Hex(dataJson),
    attachmentChecksums: Object.fromEntries(await Promise.all(atts.map(async a => [String(a.id), await sha256Hex(await a.blob.arrayBuffer())]))),
  };

  const zip = new JSZip();
  zip.file('manifest.json', JSON.stringify(manifest, null, 2));
  zip.file('data.json', dataJson);
  const folder = zip.folder('attachments')!;
  for (const a of atts) folder.file(String(a.id), a.blob);
  const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  if (!password) return zipBlob;

  // 加密包：MAGIC + salt + iv + AES-GCM(zip)
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource }, key, await zipBlob.arrayBuffer(),
  );
  return new Blob([new TextEncoder().encode(MAGIC), salt, iv, cipher], { type: 'application/octet-stream' });
}

/* ── 解析 ── */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseManifest(text: string): SkbakManifest {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('manifest.json 结构损坏');
  }
  if (
    !isRecord(value)
    || typeof value.app !== 'string' || value.app.length === 0
    || typeof value.appVersion !== 'string' || value.appVersion.length === 0
    || typeof value.schemaVersion !== 'number' || !Number.isSafeInteger(value.schemaVersion)
    || typeof value.generatedAt !== 'number' || !Number.isSafeInteger(value.generatedAt) || value.generatedAt < 0
    || !isRecord(value.counts)
    || typeof value.checksum !== 'string' || !/^[0-9a-f]{64}$/i.test(value.checksum)
  ) {
    throw new Error('manifest.json 结构损坏');
  }
  for (const name of TABLE_NAMES) {
    const count = value.counts[name];
    if (count === undefined && value.schemaVersion < 4 && (name === 'lifeDrafts' || name === 'lifeEditions')) continue;
    if (count === undefined && value.schemaVersion < 3 && name === 'entryAttachments') continue;
    // v1 旧包 manifest 没有信用卡新表计数
    if (count === undefined && value.schemaVersion < 2 && (name === 'creditStatements' || name === 'creditPayments')) continue;
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
      throw new Error(`manifest.json 结构损坏：数据表 ${name} 计数无效`);
    }
  }
  return value as unknown as SkbakManifest;
}

function parseTableDump(text: string, manifest: SkbakManifest): TableDump {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('data.json 结构损坏');
  }
  if (!isRecord(value)) throw new Error('data.json 结构损坏');
  for (const name of TABLE_NAMES) {
    const rows = value[name];
    if (rows === undefined && manifest.schemaVersion < 4 && (name === 'lifeDrafts' || name === 'lifeEditions')) {
      value[name] = [];
      continue;
    }
    if (rows === undefined && manifest.schemaVersion < 3 && name === 'entryAttachments') {
      value[name] = [];
      continue;
    }
    // v1 旧包没有信用卡账单表：补空集合，历史转账不自动认领为还款
    if (rows === undefined && manifest.schemaVersion < 2 && (name === 'creditStatements' || name === 'creditPayments')) {
      value[name] = [];
      continue;
    }
    if (!Array.isArray(rows)) throw new Error(`data.json 数据表 ${name} 缺失或不是数组`);
    if ((manifest.counts[name] ?? 0) !== rows.length) {
      throw new Error(`manifest 计数与数据表 ${name} 实际条数不一致`);
    }
  }
  return value as TableDump;
}

/** 是否为加密包（前 8 字节 magic） */
export function sniffEncrypted(buf: ArrayBuffer): boolean {
  if (buf.byteLength < 8 + 16 + 12) return false;
  return new TextDecoder().decode(buf.slice(0, 8)) === MAGIC;
}

/**
 * 解析 .skbak：解密（如需）→ 解 zip → 校验 checksum 与 schemaVersion → 还原 attachments Blob。
 * @throws Error 口令错误 / 校验不符 / 版本不符 / 结构损坏时抛出，message 面向用户
 */
export async function parseSkbak(
  buf: ArrayBuffer,
  password?: string,
): Promise<{ manifest: SkbakManifest; dump: TableDump }> {
  let zipData = buf;
  if (sniffEncrypted(buf)) {
    if (!password) throw new Error('该备份包已加密，请输入口令');
    const salt = new Uint8Array(buf.slice(8, 24));
    const iv = new Uint8Array(buf.slice(24, 36));
    const key = await deriveKey(password, salt);
    try {
      zipData = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, buf.slice(36));
    } catch {
      throw new Error('口令错误或备份包已损坏');
    }
  }

  let zip: JSZipType;
  try {
    zip = await (await loadJSZip()).loadAsync(zipData);
  } catch {
    throw new Error('文件不是有效的拾光备份包（.skbak）');
  }
  const manifestFile = zip.file('manifest.json');
  const dataFile = zip.file('data.json');
  if (!manifestFile || !dataFile) throw new Error('备份包缺少 manifest.json / data.json');
  const manifest = parseManifest(await manifestFile.async('text'));
  if (manifest.schemaVersion > SKBAK_SCHEMA_VERSION) {
    throw new Error(`备份包来自更新的数据版本（v${manifest.schemaVersion}），请先升级应用`);
  }
  if (manifest.schemaVersion < 1) {
    throw new Error(`备份包使用不支持的数据版本（v${manifest.schemaVersion}）`);
  }
  const dataJson = await dataFile.async('text');
  if ((await sha256Hex(dataJson)) !== manifest.checksum) {
    throw new Error('校验值不符，备份包可能已损坏，已中止恢复');
  }

  const dump = parseTableDump(dataJson, manifest);
  // 还原附件 Blob（按 id 对应 attachments/ 下文件）
  const atts = (dump.attachments ?? []) as Attachment[];
  const restored: Array<{ attachment: Attachment; blob: Blob }> = [];
  for (const a of atts) {
    if (
      !isRecord(a)
      || typeof a.id !== 'number' || !Number.isSafeInteger(a.id) || a.id < 0
      || typeof a.mime !== 'string'
      || typeof a.size !== 'number' || !Number.isSafeInteger(a.size) || a.size < 0
    ) {
      throw new Error('备份包附件记录结构损坏');
    }
    const f = zip.file(`attachments/${a.id}`);
    if (!f) throw new Error(`备份包附件 ${a.id} 文件缺失`);
    const bytes = await f.async('arraybuffer');
    if (bytes.byteLength !== a.size) {
      throw new Error(`备份包附件 ${a.id} 大小与声明不一致`);
    }
    if (manifest.schemaVersion >= 3 && manifest.attachmentChecksums?.[String(a.id)] !== await sha256Hex(bytes)) {
      throw new Error(`备份包附件 ${a.id} 校验不符`);
    }
    restored.push({ attachment: a, blob: new Blob([bytes], { type: a.mime }) });
  }
  for (const item of restored) item.attachment.blob = item.blob;
  const entryIds = new Set((dump.entries as Array<{ id: number }>).map(entry => entry.id));
  const attachmentIds = new Set(atts.map(attachment => attachment.id));
  const relationKeys = new Set<string>();
  const relationIds = new Set<number>();
  for (const relation of dump.entryAttachments) {
    if (!isRecord(relation) || !Number.isSafeInteger(relation.id) || Number(relation.id) <= 0
      || !Number.isSafeInteger(relation.entryId) || !entryIds.has(relation.entryId as number)
      || !Number.isSafeInteger(relation.attachmentId) || !attachmentIds.has(relation.attachmentId as number)
      || !Number.isSafeInteger(relation.sortOrder) || Number(relation.sortOrder) < 0) {
      throw new Error('备份包账单凭证关联损坏');
    }
    const key = `${relation.entryId}:${relation.attachmentId}`;
    if (relationKeys.has(key) || relationIds.has(relation.id as number)) throw new Error('备份包账单凭证关联重复');
    relationKeys.add(key);
    relationIds.add(relation.id as number);
  }
  const draftKeys = new Set<string>();
  for (const row of dump.lifeDrafts) {
    try {
      const draft = row as LifeDraft;
      validateLifeDraft(draft);
      if (draftKeys.has(draft.key) || draft.existingPhotoRefs.some(id => !attachmentIds.has(id))) throw new Error('重复或缺少照片');
      draftKeys.add(draft.key);
    } catch { throw new Error('备份包生活草稿损坏'); }
  }
  const editionKeys = new Set<string>(), editionIds = new Set<number>();
  for (const row of dump.lifeEditions) {
    try {
      const edition = row as LifeEdition;
      validateLifeEdition(edition);
      if (!Number.isSafeInteger(edition.id) || edition.id! <= 0 || editionIds.has(edition.id!)
        || editionKeys.has(edition.weekKey) || !Number.isFinite(edition.createdAt) || !Number.isFinite(edition.updatedAt)
        || (edition.coverAttachmentId != null && !attachmentIds.has(edition.coverAttachmentId))) throw new Error('重复或字段无效');
      editionKeys.add(edition.weekKey); editionIds.add(edition.id!);
    } catch { throw new Error('备份包生活周刊损坏'); }
  }
  return { manifest, dump };
}
