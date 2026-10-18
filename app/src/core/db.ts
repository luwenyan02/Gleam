/**
 * 拾光 · Dexie 数据库定义（schema v5）
 * 单库 GleamDB。UI 模块不得直接操作 db，一律经 repo/ 仓库层。
 *
 * 索引约定：
 * - 软删除表（entries/lifeNotes）的 deletedAt 统一存 0 表示未删除，
 *   以便 `[deletedAt+occurredAt]` 复合索引按 `[0, from]..[0, to]` 范围查询；
 * - entries 的 `[occurredAt+type+amount+accountId]` 专供导入查重。
 */
import Dexie, { type EntityTable } from 'dexie';
import type {
  Account, Attachment, BackupRecord, Budget, Category, CategoryBudget, Entry, EntryTag, EntryAttachment,
  CreditPayment, CreditStatement, Habit, HabitCheck, ImportBatch, LifeDraft, LifeEdition, LifeNote, LoanContact, Merchant, QuickTemplate,
  RecurringRule, Setting, Tag,
} from './types';

export const db = new Dexie('GleamDB') as Dexie & {
  entries: EntityTable<Entry, 'id'>;
  entryTags: EntityTable<EntryTag, 'id'>;
  entryAttachments: EntityTable<EntryAttachment, 'id'>;
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
  creditStatements: EntityTable<CreditStatement, 'id'>;
  creditPayments: EntityTable<CreditPayment, 'id'>;
  lifeDrafts: EntityTable<LifeDraft, 'key'>;
  lifeEditions: EntityTable<LifeEdition, 'id'>;
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

/**
 * v2：信用卡手工账单与还款分配。
 * 旧版「隐藏账户计入净资产」是全局开关；迁移时把它展开到账户字段，保留升级前的
 * 实际统计范围。之后 hidden 与 countInNetWorth 完全独立。
 */
db.version(2).stores({
  recurringRules: '++id, enabled, nextRunAt, [enabled+nextRunAt], accountId',
  creditStatements: '++id, accountId, dueAt, [accountId+periodStart], [accountId+periodEnd]',
  creditPayments: '++id, statementId, &entryId',
}).upgrade(async transaction => {
  const setting = await transaction.table('settings').get('netWorth.includeHidden') as Setting | undefined;
  const legacyIncludedHidden = setting?.value === true;
  await transaction.table('accounts').toCollection().modify((account: Account) => {
    if (typeof account.countInNetWorth !== 'boolean') account.countInNetWorth = true;
    if (account.hidden && legacyIncludedHidden) account.countInNetWorth = true;
    if (typeof account.creditReminderEnabled !== 'boolean') account.creditReminderEnabled = true;
  });
});

db.version(3).stores({
  entryAttachments: '++id, entryId, attachmentId, &[entryId+attachmentId]',
});

/** v4：生活故事编辑草稿与按自然周唯一的本地周刊。 */
db.version(4).stores({
  lifeDrafts: '&key',
  lifeEditions: '++id, &weekKey, createdAt, updatedAt',
});

/** v5：关联退款按原账单索引读取；仅增加索引，账单字段和余额保持原样。 */
db.version(5).stores({
  entries:
    '++id, occurredAt, categoryId, accountId, importBatchId, deletedAt, ' +
    '[deletedAt+occurredAt], [deletedAt+type], [occurredAt+type+amount+accountId], ' +
    'loanContactId, reimburseStatus, lifeNoteId, refundOfEntryId',
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
