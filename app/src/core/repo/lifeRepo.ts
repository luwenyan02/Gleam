/**
 * 拾光 · 生活记录仓库（lifeRepo）
 * 日记 / 照片 / 习惯打卡三类记录，软删除进回收站（deletedAt 存 0 表示未删除）。
 * 照片以 Blob 存 attachments 表，LifeNote.photoRefs 持有附件 id。
 * 写操作后 emit 'life-changed'。
 */
import { db, now, stamp } from '../db';
import { emitAfterCommit as emit } from './transactionEvents';
import type { Attachment, Entry, Habit, HabitCheck, LifeNote } from '../types';
import { dayKey } from './entryRepo';
import { collectUnreferencedAttachments } from './entryAttachmentRepo';

/** 新建生活记录输入（deletedAt 由仓库补 0） */
export type NewLifeNote = Omit<LifeNote, 'id' | 'createdAt' | 'updatedAt' | 'deletedAt'>;

/* ── 生活记录 ─────────────────────── */

/**
 * 新增生活记录（日记 / 照片 / 打卡随记）。
 * @returns 记录 id
 */
export async function addLifeNote(input: NewLifeNote): Promise<number> {
  const id = await db.lifeNotes.add(stamp({ ...input, deletedAt: 0 }) as LifeNote);
  emit('life-changed', { id });
  return id;
}

/** 更新生活记录内容 */
export async function updateLifeNote(
  id: number,
  patch: Partial<Omit<NewLifeNote, 'kind'>>,
): Promise<void> {
  await db.lifeNotes.update(id, { ...patch, updatedAt: now() });
  emit('life-changed', { id });
}

/** 软删除生活记录（进回收站，30 天后由 scheduler 物理清除） */
export async function softDeleteLifeNote(id: number): Promise<void> {
  await db.lifeNotes.update(id, { deletedAt: now(), updatedAt: now() });
  emit('life-changed', { id });
}

/** 从回收站恢复生活记录 */
export async function restoreLifeNote(id: number): Promise<void> {
  await db.lifeNotes.update(id, { deletedAt: 0, updatedAt: now() });
  emit('life-changed', { id });
}

/** 物理删除生活记录（仅回收站内允许），连带清除其照片附件 */
export async function purgeLifeNote(id: number): Promise<void> {
  await db.transaction('rw', [db.lifeNotes, db.attachments, db.entryAttachments, db.settings, db.lifeDrafts, db.lifeEditions], async () => {
    const note = await db.lifeNotes.get(id);
    if (!note) return;
    if (!note.deletedAt) throw new Error('仅回收站中的记录可彻底删除');
    await db.lifeNotes.delete(id);
    await collectUnreferencedAttachments([...(note.photoRefs ?? []), ...(note.conversation ?? []).flatMap(message => message.photoRefs ?? [])]);
  });
  emit('life-changed', { id });
}

/** 单条记录 */
export async function getLifeNote(id: number): Promise<LifeNote | undefined> {
  return db.lifeNotes.get(id);
}

/** 读取仍有效且关联到指定生活记录的账单。 */
export async function listLifeLinkedEntries(noteId: number): Promise<Entry[]> {
  if (!Number.isSafeInteger(noteId) || noteId <= 0) return [];
  const rows = await db.entries.where('lifeNoteId').equals(noteId).toArray();
  return rows.filter((entry) => entry.deletedAt === 0).sort((a, b) => b.occurredAt - a.occurredAt);
}

/**
 * 把既有账单关联到既有生活记录。仅更新关系字段，不重放账户影响。
 */
export async function linkEntryToLifeNote(entryId: number, noteId: number): Promise<void> {
  await db.transaction('rw', [db.entries, db.lifeNotes], async () => {
    const [entry, note] = await Promise.all([db.entries.get(entryId), db.lifeNotes.get(noteId)]);
    if (!entry || entry.deletedAt !== 0) throw new Error('账单不存在或已删除');
    if (!note || note.deletedAt !== 0) throw new Error('生活记录不存在或已删除');
    await db.entries.update(entryId, { lifeNoteId: noteId, updatedAt: now() });
  });
  emit('life-changed', { id: noteId });
  emit('entries-changed', { id: entryId });
}

/**
 * 按时间范围倒序列出生活记录（不含回收站）。
 * @param kind 可选按类型过滤
 */
