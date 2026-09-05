/**
 * 拾光 · 回收站仓库（trashRepo）
 * 账单与生活记录的软删除统一视图。恢复账单会重放余额影响（经 entryRepo）；
 * 物理清除超过保留天数（默认 30）的记录由 scheduler 启动时调用 purgeExpired。
 */
import { db, now } from '../db';
import { emit } from '../store';
import type { Entry, LifeNote } from '../types';
import { listDeletedEntries, purgeEntry, restoreEntry } from './entryRepo';
import { listDeletedLifeNotes, purgeLifeNote, restoreLifeNote } from './lifeRepo';
import { getSetting } from './settingsRepo';

/** 回收站条目（账单或生活记录的统一包装） */
export type TrashItem =
  | { kind: 'entry'; deletedAt: number; entry: Entry }
  | { kind: 'life'; deletedAt: number; note: LifeNote };

/** 回收站全部内容，按删除时间倒序 */
export async function listTrash(): Promise<TrashItem[]> {
  const [entries, notes] = await Promise.all([listDeletedEntries(), listDeletedLifeNotes()]);
  const items: TrashItem[] = [
    ...entries.map((entry): TrashItem => ({ kind: 'entry', deletedAt: entry.deletedAt, entry })),
    ...notes.map((note): TrashItem => ({ kind: 'life', deletedAt: note.deletedAt, note })),
  ];
  return items.sort((a, b) => b.deletedAt - a.deletedAt);
}

/** 恢复一个回收站条目（账单会重放余额影响） */
export async function restoreTrashItem(item: TrashItem): Promise<void> {
  if (item.kind === 'entry') await restoreEntry(item.entry.id!);
  else await restoreLifeNote(item.note.id!);
}

/** 彻底删除一个回收站条目（不可恢复；账单不再影响余额） */
export async function purgeTrashItem(item: TrashItem): Promise<void> {
  if (item.kind === 'entry') await purgeEntry(item.entry.id!);
  else await purgeLifeNote(item.note.id!);
}

/**
 * 清空回收站（逐条物理删除）。
 * @returns 清除条数
 */
export async function emptyTrash(): Promise<number> {
  const items = await listTrash();
  for (const item of items) await purgeTrashItem(item);
  return items.length;
}

/**
 * 物理清除超过保留天数的回收站记录（scheduler 启动/回前台时调用）。
 * @returns 清除条数
 */
export async function purgeExpired(): Promise<number> {
  const days = (await getSetting('trash.retentionDays')) as number;
  const cutoff = now() - days * 24 * 60 * 60 * 1000;
  const expiredEntries = await db.entries.where('deletedAt').between(1, cutoff, true, true).toArray();
  const expiredNotes = await db.lifeNotes.where('deletedAt').between(1, cutoff, true, true).toArray();
  for (const e of expiredEntries) await purgeEntry(e.id!);
  for (const n of expiredNotes) await purgeLifeNote(n.id!);
  const total = expiredEntries.length + expiredNotes.length;
  if (total > 0) {
    emit('entries-changed');
    emit('life-changed');
  }
  return total;
}
