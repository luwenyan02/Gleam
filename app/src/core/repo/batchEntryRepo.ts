/**
 * 拾光 · 共享账单批量操作。
 *
 * 先通过 previewBatchEntries 给界面展示可处理项与逐项跳过原因；
 * applyBatchEntries 会在同一个 Dexie 事务内重新预检并提交，供明细与搜索复用。
 */
import { db, now } from '../db';
import type { CategoryKind, Entry, EntryType } from '../types';
import { softDeleteEntry, updateEntry } from './entryRepo';
import { emitAfterCommit as emit } from './transactionEvents';

export type BatchEntryOperation =
  | { kind: 'category'; categoryId: number }
  | { kind: 'account'; accountId: number }
  | { kind: 'tags'; mode: 'add' | 'remove'; tagIds: number[] }
  | { kind: 'delete' };

export type BatchEntrySkipCode =
  | 'missing-entry'
  | 'already-deleted'
  | 'unsupported-entry-type'
  | 'category-type-mismatch'
  | 'already-target-category'
  | 'already-target-account'
  | 'tags-unchanged';

export interface BatchEntrySkip {
  entryId: number;
  entryType?: EntryType;
  code: BatchEntrySkipCode;
  reason: string;
}

export interface BatchEntryPreview {
  operation: BatchEntryOperation;
  selectedCount: number;
  processableIds: number[];
  skipped: BatchEntrySkip[];
}

export interface BatchEntryResult extends BatchEntryPreview {
  appliedIds: number[];
}

function normalizedIds(entryIds: readonly number[]): number[] {
  return [...new Set(entryIds.filter((id) => Number.isSafeInteger(id) && id > 0))];
}

async function targetCategoryKind(operation: BatchEntryOperation): Promise<CategoryKind | undefined> {
  if (operation.kind !== 'category') return undefined;
  const category = await db.categories.get(operation.categoryId);
  if (!category) throw new Error('目标分类不存在');
  return category.kind;
}

async function validateTargetAccount(operation: BatchEntryOperation): Promise<void> {
  if (operation.kind !== 'account') return;
  const account = await db.accounts.get(operation.accountId);
  if (!account) throw new Error('目标账户不存在');
}

async function targetTagIds(operation: BatchEntryOperation): Promise<number[]> {
  if (operation.kind !== 'tags') return [];
  const ids = normalizedIds(operation.tagIds);
  if (!ids.length) throw new Error('请至少选择一个标签');
  const tags = await db.tags.bulkGet(ids);
  if (tags.some((tag) => tag == null)) throw new Error('目标标签不存在');
  return ids;
}

function skipForEntry(
  entryId: number,
  entry: Entry | undefined,
  operation: BatchEntryOperation,
  categoryKind?: CategoryKind,
  entryTagIds: ReadonlySet<number> = new Set(),
  tagIds: readonly number[] = [],
): BatchEntrySkip | undefined {
  if (!entry) return { entryId, code: 'missing-entry', reason: '账单不存在' };
  if (entry.deletedAt !== 0) {
    return { entryId, entryType: entry.type, code: 'already-deleted', reason: '账单已在回收站' };
  }
  if (operation.kind === 'delete') return undefined;
  if (operation.kind === 'tags') {
    const unchanged = operation.mode === 'add'
      ? tagIds.every((tagId) => entryTagIds.has(tagId))
      : tagIds.every((tagId) => !entryTagIds.has(tagId));
    if (unchanged) {
      return {
        entryId,
        entryType: entry.type,
        code: 'tags-unchanged',
        reason: operation.mode === 'add' ? '账单已包含所选标签' : '账单未包含所选标签',
      };
    }
    return undefined;
  }
  if (entry.type === 'transfer' || entry.type === 'loan') {
    return {
      entryId,
      entryType: entry.type,
      code: 'unsupported-entry-type',
      reason: operation.kind === 'account'
        ? '转账和借贷需分别编辑双边账户'
        : '转账和借贷不使用收支分类',
    };
  }
  if (operation.kind === 'category' && entry.type !== categoryKind) {
    return {
      entryId,
      entryType: entry.type,
      code: 'category-type-mismatch',
      reason: `目标为${categoryKind === 'expense' ? '支出' : '收入'}分类，与账单类型不一致`,
    };
  }
  if (operation.kind === 'category' && entry.categoryId === operation.categoryId) {
    return {
      entryId,
      entryType: entry.type,
      code: 'already-target-category',
      reason: '账单已属于目标分类',
    };
  }
  if (operation.kind === 'account' && entry.accountId === operation.accountId) {
    return {
      entryId,
      entryType: entry.type,
      code: 'already-target-account',
      reason: '账单已使用目标账户',
    };
  }
  return undefined;
}

