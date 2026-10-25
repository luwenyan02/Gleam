import { db } from '../db';
import { dayKey } from './entryRepo';

/** 只读取日期索引键。大跨度账本并行推进少量游标，避免逐日往返串行等待。 */
async function countEntryDays(index: IDBIndex, range: IDBKeyRange, active: () => boolean): Promise<number> {
  const edge = (direction: IDBCursorDirection) => new Promise<number | undefined>((resolve, reject) => {
    const request = index.openKeyCursor(range, direction);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve((request.result?.key as number[] | undefined)?.[1]);
  });
  const [first, last] = await Promise.all([edge('next'), edge('prev')]);
  if (!active()) throw new DOMException('页面已离开', 'AbortError');
  if (first == null || last == null) return 0;
  const days = new Set<string>();
  const parts = last - first > 90 * 86400000 && Number.isFinite(last) ? 16 : 1;
  const step = (last - first) / parts;
  await Promise.all(Array.from({ length: parts }, (_, i) => new Promise<void>((resolve, reject) => {
    const lower = i ? first + step * i : first;
    const upper = i + 1 === parts ? Infinity : first + step * (i + 1);
    const request = index.openKeyCursor(IDBKeyRange.bound([0, lower], [0, upper], false, true));
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      if (!active()) { reject(new DOMException('页面已离开', 'AbortError')); return; }
      const cursor = request.result;
      if (!cursor) { resolve(); return; }
      const at = (cursor.key as number[])[1];
      days.add(dayKey(at));
      const next = new Date(at);
      // 夏令时切换日可能为 23 或 25 小时，按本地日历推进。
      next.setHours(24, 0, 0, 0);
      const nextAt = next.getTime();
      if (nextAt >= upper) { resolve(); return; }
      if (Number.isFinite(nextAt) && nextAt > at) cursor.continue([0, nextAt]);
      else cursor.continue();
    };
  })));
  return days.size;
}

/** 每次从同一只读快照查询，不缓存跨连接写入或设备时区相关的摘要。 */
export async function getMineEntrySummary(active: () => boolean = () => true): Promise<{
  days: number; count: number; pendingCount: number; pendingAmount: number;
}> {
  if (!active()) throw new DOMException('页面已离开', 'AbortError');
  return db.transaction('r', db.entries, async transaction => {
    if (!active()) throw new DOMException('页面已离开', 'AbortError');
    const range = IDBKeyRange.bound([0, 0], [0, Infinity], false, true);
    const index = transaction.idbtrans.objectStore('entries').index('[deletedAt+occurredAt]');
    const [days, count, pending] = await Promise.all([
      countEntryDays(index, range, active),
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
