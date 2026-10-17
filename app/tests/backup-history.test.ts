import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/core/db';
import { archiveDb, recordBackupFile, listBackupHistory, readBackupFile } from '../src/features/backup/backupHistory';
import { exportAll, sanitizeDumpForBackup, restoreAll } from '../src/core/repo/backupRepo';

beforeEach(async () => { await db.delete(); await db.open(); await archiveDb.delete(); await archiveDb.open(); });
const info = { fileName: '虚构备份.skbak', provider: 'local' as const, entryCount: 1, encrypted: false };
describe('本机历史备份恢复', () => {
  it('保存实际文件，恢复账本后历史副本仍可读取，备份不嵌套本机文件', async () => {
    const blob = new Blob(['fictional-backup']);
    await recordBackupFile({ ...info, size: blob.size }, blob);
    const [item] = await listBackupHistory();
    expect(await (await readBackupFile(item.fileId!))!.text()).toBe('fictional-backup');
    const dump = sanitizeDumpForBackup(await exportAll());
    expect(JSON.stringify(dump.backupRecords)).not.toContain('localFileId');
    await restoreAll(dump);
    expect(await listBackupHistory()).toHaveLength(1);
    expect((await listBackupHistory())[0].fileId).toBe(item.fileId);
  });
  it('仅缓存最近十份，旧记录保留但需重新选择文件', async () => {
    for (let i = 0; i < 12; i++) await recordBackupFile({ ...info, fileName: `${i}.skbak`, size: 1 }, new Blob(['x']));
    const history = await listBackupHistory();
    expect(history).toHaveLength(12);
    expect(history.filter(item => item.fileId)).toHaveLength(10);
    expect(await archiveDb.files.count()).toBe(10);
  });
  it('旧历史只显示文件选择入口，不虚构可读取文件', async () => {
    await db.backupRecords.add({ ...info, size: 10, createdAt: 1, updatedAt: 1 });
    expect((await listBackupHistory())[0].fileId).toBeUndefined();
    expect(await readBackupFile('missing')).toBeUndefined();
  });
});
