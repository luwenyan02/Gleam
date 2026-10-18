import { db, now } from '../db';
import type { AiPendingItem, Category } from '../types';
import { emitAfterCommit as emit } from './transactionEvents';

const tables = () => [db.categories, db.entries, db.quickTemplates, db.recurringRules, db.categoryBudgets, db.settings];
export interface CategoryMergePreview {
  sourcePath: string;
  targetPath: string;
  entries: number;
  deletedEntries: number;
  templates: number;
  recurringRules: number;
  categoryBudgets: number;
  children: number;
  duplicateChildNames: number;
  revision: string;
}
export function categoryPath(category: Category, categories: readonly Category[]): string {
  const parent = categories.find(row => row.id === category.parentId);
  return parent ? `${parent.name}／${category.name}` : category.name;
}

async function planMerge(sourceId: number, targetId: number) {
  if (!Number.isSafeInteger(sourceId) || !Number.isSafeInteger(targetId) || sourceId === targetId) throw new Error('请选择不同的原分类和目标分类');
  const categories = await db.categories.toArray();
  const source = categories.find(row => row.id === sourceId), target = categories.find(row => row.id === targetId);
  if (!source || !target) throw new Error('分类已不存在，请重新选择');
  if (source.kind !== target.kind) throw new Error('只能合并相同收支类型的分类');
  if ((source.parentId == null) !== (target.parentId == null)) throw new Error('大类只能合并到大类，小类只能合并到小类');
  const [entries, templates, rules, budgets, settings] = await Promise.all([
    db.entries.where('categoryId').equals(sourceId).toArray(),
    db.quickTemplates.toArray(), db.recurringRules.toArray(),
    db.categoryBudgets.toArray(), db.settings.toArray(),
  ]);
  const children = categories.filter(row => row.parentId === sourceId);
  const duplicateChildNames = children.filter(child => categories.some(row => row.parentId === targetId && row.name === child.name)).length;
  const affectedTemplates = templates.filter(row => row.categoryId === sourceId);
  const affectedRules = rules.filter(row => row.categoryId === sourceId);
  const sourceBudgets = budgets.filter(row => row.categoryId === sourceId);
  // Check every period before any write. Overall monthly budget limits do not change.
  const limits = new Map<string, number>();
  for (const budget of budgets.filter(row => row.categoryId === sourceId || row.categoryId === targetId)) {
    const limit = (limits.get(budget.month) ?? 0) + budget.limit;
    if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('合并后的分类预算超出有效金额范围');
    limits.set(budget.month, limit);
  }
  const pending = settings.filter(row => ['entry.lastUsed', 'recurring.pendingConfirms', 'ai.pendingItems'].includes(row.key));
  const preview: CategoryMergePreview = {
    sourcePath: categoryPath(source, categories), targetPath: categoryPath(target, categories),
    entries: entries.length, deletedEntries: entries.filter(row => row.deletedAt > 0).length,
    templates: affectedTemplates.length, recurringRules: affectedRules.length,
    categoryBudgets: sourceBudgets.length, children: children.length, duplicateChildNames,
    revision: JSON.stringify({ source, target, sourcePath: categoryPath(source, categories), targetPath: categoryPath(target, categories), children, entries: entries.map(row => [row.id, row.updatedAt]), templates: affectedTemplates, rules: affectedRules, budgets: budgets.filter(row => row.categoryId === sourceId || row.categoryId === targetId), pending }),
  };
  return { preview, source, target, categories, children, sourceBudgets, settings };
}

/** Read-only preview used for confirmation; full paths distinguish same-named children. */
export async function previewCategoryMerge(sourceId: number, targetId: number): Promise<CategoryMergePreview> {
  return db.transaction('r', tables(), async () => (await planMerge(sourceId, targetId)).preview);
}

function remapAiDrafts(items: AiPendingItem[], source: Category, target: Category, categories: Category[], children: Category[]): AiPendingItem[] {
  const normalize = (name: string) => name.replace(/／/g, '/').replace(/\s*\/\s*/g, '/');
  const paths = new Map([[normalize(categoryPath(source, categories)), normalize(categoryPath(target, categories))]]);
  for (const child of children) paths.set(`${source.name}/${child.name}`, `${target.name}/${child.name}`);
  const bareNameUnique = categories.filter(row => row.kind === source.kind && row.name === source.name).length === 1;
  if (bareNameUnique) paths.set(source.name, normalize(categoryPath(target, categories)));
  return items.map(item => {
    if (item.type !== source.kind || !item.categoryName) return item;
    const replacement = paths.get(normalize(item.categoryName));
    return replacement ? { ...item, categoryName: replacement } : item;
  });
}

/** Reclassify references atomically; no entry monetary fields or account balances are written. */
export async function mergeCategories(sourceId: number, targetId: number, expectedRevision?: string): Promise<CategoryMergePreview> {
  return db.transaction('rw', tables(), async () => {
    const { preview, source, target, categories, children, sourceBudgets, settings } = await planMerge(sourceId, targetId);
    if (expectedRevision != null && preview.revision !== expectedRevision) throw new Error('分类关联数据已变化，请重新核对后合并');
    const updatedAt = now();
    await db.entries.where('categoryId').equals(sourceId).modify({ categoryId: targetId, updatedAt });
    await db.quickTemplates.toCollection().filter(row => row.categoryId === sourceId).modify({ categoryId: targetId, updatedAt });
    // Older schemas do not index template/recurring categoryId; use collection filters below.
    await db.recurringRules.toCollection().filter(row => row.categoryId === sourceId).modify({ categoryId: targetId, updatedAt });
    for (const child of children) await db.categories.update(child.id, { parentId: targetId, updatedAt });
    for (const budget of sourceBudgets) {
      const existing = await db.categoryBudgets.where('[month+categoryId]').equals([budget.month, targetId]).first();
      if (existing) {
        await db.categoryBudgets.update(existing.id, { limit: existing.limit + budget.limit, updatedAt });
        await db.categoryBudgets.delete(budget.id);
      } else await db.categoryBudgets.update(budget.id, { categoryId: targetId, updatedAt });
    }
    for (const setting of settings) {
      let value = setting.value;
      if (setting.key === 'entry.lastUsed' && value && typeof value === 'object' && !Array.isArray(value)) {
        const field = `${source.kind}CategoryId`;
        const saved = value as Record<string, unknown>;
        if (saved[field] === sourceId) value = { ...saved, [field]: targetId };
      } else if (setting.key === 'recurring.pendingConfirms' && Array.isArray(value)) {
        value = value.map(row => row.categoryId === sourceId ? { ...row, categoryId: targetId } : row);
      } else if (setting.key === 'ai.pendingItems' && Array.isArray(value)) {
        value = remapAiDrafts(value as AiPendingItem[], source, target, categories, children);
      }
      if (JSON.stringify(value) !== JSON.stringify(setting.value)) await db.settings.put({ ...setting, value, updatedAt });
    }
    await db.categories.delete(sourceId);
    emit('categories-changed'); emit('entries-changed'); emit('templates-changed');
    emit('budgets-changed'); emit('settings-changed');
    return preview;
  });
}
