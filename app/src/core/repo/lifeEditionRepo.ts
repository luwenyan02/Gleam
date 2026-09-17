import { db, now, stamp } from '../db';
import { shiftLifeWeek } from '../lifeWeek';
import type { LifeEdition, LifeEditionBlock, LifeEditionSourceRef, LifeNote } from '../types';
import { emitAfterCommit as emit } from './transactionEvents';
import { collectUnreferencedAttachments, RECEIPT_MIME_TYPES } from './entryAttachmentRepo';

export type LifeEditionStatus = 'current' | 'stale' | 'blocked';
export type LifeEditionInput = Pick<LifeEdition, 'weekKey' | 'title' | 'blocks' | 'sourceRefs' | 'coverAttachmentId'>;
export interface LifeEditionRead { edition: LifeEdition; status: LifeEditionStatus }
export interface LifeEditionSummary {
  weekKey: string;
  title: string;
  status: LifeEditionStatus;
  createdAt: number;
  updatedAt: number;
}

const MAX_TITLE_LENGTH = 120;
const MAX_BLOCK_LENGTH = 2_000;
const MAX_TOTAL_TEXT = 12_000;
const MAX_SOURCES = 50;

function eligible(note: LifeNote): boolean {
  return note.deletedAt === 0 && note.kind !== 'habit' && note.aiExcluded !== true;
}

export function validateLifeEdition(input: LifeEditionInput): void {
  shiftLifeWeek(input.weekKey, 0);
  if (typeof input.title !== 'string' || !input.title.trim()) throw new Error('周刊标题不能为空');
  if (input.title.trim().length > MAX_TITLE_LENGTH) throw new Error('周刊标题过长');
  if (!Array.isArray(input.sourceRefs) || input.sourceRefs.length === 0 || input.sourceRefs.length > MAX_SOURCES) {
    throw new Error('周刊来源数量无效');
  }
  if (!Array.isArray(input.blocks) || input.blocks.length === 0 || input.blocks.length > MAX_SOURCES) {
    throw new Error('周刊正文不能为空或过多');
  }
  const refIds = new Set<number>();
  for (const ref of input.sourceRefs) {
    if (!Number.isSafeInteger(ref.noteId) || ref.noteId <= 0 || !Number.isFinite(ref.updatedAt) || refIds.has(ref.noteId)) {
      throw new Error('周刊来源引用无效或重复');
    }
    refIds.add(ref.noteId);
  }
  const blockIds = new Set<number>();
  let total = input.title.trim().length;
  for (const block of input.blocks) {
    if (!Number.isSafeInteger(block.noteId) || !refIds.has(block.noteId) || blockIds.has(block.noteId)) {
      throw new Error('周刊正文含未知或重复来源');
    }
    if (typeof block.text !== 'string' || !block.text.trim() || block.text.trim().length > MAX_BLOCK_LENGTH) {
      throw new Error('周刊正文内容无效');
    }
    total += block.text.trim().length;
    blockIds.add(block.noteId);
  }
  if (total > MAX_TOTAL_TEXT) throw new Error('周刊内容过长');
  if (input.coverAttachmentId != null
    && (!Number.isSafeInteger(input.coverAttachmentId) || input.coverAttachmentId <= 0)) {
    throw new Error('周刊封面引用无效');
  }
}

/** 本地自然周内可由用户选择的全部生活 AI 来源。 */
export async function getLifeWeekSources(weekKey: string): Promise<LifeNote[]> {
  const week = shiftLifeWeek(weekKey, 0);
  const rows = await db.lifeNotes
    .where('[deletedAt+occurredAt]')
    .between([0, week.from], [0, week.to], true, false)
    .toArray();
  return rows.filter(eligible).sort((a, b) => a.occurredAt - b.occurredAt);
}

async function editionStatus(edition: LifeEdition): Promise<LifeEditionStatus> {
  const week = shiftLifeWeek(edition.weekKey, 0);
  const notes = await db.lifeNotes.bulkGet(edition.sourceRefs.map((ref) => ref.noteId));
  let stale = false;
  for (let index = 0; index < edition.sourceRefs.length; index++) {
    const note = notes[index];
    const ref = edition.sourceRefs[index];
    if (!note || !eligible(note)) return 'blocked';
    if (note.updatedAt !== ref.updatedAt || note.occurredAt < week.from || note.occurredAt >= week.to) stale = true;
  }
  if (edition.coverAttachmentId != null && !(await db.attachments.get(edition.coverAttachmentId))) stale = true;
  return stale ? 'stale' : 'current';
}

