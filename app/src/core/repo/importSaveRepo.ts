/**
 * 导入保存的最外层事务边界。
 * 前置快照由调用方在事务外完成；映射创建、查重、入账、商家计数与 AI 队列消费共用此事务。
 */
import { db } from '../db';

export async function saveImportAtomically<T>(operation: () => Promise<T>): Promise<T> {
  return db.transaction(
    'rw',
    [
      db.entries, db.accounts, db.entryTags, db.importBatches,
      db.categories, db.tags, db.merchants, db.settings, db.attachments,
    ],
    operation,
  );
}
