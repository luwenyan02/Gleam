/**
 * 拾光 · 备份仓库（backupRepo）[M3 新增]
 * 三块能力：
 * 1. 全库导出 / 恢复：exportAll 在单只读事务内导出 18 张表；restoreAll 在单写事务内
 *    清空全部表后写入（保留原 id），失败由 Dexie 事务整体回滚；
 * 2. 快照：恢复 / 导入前的自动快照存放在**独立库 GleamSnapshotDB**（若存主库，
 *    整库替换时会被一并清掉），保留 7 天，可一键撤销（undoSnapshot = 用快照恢复主库）；
 * 3. 备份历史：backupRecords 表的增查。
 *
 * 注意：restoreAll / undoSnapshot 完成后广播全部数据事件，UI 各模块自行刷新。
 */
import Dexie, { type EntityTable } from 'dexie';
import { db, now, stamp } from '../db';
import { emit, type AppEvent } from '../store';
import type { BackupRecord } from '../types';

/** 主库全部表名（与 db.ts schema 一一对应，导出/恢复按此清单遍历） */
export const TABLE_NAMES = [
  'entries', 'entryTags', 'accounts', 'categories', 'loanContacts',
  'budgets', 'categoryBudgets', 'recurringRules', 'quickTemplates',
  'tags', 'merchants', 'lifeNotes', 'habits', 'habitChecks',
  'backupRecords', 'importBatches', 'attachments', 'settings',
  'creditStatements', 'creditPayments', 'entryAttachments',
  'lifeDrafts', 'lifeEditions',
] as const;
export type TableName = (typeof TABLE_NAMES)[number];

/** 全库导出结果：表名 → 行数组（attachments 行内含 Blob，IndexedDB 结构化克隆可直存） */
export type TableDump = Record<TableName, unknown[]>;

/** 快照保留天数（PRD/方案文档约定 7 天） */
export const SNAPSHOT_RETENTION_DAYS = 7;

/* ── 全库导出 / 恢复 ── */

/** 在单只读事务内导出全部表（保证时点一致性） */
export async function exportAll(): Promise<TableDump> {
  const tables = TABLE_NAMES.map((n) => db.table(n));
  return db.transaction('r', tables, async () => {
    const dump = {} as TableDump;
    for (const name of TABLE_NAMES) dump[name] = await db.table(name).toArray();
    return dump;
  });
}

/** 各表条数统计（manifest / 完成报告用） */
export function countDump(dump: TableDump): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const name of TABLE_NAMES) counts[name] = (dump[name] ?? []).length;
  return counts;
}

/**
 * 备份包脱敏：云凭证与 AI Key 不进 .skbak（未加密包会明文扩散到网盘/云端）。
 * 置空旧版设置中的 WebDAV 密码、S3 Access/Secret Key 和 AI Key，其余设置原样；
 * 恢复后凭证为空，用户重填即可。仅供备份生成路径使用，本地快照不脱敏。
 * 不修改入参 dump（settings 行浅拷贝后替换 value）。
 */
export function sanitizeDumpForBackup(dump: TableDump): TableDump {
  const settings = (dump.settings ?? []).map((row) => {
    const r = row as { key: string; value: unknown };
    if (r.key === 'ai.apiKey') return { ...r, value: '' };
    if (r.key === 'life.aiEnabled') return { ...r, value: false };
    if (r.key === 'cloud.webdav') return { ...r, value: { ...(r.value as Record<string, unknown>), password: '' } };
    if (r.key === 'cloud.s3') return { ...r, value: { ...(r.value as Record<string, unknown>), accessKey: '', secretKey: '' } };
    return row;
  });
  return { ...dump, settings };
}

/**
 * 事务化整库替换：清空全部表后按 dump 写回（bulkAdd 保留原 id）。
 * 任何一步失败由 Dexie 事务整体回滚，主库保持替换前状态。
 * 完成后广播全部数据事件。
 */
export async function restoreAll(dump: Partial<TableDump>): Promise<void> {
  const tables = TABLE_NAMES.map((n) => db.table(n));
  await db.transaction('rw', tables, async () => {
    for (const name of TABLE_NAMES) {
      await db.table(name).clear();
      const rows = dump[name];
      if (rows?.length) await db.table(name).bulkAdd(rows as never[]);
    }
    await db.settings.put({ key: 'life.aiEnabled', value: false, updatedAt: now() });
  });
  const events: AppEvent[] = [
    'entries-changed', 'accounts-changed', 'categories-changed',
    'budgets-changed', 'life-changed', 'settings-changed',
  ];
  for (const ev of events) emit(ev);
}

