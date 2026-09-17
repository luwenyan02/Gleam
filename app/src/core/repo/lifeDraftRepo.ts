import { db, now, stamp } from '../db';
import type { Attachment, LifeDraft, LifeDraftPhoto, LifeNote } from '../types';
import { emitAfterCommit as emit } from './transactionEvents';
import { collectUnreferencedAttachments, MAX_ENTRY_ATTACHMENTS, MAX_RECEIPT_BYTES } from './entryAttachmentRepo';

const DATA_URL_RE = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]*={0,2})$/;

function validatePhoto(photo: LifeDraftPhoto): { mime: string; base64: string; size: number } {
  if (!photo || typeof photo.name !== 'string' || typeof photo.dataUrl !== 'string') {
    throw new Error('照片草稿结构无效');
  }
  const match = DATA_URL_RE.exec(photo.dataUrl);
  if (!match) throw new Error('照片仅支持 JPG、PNG、WebP 图片');
  const base64 = match[2];
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  const size = Math.floor(base64.length * 3 / 4) - padding;
  if (size <= 0 || size > MAX_RECEIPT_BYTES) throw new Error('每张照片须在 10 MB 以内');
  try { atob(base64); } catch { throw new Error('照片数据损坏'); }
  return { mime: match[1], base64, size };
}

export function validateLifeDraft(draft: LifeDraft): void {
  if (!draft || typeof draft.key !== 'string' || !draft.key.trim()) throw new Error('草稿 key 无效');
  if (typeof draft.title !== 'string' || typeof draft.body !== 'string') throw new Error('草稿文字无效');
  if (!Number.isFinite(draft.occurredAt)) throw new Error('草稿发生时间无效');
  if (draft.sourceUpdatedAt != null && !Number.isFinite(draft.sourceUpdatedAt)) throw new Error('草稿来源版本无效');
  if (typeof draft.aiExcluded !== 'boolean' || [draft.aiText, draft.pendingReply, draft.mood, draft.originalBody].some(value => value != null && typeof value !== 'string')) throw new Error('草稿可选字段无效');
  if (draft.tags != null && (!Array.isArray(draft.tags) || draft.tags.some(tag => typeof tag !== 'string'))) throw new Error('草稿标签无效');
  if (draft.review != null && (typeof draft.review !== 'object'
    || (draft.review.verdict != null && !['again', 'neutral', 'not-for-me'].includes(draft.review.verdict))
    || (draft.review.text != null && typeof draft.review.text !== 'string')
    || [draft.review.revisitAt, draft.review.dismissedAt].some(value => value != null && !Number.isFinite(value)))) throw new Error('回访内容无效');
  if (!Array.isArray(draft.existingPhotoRefs) || !Array.isArray(draft.photos) || !Array.isArray(draft.messages)) {
    throw new Error('草稿结构无效');
  }
  if (draft.noteId != null && (!Number.isSafeInteger(draft.noteId) || draft.noteId <= 0)) throw new Error('生活记录编号无效');
  if (draft.entryId != null && (!Number.isSafeInteger(draft.entryId) || draft.entryId <= 0)) throw new Error('账单编号无效');
  const refs = new Set(draft.existingPhotoRefs);
  if (refs.size !== draft.existingPhotoRefs.length
    || draft.existingPhotoRefs.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error('既有照片引用无效');
  }
  if (draft.existingPhotoRefs.length + draft.photos.length > MAX_ENTRY_ATTACHMENTS) {
    throw new Error(`每篇故事最多 ${MAX_ENTRY_ATTACHMENTS} 张照片`);
  }
  for (const photo of draft.photos) validatePhoto(photo);
  for (const message of draft.messages) {
    if (!message || (message.role !== 'user' && message.role !== 'assistant') || typeof message.content !== 'string') {
      throw new Error('对话草稿结构无效');
    }
  }
}

function mergedUserText(draft: LifeDraft): string {
  return [draft.body, ...draft.messages.filter((message) => message.role === 'user').map((message) => message.content)]
    .map((part) => part.trim())
    .filter(Boolean)
    .join('\n\n');
}

