import { db } from '../db';
import type { Entry } from '../types';

/** 账户详情只读快照：覆盖普通收支、转账／借贷两侧及异账户报销到账。 */
export async function getAccountViewData(accountId: number) {
  return db.transaction('r', [db.accounts, db.entries, db.categories], async () => {
    const account = await db.accounts.get(accountId);
    if (!account) return undefined;
    // 独立索引查询可使用 getAll；不逐条遍历整本账，也不漏掉只关联收款侧的原单。
    const matches = await Promise.all(['accountId', 'fromAccountId', 'toAccountId', 'reimburseAccountId']
      .map(index => db.entries.where(index).equals(accountId).toArray()));
    const byId = new Map<number, Entry>();
    const categoryIds = new Set<number>(), accountIds = new Set<number>();
    for (const rows of matches) for (const entry of rows) {
      // 与原 listEntries() 默认的 [0, Infinity) 时间范围保持一致。
      if (entry.deletedAt !== 0 || !Number.isFinite(entry.occurredAt) || entry.occurredAt < 0 || byId.has(entry.id)) continue;
      byId.set(entry.id, entry);
      if (entry.categoryId != null) categoryIds.add(entry.categoryId);
      for (const id of [entry.accountId, entry.fromAccountId, entry.toAccountId, entry.reimburseAccountId]) {
        if (id != null && id !== accountId) accountIds.add(id);
      }
    }
    const entries = [...byId.values()];
    const [categories, accounts] = await Promise.all([
      db.categories.bulkGet([...categoryIds]), db.accounts.bulkGet([...accountIds]),
    ]);
    const parentIds = [...new Set(categories.flatMap(category =>
      category?.parentId != null && !categoryIds.has(category.parentId) ? [category.parentId] : []))];
    const parents = await db.categories.bulkGet(parentIds);
    return { account, entries, categories: [...categories, ...parents].filter(category => category != null),
      accounts: [account, ...accounts.filter(item => item != null)] };
  });
}