function redactBlocked(edition: LifeEdition): LifeEdition {
  return { ...edition, title: '', blocks: [], coverAttachmentId: undefined };
}

/** 不存在返回 undefined；blocked 状态不会返回旧生成文本或封面。 */
export async function getLifeEdition(weekKey: string): Promise<LifeEditionRead | undefined> {
  shiftLifeWeek(weekKey, 0);
  const edition = await db.lifeEditions.where('weekKey').equals(weekKey).first();
  if (!edition) return undefined;
  const status = await editionStatus(edition);
  return { edition: status === 'blocked' ? redactBlocked(edition) : edition, status };
}

/**
 * 保存已验证的周刊。既有周刊默认拒绝覆盖；overwrite 也不会绕过来源版本校验。
 */
export async function saveLifeEdition(
  input: LifeEditionInput,
  options: { overwrite?: boolean } = {},
): Promise<number> {
  validateLifeEdition(input);
  const id = await db.transaction('rw', [db.lifeEditions, db.lifeNotes, db.attachments, db.lifeDrafts, db.entryAttachments, db.settings], async () => {
    const existing = await db.lifeEditions.where('weekKey').equals(input.weekKey).first();
    if (existing && !options.overwrite) throw new Error('该周周刊已存在，请确认后再覆盖');
    const week = shiftLifeWeek(input.weekKey, 0);
    const notes = await db.lifeNotes.bulkGet(input.sourceRefs.map((ref) => ref.noteId));
    for (let index = 0; index < input.sourceRefs.length; index++) {
      const note = notes[index];
      const ref = input.sourceRefs[index];
      if (!note || !eligible(note) || note.occurredAt < week.from || note.occurredAt >= week.to) {
        throw new Error('周刊来源已失效，请重新选择');
      }
      if (note.updatedAt !== ref.updatedAt) throw new Error('周刊来源已变化，请重新生成');
    }
    if (input.coverAttachmentId != null) {
      const attachment = await db.attachments.get(input.coverAttachmentId);
      const selectedPhotoIds = new Set(notes.flatMap((note) => note?.photoRefs ?? []));
      if (!attachment || !selectedPhotoIds.has(input.coverAttachmentId)
        || !RECEIPT_MIME_TYPES.includes(attachment.mime)
        || !(attachment.blob instanceof Blob) || attachment.blob.size !== attachment.size) {
        throw new Error('周刊封面必须来自所选故事的有效照片');
      }
    }
    const changedAt = now();
    const normalized = {
      weekKey: input.weekKey,
      title: input.title.trim(),
      blocks: input.blocks.map((block): LifeEditionBlock => ({ noteId: block.noteId, text: block.text.trim() })),
      sourceRefs: input.sourceRefs.map((ref): LifeEditionSourceRef => ({ ...ref })),
      coverAttachmentId: input.coverAttachmentId,
    };
    if (existing) {
      await db.lifeEditions.put({ ...existing, ...normalized, updatedAt: changedAt });
      if (existing.coverAttachmentId != null) await collectUnreferencedAttachments([existing.coverAttachmentId]);
      return existing.id!;
    }
    return db.lifeEditions.add(stamp(normalized) as LifeEdition);
  });
  emit('life-changed', { editionWeekKey: input.weekKey });
  return id!;
}

export async function listLifeEditionSummaries(): Promise<LifeEditionSummary[]> {
  const editions = await db.lifeEditions.orderBy('createdAt').reverse().toArray();
  return Promise.all(editions.map(async (edition) => {
    const status = await editionStatus(edition);
    return {
      weekKey: edition.weekKey,
      title: status === 'blocked' ? '' : edition.title,
      status,
      createdAt: edition.createdAt,
      updatedAt: edition.updatedAt,
    };
  }));
}

export async function deleteLifeEdition(weekKey: string): Promise<void> {
  shiftLifeWeek(weekKey, 0);
  await db.transaction('rw', [db.lifeEditions, db.lifeNotes, db.attachments, db.lifeDrafts, db.entryAttachments, db.settings], async () => {
    const edition = await db.lifeEditions.where('weekKey').equals(weekKey).first();
    await db.lifeEditions.where('weekKey').equals(weekKey).delete();
    if (edition?.coverAttachmentId != null) await collectUnreferencedAttachments([edition.coverAttachmentId]);
  });
  emit('life-changed', { editionWeekKey: weekKey });
}