/* ── 快照（独立库，避免整库替换时被清掉） ── */

/** 快照行：tables 为全库导出，metadata 用于列表展示 */
export interface SnapshotRow {
  id: number;
  createdAt: number;
  /** 触发原因：restore = 恢复前 / import = 导入前 */
  reason: 'restore' | 'import';
  /** 展示用说明，如「恢复备份 xx.skbak 前」 */
  label: string;
  /** 各表条数 */
  counts: Record<string, number>;
  tables: TableDump;
}

const snapDb = new Dexie('GleamSnapshotDB') as Dexie & {
  snapshots: EntityTable<SnapshotRow, 'id'>;
};
snapDb.version(1).stores({ snapshots: '++id, createdAt' });

/**
 * 创建当前数据快照（恢复 / 导入前调用）。
 * @returns 快照 id
 */
export async function createSnapshot(reason: 'restore' | 'import', label: string): Promise<number> {
  const dump = await exportAll();
  return snapDb.snapshots.add({
    createdAt: now(), reason, label, counts: countDump(dump), tables: dump,
  } as SnapshotRow);
}

/** 快照列表（不含 tables 大对象），createdAt 倒序 */
export async function listSnapshots(): Promise<Omit<SnapshotRow, 'tables'>[]> {
  const rows = await snapDb.snapshots.orderBy('createdAt').reverse().toArray();
  return rows.map(({ tables: _t, ...meta }) => meta);
}

/**
 * 一键撤销：用快照内容整库替换主库，成功后删除该快照。
 */
export async function undoSnapshot(id: number): Promise<void> {
  const snap = await snapDb.snapshots.get(id);
  if (!snap) throw new Error('快照不存在或已过期清理');
  await restoreAll(snap.tables);
  await snapDb.snapshots.delete(id);
}

/** 删除单个快照 */
export async function deleteSnapshot(id: number): Promise<void> {
  await snapDb.snapshots.delete(id);
}

/**
 * 清理超保留期快照（scheduler 补跑时调用）。
 * @returns 清理条数
 */
export async function purgeSnapshots(retentionDays = SNAPSHOT_RETENTION_DAYS): Promise<number> {
  const cutoff = now() - retentionDays * 86400000;
  const expired = await snapDb.snapshots.where('createdAt').below(cutoff).toArray();
  if (expired.length) await snapDb.snapshots.bulkDelete(expired.map((s) => s.id));
  return expired.length;
}

/* ── 备份历史 ── */

/** 记录一次备份（生成 .skbak 成功后调用） */
export async function addBackupRecord(
  input: Omit<BackupRecord, 'id' | 'createdAt' | 'updatedAt'>,
): Promise<number> {
  return db.backupRecords.add(stamp({ ...input }) as BackupRecord);
}

/** 备份历史，createdAt 倒序 */
export async function listBackupRecords(limit = 20): Promise<BackupRecord[]> {
  return db.backupRecords.orderBy('createdAt').reverse().limit(limit).toArray();
}

/* ── [R09] 备份状态计数 ── */

/** 备份状态卡计数结果 */
export interface LocalCounts {
  /** 全部业务表行数合计（不含 settings） */
  total: number;
  /** 未删除账单数 */
  liveEntries: number;
  /** 未删除生活记录数 */
  liveLifeNotes: number;
}

/**
 * [R09] 备份页状态卡轻量计数：直接走 IndexedDB count()，
 * 避免为展示计数做 exportAll 全量导出（附件 Blob 会被一并读入内存）。
 */
export async function countLocalStats(): Promise<LocalCounts> {
  const tables = TABLE_NAMES.map((n) => db.table(n));
  return db.transaction('r', tables, async () => {
    let total = 0;
    for (const name of TABLE_NAMES) {
      if (name === 'settings') continue;
      total += await db.table(name).count();
    }
    const liveEntries = await db.entries.where('deletedAt').equals(0).count();
    const liveLifeNotes = await db.lifeNotes.where('deletedAt').equals(0).count();
    return { total, liveEntries, liveLifeNotes };
  });
}
