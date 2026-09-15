/**
 * 拾光 · 速记模板仓库（templateRepo）
 * 「分类 + 金额 + 名称」的一键记账模板，供记一笔抽屉的速记区使用。
 * 模板本身不入账；套用模板由 UI 组装 NewEntry 后走 entryRepo.addEntry。
 */
import { db, now, stamp } from '../db';
import type { QuickTemplate } from '../types';
import { emitAfterCommit } from './transactionEvents';
import { getSetting, setSetting } from './settingsRepo';
import { nextRecentTemplates } from '../entryLaunch';

/** 新建模板输入 */
export type NewQuickTemplate = Omit<QuickTemplate, 'id' | 'createdAt' | 'updatedAt' | 'sortOrder'> & {
  sortOrder?: number;
};

/**
 * 新增速记模板。
 * @returns 模板 id
 */
export async function addTemplate(input: NewQuickTemplate): Promise<number> {
  const maxSort = (await db.quickTemplates.orderBy('sortOrder').last())?.sortOrder ?? 0;
  const id = await db.quickTemplates.add(stamp({ sortOrder: maxSort + 1, ...input }) as QuickTemplate);
  emitAfterCommit('templates-changed');
  return id;
}

/** 更新模板（名称 / 金额 / 分类 / 排序） */
export async function updateTemplate(
  id: number,
  patch: Partial<Pick<QuickTemplate, 'name' | 'amount' | 'categoryId' | 'sortOrder'>>,
): Promise<void> {
  await db.quickTemplates.update(id, { ...patch, updatedAt: now() });
  emitAfterCommit('templates-changed');
}

/** 删除模板 */
export async function deleteTemplate(id: number): Promise<void> {
  await db.quickTemplates.delete(id);
  emitAfterCommit('templates-changed');
}

export async function rememberTemplate(id: number): Promise<void> {
  await db.transaction('rw', [db.quickTemplates, db.settings], async () => {
    if (!await db.quickTemplates.get(id)) return;
    await setSetting('entry.recentTemplates', nextRecentTemplates(await getSetting('entry.recentTemplates'), id));
  });
}

/** 全部模板，sortOrder 升序 */
export async function listTemplates(): Promise<QuickTemplate[]> {
  return db.quickTemplates.orderBy('sortOrder').toArray();
}
