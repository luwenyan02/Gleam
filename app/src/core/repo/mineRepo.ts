import { db } from '../db';
import { dayKey } from './entryRepo';

/** 我的页只读取日期索引和待报销候选，不载入整本账单的备注等字段。 */
export async function getMineEntrySummary(): Promise<{
  days: number; count: number; pendingCount: number; pendingAmount: number;
}> {
  return db.transaction('r', db.entries, async () => {
    const [keys, pending] = await Promise.all([
      db.entries.where('[deletedAt+occurredAt]').between([0, 0], [0, Infinity], true, false).keys(),
      db.entries.where('reimburseStatus').equals('pending')
        .filter(entry => entry.deletedAt === 0 && entry.type === 'expense' && entry.occurredAt >= 0).toArray(),
    ]);
    const days = new Set<string>();
    for (const key of keys) {
      if (Array.isArray(key) && typeof key[1] === 'number') days.add(dayKey(key[1]));
    }
    return { days: days.size, count: keys.length, pendingCount: pending.length,
      pendingAmount: pending.reduce((sum, entry) => sum + entry.amount, 0) };
  });
}
