/**
 * 拾光 · Dexie 数据库定义（schema v1）
 * 单库 GleamDB，18 张表。UI 模块不得直接操作 db，一律经 repo/ 仓库层。
 *
 * 索引约定：
 * - 软删除表（entries/lifeNotes）的 deletedAt 统一存 0 表示未删除，
 *   以便 `[deletedAt+occurredAt]` 复合索引按 `[0, from]..[0, to]` 范围查询；
 * - entries 的 `[occurredAt+type+amount+accountId]` 专供导入查重。
 */
import Dexie, { type EntityTable } from 'dexie';
import type {
  Account, Attachment, BackupRecord, Budget, Category, CategoryBudget, Entry, EntryTag,
  Habit, HabitCheck, ImportBatch, LifeNote, LoanContact, Merchant, QuickTemplate,
  RecurringRule, Setting, Tag,
} from './types';

export const db = new Dexie('GleamDB') as Dexie & {
  entries: EntityTable<Entry, 'id'>;
  entryTags: EntityTable<EntryTag, 'id'>;
  accounts: EntityTable<Account, 'id'>;
  categories: EntityTable<Category, 'id'>;
  loanContacts: EntityTable<LoanContact, 'id'>;
  budgets: EntityTable<Budget, 'id'>;
  categoryBudgets: EntityTable<CategoryBudget, 'id'>;
  recurringRules: EntityTable<RecurringRule, 'id'>;
  quickTemplates: EntityTable<QuickTemplate, 'id'>;
  tags: EntityTable<Tag, 'id'>;
  merchants: EntityTable<Merchant, 'id'>;
  lifeNotes: EntityTable<LifeNote, 'id'>;
  habits: EntityTable<Habit, 'id'>;
  habitChecks: EntityTable<HabitCheck, 'id'>;
  backupRecords: EntityTable<BackupRecord, 'id'>;
  importBatches: EntityTable<ImportBatch, 'id'>;
  attachments: EntityTable<Attachment, 'id'>;
  settings: EntityTable<Setting, 'key'>;
};

db.version(1).stores({
  entries:
    '++id, occurredAt, categoryId, accountId, importBatchId, deletedAt, ' +
    '[deletedAt+occurredAt], [deletedAt+type], [occurredAt+type+amount+accountId], ' +
    'loanContactId, reimburseStatus, lifeNoteId',
  entryTags: '++id, entryId, tagId, [entryId+tagId]',
  accounts: '++id, group, hidden, sortOrder',
  categories: '++id, kind, parentId, [kind+parentId], sortOrder',
  loanContacts: '++id, name',
  budgets: '++id, &month',
  categoryBudgets: '++id, month, [month+categoryId]',
  recurringRules: '++id, enabled, nextRunAt, [enabled+nextRunAt]',
  quickTemplates: '++id, sortOrder',
  tags: '++id, &name',
  merchants: '++id, &name, useCount',
  lifeNotes: '++id, occurredAt, kind, deletedAt, [deletedAt+occurredAt], habitId',
  habits: '++id, sortOrder',
  habitChecks: '++id, habitId, checkAt, [habitId+day]',
  backupRecords: '++id, createdAt',
  importBatches: '++id, createdAt',
  attachments: '++id',
  settings: 'key',
});

/** 当前时间戳（毫秒），统一出口便于测试替换 */
export function now(): number {
  return Date.now();
}

/** 给新实体补齐 createdAt/updatedAt */
export function stamp<T extends object>(entity: T): T & { createdAt: number; updatedAt: number } {
  const t = now();
  return { createdAt: t, updatedAt: t, ...entity } as T & { createdAt: number; updatedAt: number };
}
