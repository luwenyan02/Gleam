/**
 * 拾光 · 标签仓库（tagRepo）
 * 标签名唯一；导入时不存在的标签自动创建（ensureTag）。
 * 写操作后 emit 'entries-changed'（标签仅依附账单展示，无独立事件）。
 */
import { db, now, stamp } from '../db';
import type { Tag } from '../types';
import { emitAfterCommit as emit } from './transactionEvents';

/** 全部标签，按名称排序 */
export async function listTags(): Promise<Tag[]> {
  const rows = await db.tags.toArray();
  return rows.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
}

/**
 * 按名称取标签，不存在则创建（导入拆分逗号标签时使用）。
 * @returns 标签 id
 */
export async function ensureTag(name: string): Promise<number> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('标签名不能为空');
  const existing = await db.tags.where('name').equals(trimmed).first();
  if (existing) return existing.id!;
  const id = await db.tags.add(stamp({ name: trimmed }) as Tag);
  emit('entries-changed');
  return id;
}

/** 改名（重名时抛错，由 &name 唯一索引保证） */
export async function renameTag(id: number, name: string): Promise<void> {
  await db.tags.update(id, { name: name.trim(), updatedAt: now() });
  emit('entries-changed');
}

/** [M3] 按标签反查关联账单 id（全局搜索标签命中用） */
export async function listEntryIdsByTag(tagId: number): Promise<number[]> {
  const rows = await db.entryTags.where('tagId').equals(tagId).toArray();
  return rows.map((r) => r.entryId);
}

/** 删除标签并清理所有账单关联 */
export async function deleteTag(id: number): Promise<void> {
  await db.transaction('rw', [db.tags, db.entryTags], async () => {
    await db.entryTags.where('tagId').equals(id).delete();
    await db.tags.delete(id);
  });
  emit('entries-changed');
}
