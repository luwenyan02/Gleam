import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const WEEK = 7 * 86400000;
const NOW = Date.UTC(2026, 9, 23, 12);
let db: typeof import('../src/core/db').db;
let history: typeof import('../src/features/backup/backupHistory');
let status: typeof import('../src/features/backup/backupStatus');
let stored: Map<string, string>;
beforeEach(async () => {
  vi.resetModules();
  stored = new Map();
  vi.stubGlobal('localStorage', { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) });
  ({ db } = await import('../src/core/db'));
  history = await import('../src/features/backup/backupHistory');
  status = await import('../src/features/backup/backupStatus');
  await db.delete(); await db.open(); await history.archiveDb.delete(); await history.archiveDb.open();
});
afterEach(() => { db?.close(); history?.archiveDb.close(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('空账本不提示，非空账本未备份或满七天时提示', () => {
  expect(status.shouldRemindBackup(0, false, NOW)).toBe(false);
  expect(status.shouldRemindBackup(0, true, NOW)).toBe(true);
  expect(status.shouldRemindBackup(NOW - WEEK + 1, true, NOW)).toBe(false);
  expect(status.shouldRemindBackup(NOW - WEEK, true, NOW)).toBe(true);
});

it('关闭后七天内不再提示，到期再提示，成功备份重新计时', () => {
  status.dismissBackupReminder(NOW);
  expect(status.shouldRemindBackup(0, true, NOW + WEEK - 1)).toBe(false);
  expect(status.shouldRemindBackup(0, true, NOW + WEEK)).toBe(true);
  expect(status.shouldRemindBackup(NOW + WEEK, true, NOW + WEEK)).toBe(false);
});

it('localStorage不可用时保留本次会话关闭和成功状态', () => {
  vi.stubGlobal('localStorage', { getItem() { throw new Error('disabled'); }, setItem() { throw new Error('full'); } });
  status.dismissBackupReminder(NOW);
  status.rememberLocalBackup(NOW);
  expect(status.shouldRemindBackup(0, true, NOW + 1)).toBe(false);
  expect(status.getRememberedLocalBackup()).toBe(NOW);
});

it('导入设置和历史不能冒充本机成功，但独立本机副本可提供旧版成功时间且不读取文件值', async () => {
  await db.settings.put({ key: 'backup.lastBackupAt', value: NOW, updatedAt: NOW });
  await db.backupRecords.add({ fileName: 'import.skbak', size: 1, entryCount: 1, encrypted: false, provider: 'local', createdAt: NOW, updatedAt: NOW });
  expect(await history.getLastLocalBackupAt()).toBe(0);
  const record = { fileName: 'device.skbak', size: 1, entryCount: 1, encrypted: false, provider: 'local' as const, createdAt: NOW - WEEK, updatedAt: NOW - WEEK };
  await history.archiveDb.files.put({ id: 'old-device-file', savedAt: NOW - WEEK, record, blob: new Blob(['x']) });
  const values = vi.spyOn(IDBIndex.prototype, 'getAll');
  const cursor = vi.spyOn(IDBIndex.prototype, 'openCursor');
  expect(await history.getLastLocalBackupAt()).toBe(NOW - WEEK);
  expect(values).not.toHaveBeenCalled();
  expect(cursor).not.toHaveBeenCalled();
});

it('成功备份即使无法缓存文件仍有本机时间，恢复设置不会覆盖它', async () => {
  const write = vi.spyOn(history.archiveDb.files, 'put').mockRejectedValueOnce(new Error('quota'));
  await history.recordBackupFile({ fileName: 'backup.skbak', size: 1, entryCount: 1, encrypted: false, provider: 'local' }, new Blob(['x']));
  write.mockRestore();
  const at = await history.getLastLocalBackupAt();
  expect(at).toBeGreaterThan(0);
  await db.settings.put({ key: 'backup.lastBackupAt', value: 1, updatedAt: 1 });
  expect(await history.getLastLocalBackupAt()).toBe(at);
});

it('主库成功记录失败时，未完成的缓存不会冒充成功备份', async () => {
  vi.spyOn(db.backupRecords, 'add').mockRejectedValueOnce(new Error('record failed'));
  await expect(history.recordBackupFile({ fileName: 'backup.skbak', size: 1, entryCount: 1, encrypted: false, provider: 'local' }, new Blob(['x']))).rejects.toThrow('record failed');
  expect(await history.getLastLocalBackupAt()).toBe(0);
});
