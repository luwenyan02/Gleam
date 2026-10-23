import { db } from '../db';
import { dayKey } from './entryRepo';

/** 一天只读取一个日期索引键；count 由 IndexedDB 直接统计，不载入账单值。 */
function countEntryDays(index: IDBIndex, range: IDBKeyRange): Promise<number> {
  return new Promise((resolve, reject) => {
    const days = new Set<string>();
    const request = index.openKeyCursor(range);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) { resolve(days.size); return; }
      const at = (cursor.key as number[])[1];
      days.add(dayKey(at));
      const next = new Date(at);
      // 按本地日历推进，不能加 24 小时：夏令时切换日可能为 23 或 25 小时。
      next.setHours(24, 0, 0, 0);
      const nextAt = next.getTime();
      if (Number.isFinite(nextAt) && nextAt > at) cursor.continue([0, nextAt]);
      else cursor.continue(); // 保留旧数据中超出 Date 范围时间戳的原统计口径。
    };
  });
}

/** 每次从同一只读快照查询，不缓存跨连接写入或设备时区相关的摘要。 */
export async function getMineEntrySummary(): Promise<{
  days: number; count: number; pendingCount: number; pendingAmount: number;
}> {
  return db.transaction('r', db.entries, async transaction => {
    const range = IDBKeyRange.bound([0, 0], [0, Infinity], false, true);
    const index = transaction.idbtrans.objectStore('entries').index('[deletedAt+occurredAt]');
    const [days, count, pending] = await Promise.all([
      countEntryDays(index, range),
      db.entries.where('[deletedAt+occurredAt]').between([0, 0], [0, Infinity], true, false).count(),
      db.entries.where('reimburseStatus').equals('pending')
        .filter(entry => entry.deletedAt === 0 && entry.type === 'expense' && entry.occurredAt >= 0).toArray(),
    ]);
    return { days, count, pendingCount: pending.length,
      pendingAmount: pending.reduce((sum, entry) => sum + entry.amount, 0) };
  });
}

/** 备份提醒也覆盖只使用拾光记录生活的用户，不读取正文或照片附件。 */
export async function getMineLifeNoteCount(): Promise<number> {
  return db.lifeNotes.where('deletedAt').equals(0).count();
}