export async function listLifeNotes(opts: { from?: number; to?: number; kind?: LifeNote['kind']; limit?: number } = {}): Promise<LifeNote[]> {
  const { from = 0, to = Infinity, kind, limit } = opts;
  let collection = db.lifeNotes
    .where('[deletedAt+occurredAt]')
    .between([0, from], [0, to], true, true);
  if (kind) collection = collection.filter(note => note.kind === kind);
  if (limit != null) collection = collection.reverse().limit(limit);
  const rows = await collection.toArray();
  return rows.sort((a, b) => b.occurredAt - a.occurredAt);
}

/** 回收站中的生活记录（deletedAt 倒序） */
export async function listDeletedLifeNotes(): Promise<LifeNote[]> {
  const rows = await db.lifeNotes.where('deletedAt').above(0).toArray();
  return rows.sort((a, b) => b.deletedAt - a.deletedAt);
}

/* ── 照片附件 ─────────────────────── */

/**
 * 存入照片 Blob，返回附件 id（写入 LifeNote.photoRefs 由调用方负责）。
 */
export async function addAttachment(blob: Blob, name?: string, thumbnail?: string): Promise<number> {
  return db.attachments.add(stamp({ mime: blob.type || 'application/octet-stream', name, size: blob.size, blob, thumbnail }) as Attachment);
}

/** 读取附件 */
export async function getAttachment(id: number): Promise<Attachment | undefined> {
  return db.attachments.get(id);
}

/* ── 习惯与打卡 ───────────────────── */

/**
 * 新增习惯。
 * @returns 习惯 id
 */
export async function addHabit(name: string): Promise<number> {
  const maxSort = (await db.habits.orderBy('sortOrder').last())?.sortOrder ?? 0;
  const id = await db.habits.add(stamp({ name, sortOrder: maxSort + 1 }) as Habit);
  emit('life-changed', { habitId: id });
  return id;
}

/** 改名习惯 */
export async function renameHabit(id: number, name: string): Promise<void> {
  await db.habits.update(id, { name, updatedAt: now() });
  emit('life-changed', { habitId: id });
}

/** 删除习惯及其全部打卡记录 */
export async function deleteHabit(id: number): Promise<void> {
  await db.transaction('rw', [db.habits, db.habitChecks], async () => {
    await db.habitChecks.where('habitId').equals(id).delete();
    await db.habits.delete(id);
  });
  emit('life-changed', { habitId: id });
}

/** 全部习惯，sortOrder 升序 */
export async function listHabits(): Promise<Habit[]> {
  return db.habits.orderBy('sortOrder').toArray();
}

/**
 * 打卡（同一习惯同一自然日幂等；重复打卡返回已有记录 id）。
 * @param checkAt 打卡时间，缺省当前
 * @returns 打卡记录 id
 */
export async function checkHabit(habitId: number, checkAt = now()): Promise<number> {
  const day = dayKey(checkAt);
  const existing = await db.habitChecks.where('[habitId+day]').equals([habitId, day]).first();
  if (existing) return existing.id!;
  const id = await db.habitChecks.add(stamp({ habitId, checkAt, day }) as HabitCheck);
  emit('life-changed', { habitId });
  return id;
}

/** 取消某习惯某自然日的打卡 */
export async function uncheckHabit(habitId: number, day: string): Promise<void> {
  await db.habitChecks.where('[habitId+day]').equals([habitId, day]).delete();
  emit('life-changed', { habitId });
}

/** 某习惯当日是否已打卡 */
export async function isCheckedToday(habitId: number): Promise<boolean> {
  const existing = await db.habitChecks.where('[habitId+day]').equals([habitId, dayKey(now())]).first();
  return !!existing;
}

/**
 * 某习惯截至今天的连续打卡天数（今天未打卡则从昨天起算）。
 */
export async function habitStreak(habitId: number): Promise<number> {
  const checks = await db.habitChecks.where('habitId').equals(habitId).toArray();
  const days = new Set(checks.map((c) => c.day));
  let streak = 0;
  const cursor = new Date();
  cursor.setHours(0, 0, 0, 0);
  if (!days.has(dayKey(cursor.getTime()))) cursor.setDate(cursor.getDate() - 1); // 今天未打卡不断签
  while (days.has(dayKey(cursor.getTime()))) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}
