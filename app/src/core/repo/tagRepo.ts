/**
 * 拾光 · 标签仓库（tagRepo）
 * 标签名唯一；导入时不存在的标签自动创建（ensureTag）。
 * 写操作后 emit 'entries-changed'（标签仅依附账单展示，无独立事件）。
 */
import { db, now, stamp } from '../db';
import type { EntryTag, Tag } from '../types';
import { emitAfterCommit as emit } from './transactionEvents';

/** 全部标签，按名称排序 */
export async function listTags(): Promise<Tag[]> {
  const rows = await db.tags.toArray();
  return rows.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
}

/** 批量读取当前结果的标签关联；未传范围用于全局关键词匹配。 */
export async function listEntryTagLinks(entryIds?: readonly number[]): Promise<EntryTag[]> {
  if (!entryIds) return db.entryTags.toArray();
  const ids = [...new Set(entryIds)].sort((a, b) => a - b);
  const links: EntryTag[] = [];
  // 并行的精确索引读取可使用原生 getAll，避免稀疏 anyOf 游标反复跨线程跳转。
  // 分批限制未完成请求数，同时保留原索引顺序及空范围语义。
  for (let start = 0; start < ids.length; start += 128) {
    const batch = await Promise.all(ids.slice(start, start + 128)
      .map(id => db.entryTags.where('entryId').equals(id).toArray()));
    for (const rows of batch) for (const row of rows) links.push(row);
  }
  return links;
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
export async function renameTag(id: number, name: string, color?: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('标签名不能为空');
  const normalized = color?.trim().toUpperCase() || undefined;
  if (normalized != null && !/^#[0-9A-F]{6}$/.test(normalized)) throw new Error('标签颜色格式无效');
  await db.tags.update(id, { name: trimmed, ...(color !== undefined ? { color: normalized } : {}), updatedAt: now() });
  emit('entries-changed');
}

/** 标签颜色为空表示跟随主题；非空值统一存为大写 #RRGGBB。 */
export async function setTagColor(id: number, color?: string): Promise<void> {
  const normalized = color?.trim().toUpperCase() || undefined;
  if (normalized != null && !/^#[0-9A-F]{6}$/.test(normalized)) throw new Error('标签颜色格式无效');
  if (await db.tags.update(id, { color: normalized, updatedAt: now() }) === 0) throw new Error('标签不存在');
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
