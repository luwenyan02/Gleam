import { db } from '../db';
import { getEntry, getEntryTagIds, listRefunds } from './entryRepo';
import { listEntryAttachments } from './entryAttachmentRepo';

/** 单条详情的只读快照：只取实际关联资料，不随整本账单、商家或标签数量增长。 */
export async function getEntryViewData(entryId: number) {
  return db.transaction('r', [db.entries, db.categories, db.accounts, db.merchants, db.tags,
    db.entryTags, db.importBatches, db.entryAttachments, db.attachments], async () => {
    const entry = await getEntry(entryId);
    if (!entry || entry.deletedAt !== 0) return undefined;
    const accountIds = [...new Set([entry.accountId, entry.fromAccountId, entry.toAccountId].filter(id => id != null))];
    const [category, accounts, merchant, tags, refunds, original, batch, receipts] = await Promise.all([
      entry.categoryId != null ? db.categories.get(entry.categoryId) : undefined,
      db.accounts.bulkGet(accountIds),
      entry.merchantId != null ? db.merchants.get(entry.merchantId) : undefined,
      getEntryTagIds(entryId).then(ids => db.tags.bulkGet([...new Set(ids)])),
      entry.refundFlag ? [] : listRefunds(entryId),
      entry.refundOfEntryId != null ? getEntry(entry.refundOfEntryId) : undefined,
      entry.importBatchId != null ? db.importBatches.get(entry.importBatchId) : undefined,
      listEntryAttachments(entryId),
    ]);
    const categoryParent = category?.parentId != null ? await db.categories.get(category.parentId) : undefined;
    return { entry, category, categoryParent, accounts: accounts.filter(account => account != null), merchant,
      tags: tags.filter(tag => tag != null).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')),
      refunds, original, batch, receipts };
  });
}