function bytesFromBase64(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function validateExistingAttachment(id: number): Promise<Attachment> {
  const attachment = await db.attachments.get(id);
  if (!attachment) throw new Error('既有照片不存在，请移除后重试');
  // 旧版生活入口曾允许 image/* 且不限制体积；编辑文字时不得因此破坏已有记录。
  if (!(attachment.blob instanceof Blob) || attachment.blob.size !== attachment.size) throw new Error('既有照片内容不完整');
  return attachment;
}

export async function getLifeDraft(key: string): Promise<LifeDraft | undefined> {
  return db.lifeDrafts.get(key);
}

export async function putLifeDraft(draft: LifeDraft): Promise<void> {
  validateLifeDraft(draft);
  await db.transaction('rw', [db.lifeDrafts, db.lifeNotes, db.lifeEditions, db.attachments, db.entryAttachments, db.settings], async () => {
    const previous = await db.lifeDrafts.get(draft.key);
    await db.lifeDrafts.put(structuredClone(draft));
    await collectUnreferencedAttachments((previous?.existingPhotoRefs ?? []).filter(id => !draft.existingPhotoRefs.includes(id)));
  });
}

export async function deleteLifeDraft(key: string): Promise<void> {
  await db.transaction('rw', [db.lifeDrafts, db.lifeNotes, db.lifeEditions, db.attachments, db.entryAttachments, db.settings], async () => {
    const draft = await db.lifeDrafts.get(key);
    await db.lifeDrafts.delete(key);
    await collectUnreferencedAttachments(draft?.existingPhotoRefs ?? []);
  });
}

/**
 * 原子保存故事、照片与可选账单关系。失败时草稿和所有既有数据保持原样。
 */
export async function saveLifeDraft(key: string): Promise<number> {
  const tables = [
    db.lifeDrafts, db.lifeNotes, db.attachments, db.entries,
    db.entryAttachments, db.settings, db.lifeEditions,
  ];
  const result = await db.transaction('rw', tables, async () => {
    const draft = await db.lifeDrafts.get(key);
    if (!draft) throw new Error('草稿不存在');
    validateLifeDraft(draft);

    const rawText = mergedUserText(draft);
    const aiText = draft.aiText?.trim() ?? '';
    if (!rawText && !aiText && draft.existingPhotoRefs.length === 0 && draft.photos.length === 0) {
      throw new Error('请先写下内容或添加照片');
    }

    const entry = draft.entryId == null ? undefined : await db.entries.get(draft.entryId);
    if (draft.entryId != null && (!entry || entry.deletedAt !== 0)) {
      throw new Error('关联账单不存在或已删除，请先解除关联');
    }

    const existing = draft.noteId == null ? undefined : await db.lifeNotes.get(draft.noteId);
    if (draft.noteId != null && (!existing || existing.deletedAt !== 0)) {
      throw new Error('生活记录不存在或已删除');
    }
    if (existing?.kind === 'habit') throw new Error('习惯打卡不能在故事编辑器中修改');
    if (existing && draft.sourceUpdatedAt != null && existing.updatedAt !== draft.sourceUpdatedAt) {
      throw new Error('原记录已有更新，草稿已保留。请复制想保留的文字，丢弃旧草稿后重新打开');
    }

    const originalRefs = new Set(existing?.photoRefs ?? []);
    if (draft.existingPhotoRefs.some((id) => !originalRefs.has(id))) {
      throw new Error('既有照片不属于当前记录，请重新打开后再试');
    }

    await Promise.all(draft.existingPhotoRefs.map(validateExistingAttachment));
    const newPhotoRefs: number[] = [];
    for (const photo of draft.photos) {
      const parsed = validatePhoto(photo);
      const blob = new Blob([bytesFromBase64(parsed.base64)], { type: parsed.mime });
      newPhotoRefs.push(await db.attachments.add(stamp({
        mime: parsed.mime, name: photo.name || undefined, size: parsed.size, blob,
      }) as Attachment));
    }
    const photoRefs = [...draft.existingPhotoRefs, ...newPhotoRefs];
    const body = aiText || rawText || undefined;
    const originalBody = aiText ? rawText : undefined;
    const changedAt = now();
    let noteId: number;
    if (existing) {
      noteId = existing.id;
      await db.lifeNotes.put({
        ...existing,
        title: draft.title.trim() || undefined,
        body,
        originalBody,
        occurredAt: draft.occurredAt,
        photoRefs: photoRefs.length ? photoRefs : undefined,
        mood: draft.mood?.trim() || undefined,
        tags: draft.tags?.map((tag) => tag.trim()).filter(Boolean),
        review: draft.review,
        aiExcluded: draft.aiExcluded,
        updatedAt: changedAt,
      });
    } else {
      noteId = await db.lifeNotes.add(stamp({
        kind: rawText || aiText ? 'diary' : 'photo',
        title: draft.title.trim() || undefined,
        body,
        originalBody,
        occurredAt: draft.occurredAt,
        photoRefs: photoRefs.length ? photoRefs : undefined,
        mood: draft.mood?.trim() || undefined,
        tags: draft.tags?.map((tag) => tag.trim()).filter(Boolean),
        review: draft.review,
        aiExcluded: draft.aiExcluded,
        deletedAt: 0,
      }) as LifeNote);
    }

    if (entry) await db.entries.update(entry.id, { lifeNoteId: noteId, updatedAt: changedAt });
    const removedRefs = (existing?.photoRefs ?? []).filter((id) => !photoRefs.includes(id));
    await db.lifeDrafts.delete(key);
    await collectUnreferencedAttachments(removedRefs);
    emit('life-changed', { id: noteId, draftKey: key });
    if (entry) emit('entries-changed', { id: entry.id });
    return noteId;
  });
  return result;
}
