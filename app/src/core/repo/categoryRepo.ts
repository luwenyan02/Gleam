/**
 * 拾光 · 分类仓库（categoryRepo）
 * 支出两级（parentId 指向大类）、收入单级。写操作后 emit 'categories-changed'。
 */
import { db, now, stamp } from '../db';
import type { Category, CategoryKind } from '../types';
import { emitAfterCommit as emit } from './transactionEvents';

/** 新建分类输入 */
export type NewCategory = Omit<Category, 'id' | 'createdAt' | 'updatedAt' | 'sortOrder'> & { sortOrder?: number };

/**
 * 新增分类（大类：parentId 不传；小类：parentId 指向支出大类）。
 * @returns 新分类 id
 */
export async function addCategory(input: NewCategory): Promise<number> {
  if (input.parentId != null) {
    const parent = await db.categories.get(input.parentId);
    if (!parent || parent.kind !== 'expense' || parent.parentId != null) throw new Error('parentId 须为支出大类');
  }
  const maxSort = (await db.categories.orderBy('sortOrder').last())?.sortOrder ?? 0;
  const id = await db.categories.add(stamp({ sortOrder: maxSort + 1, ...input }) as Category);
  emit('categories-changed', { id });
  return id;
}

/** 改名 / 换图标 / 调整排序 */
export async function updateCategory(
  id: number,
  patch: Partial<Pick<Category, 'name' | 'icon' | 'iconOverride' | 'sortOrder'>>,
): Promise<void> {
  await db.categories.update(id, { ...patch, updatedAt: now() });
  emit('categories-changed', { id });
}

/** 同级分类排序一次提交，避免中间刷新丢失后续顺序。 */
export async function reorderCategories(ids: number[]): Promise<void> {
  if (!ids.length || new Set(ids).size !== ids.length) throw new Error('排序项不能为空或重复');
  await db.transaction('rw', db.categories, async () => {
    const rows = await db.categories.bulkGet(ids);
    const first = rows[0];
    if (!first || rows.some(row => !row || row.kind !== first.kind || row.parentId !== first.parentId)) throw new Error('只能调整同级分类');
    const slots = rows.map(row => row!.sortOrder).sort((a, b) => a - b);
    for (let i = 0; i < ids.length; i++) await db.categories.update(ids[i], { sortOrder: slots[i], updatedAt: now() });
    emit('categories-changed');
  });
}

/**
 * 移动小类到其他大类（targetParentId 传 undefined 即升为大类）。
 */
export async function moveCategory(id: number, targetParentId: number | undefined): Promise<void> {
  if (targetParentId != null) {
    const parent = await db.categories.get(targetParentId);
    if (!parent || parent.kind !== 'expense' || parent.parentId != null) throw new Error('目标须为支出大类');
  }
  await db.categories.update(id, { parentId: targetParentId, updatedAt: now() });
  emit('categories-changed', { id });
}

/**
 * 删除分类。有账单引用时必须提供 transferToId，事务内把引用账单转移过去；
 * 删除大类要求先处理其下小类（存在小类时抛错）。
 */
export async function deleteCategory(id: number, transferToId?: number): Promise<void> {
  await db.transaction('rw', [db.categories, db.entries], async () => {
    const children = await db.categories.where('parentId').equals(id).count();
    if (children > 0) throw new Error('请先移动或删除该大类下的小类');
    const used = await db.entries.where('categoryId').equals(id).count();
    if (used > 0) {
      if (transferToId == null) throw new Error(`该分类有 ${used} 笔账单引用，须指定转移目标分类`);
      await db.entries.where('categoryId').equals(id).modify({ categoryId: transferToId, updatedAt: now() });
    }
    await db.categories.delete(id);
  });
  emit('categories-changed', { id });
  if (transferToId != null) emit('entries-changed');
}

/** 单个分类 */
export async function getCategory(id: number): Promise<Category | undefined> {
  return db.categories.get(id);
}

/** 某 kind 全部分类，sortOrder 升序 */
export async function listCategories(kind: CategoryKind): Promise<Category[]> {
  const rows = await db.categories.where('kind').equals(kind).toArray();
  return rows.sort((a, b) => a.sortOrder - b.sortOrder);
}

/**
 * 支出分类树：[{ parent, children }]，均按 sortOrder 排序，供分类管理与记一笔宫格。
 */
export async function listExpenseTree(): Promise<{ parent: Category; children: Category[] }[]> {
  const rows = await listCategories('expense');
  const parents = rows.filter((c) => c.parentId == null);
  return parents.map((parent) => ({
    parent,
    children: rows.filter((c) => c.parentId === parent.id),
  }));
}

/** 全部未删除收支的实体笔数（含退款）；支出大类包含自身及小类，不生成报销展示事件。 */
export async function countCategoryEntries(): Promise<Map<number, number>> {
  return db.transaction('r', [db.categories, db.entries], async () => {
    const [categories, entries] = await Promise.all([
      db.categories.toArray(), db.entries.where('deletedAt').equals(0).toArray(),
    ]);
    const byId = new Map(categories.map(category => [category.id, category]));
    const counts = new Map(categories.map(category => [category.id, 0]));
    for (const entry of entries) {
      const category = entry.categoryId != null ? byId.get(entry.categoryId) : undefined;
      if (!category || entry.type !== category.kind) continue;
      counts.set(category.id, counts.get(category.id)! + 1);
      const parent = category.parentId != null ? byId.get(category.parentId) : undefined;
      if (parent?.kind === category.kind && parent.id !== category.id) {
        counts.set(parent.id, counts.get(parent.id)! + 1);
      }
    }
    return counts;
  });
}