/** 读取当前账单状态，返回可处理 id 与每个跳过项的明确原因。 */
export async function previewBatchEntries(
  entryIds: readonly number[],
  operation: BatchEntryOperation,
): Promise<BatchEntryPreview> {
  const ids = normalizedIds(entryIds);
  const [entries, categoryKind, , tagIds] = await Promise.all([
    db.entries.bulkGet(ids),
    targetCategoryKind(operation),
    validateTargetAccount(operation),
    targetTagIds(operation),
  ]);
  const tagRows = operation.kind === 'tags' && ids.length
    ? await db.entryTags.where('entryId').anyOf(ids).toArray()
    : [];
  const tagsByEntry = new Map<number, Set<number>>();
  for (const row of tagRows) {
    const set = tagsByEntry.get(row.entryId) ?? new Set<number>();
    set.add(row.tagId);
    tagsByEntry.set(row.entryId, set);
  }
  const processableIds: number[] = [];
  const skipped: BatchEntrySkip[] = [];
  ids.forEach((entryId, index) => {
    const skip = skipForEntry(
      entryId,
      entries[index],
      operation,
      categoryKind,
      tagsByEntry.get(entryId),
      tagIds,
    );
    if (skip) skipped.push(skip);
    else processableIds.push(entryId);
  });
  return { operation, selectedCount: ids.length, processableIds, skipped };
}

/**
 * 在一个事务里重新预检并应用全部可处理项。任一写入失败会回滚本批所有账单与余额影响。
 */
export async function applyBatchEntries(
  entryIds: readonly number[],
  operation: BatchEntryOperation,
): Promise<BatchEntryResult> {
  return db.transaction(
    'rw',
    [db.entries, db.accounts, db.entryTags, db.categories, db.tags],
    async () => {
      const preview = await previewBatchEntries(entryIds, operation);
      if (operation.kind === 'category' && preview.processableIds.length) {
        const entries = await db.entries.bulkGet(preview.processableIds);
        if (entries.some((entry) => entry == null)) throw new Error('批量提交前账单状态已变化');
        const updatedAt = now();
        await db.entries.bulkPut(entries.map((entry) => ({
          ...entry!,
          categoryId: operation.categoryId,
          updatedAt,
        })));
        emit('entries-changed');
        return { ...preview, appliedIds: [...preview.processableIds] };
      }
      for (const entryId of preview.processableIds) {
        if (operation.kind === 'account') {
          await updateEntry(entryId, { accountId: operation.accountId });
        } else if (operation.kind === 'tags') {
          const targetIds = normalizedIds(operation.tagIds);
          if (operation.mode === 'add') {
            const existing = new Set((await db.entryTags.where('entryId').equals(entryId).toArray()).map((row) => row.tagId));
            for (const tagId of targetIds) {
              if (!existing.has(tagId)) await db.entryTags.add({ entryId, tagId });
            }
          } else {
            await db.entryTags.where('[entryId+tagId]')
              .anyOf(targetIds.map((tagId) => [entryId, tagId]))
              .delete();
          }
          emit('entries-changed', { id: entryId });
        } else {
          await softDeleteEntry(entryId);
        }
      }
      return { ...preview, appliedIds: [...preview.processableIds] };
    },
  );
}
