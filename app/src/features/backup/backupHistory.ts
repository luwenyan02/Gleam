import Dexie, { type EntityTable } from 'dexie';
import type { BackupRecord } from '../../core/types';
import { addBackupRecord, listBackupRecords } from '../../core/repo/backupRepo';

type Metadata = Omit<BackupRecord, 'id'>;
interface ArchivedFile { id: string; savedAt: number; record: Metadata; blob: Blob }
export interface BackupHistoryItem extends Metadata { key: string; fileId?: string }
export const archiveDb = new Dexie('GleamBackupFilesDB') as Dexie & { files: EntityTable<ArchivedFile, 'id'> };
archiveDb.version(1).stores({ files: 'id, savedAt' });
const MAX_BYTES = 100 * 1024 * 1024;

/** 独立于账本，恢复时不清空，也不打包进下一份备份，避免递归膨胀。 */
export async function recordBackupFile(input: Omit<BackupRecord, 'id' | 'createdAt' | 'updatedAt'>, blob: Blob): Promise<boolean> {
  let localFileId: string | undefined;
  const now = Date.now();
  if (blob.size <= MAX_BYTES) {
    const id = crypto.randomUUID();
    try {
      await archiveDb.transaction('rw', archiveDb.files, async () => {
        const previous = await archiveDb.files.orderBy('savedAt').reverse().toArray();
        let bytes = blob.size, count = 1;
        const remove: string[] = [];
        for (const file of previous) {
          if (count >= 10 || bytes + file.blob.size > MAX_BYTES) remove.push(file.id);
          else { count++; bytes += file.blob.size; }
        }
        await archiveDb.files.bulkDelete(remove);
        await archiveDb.files.put({ id, savedAt: now, blob, record: { ...input, localFileId: id, createdAt: now, updatedAt: now } });
      });
      localFileId = id;
    } catch { /* 空间不足不把已下载/已上传/已发送的备份误报为失败。 */ }
  }
  await addBackupRecord({ ...input, localFileId }, now);
  return !!localFileId;
}

export async function listBackupHistory(): Promise<BackupHistoryItem[]> {
  const [records, files] = await Promise.all([
    listBackupRecords(), archiveDb.files.toArray().catch(() => [] as ArchivedFile[]),
  ]);
  const available = new Set(files.map(f => f.id));
  const identity = (r: Metadata) => `${r.fileName}\0${r.provider}\0${r.createdAt}`;
  const archived = new Map(files.map(f => [identity(f.record), f]));
  const rows: BackupHistoryItem[] = records.map(r => {
    const fileId = r.localFileId && available.has(r.localFileId) ? r.localFileId : archived.get(identity(r))?.id;
    return { ...r, key: fileId ?? `record-${r.id}`, fileId };
  });
  const seen = new Set(rows.flatMap(r => r.fileId ? [r.fileId] : []));
  for (const file of files) {
    if (!seen.has(file.id)) rows.push({ ...file.record, key: file.id, fileId: file.id });
  }
  return rows.sort((a, b) => b.createdAt - a.createdAt).slice(0, 20);
}

export async function readBackupFile(id: string): Promise<File | undefined> {
  const file = await archiveDb.files.get(id);
  return file ? new File([file.blob], file.record.fileName, { type: 'application/octet-stream' }) : undefined;
}
