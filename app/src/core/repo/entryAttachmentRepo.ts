import { db } from '../db';
import type { Attachment, AiPendingItem } from '../types';
import { emitAfterCommit } from './transactionEvents';

export const MAX_ENTRY_ATTACHMENTS = 9;
export const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;
export const RECEIPT_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/** 调用方事务还须包含生活草稿与小报，避免回收其共享照片。 */
export async function collectUnreferencedAttachments(ids: number[]): Promise<void> {
  if (!ids.length) return;
  const life = await db.lifeNotes.toArray();
  const drafts = await db.lifeDrafts.toArray();
  const editions = await db.lifeEditions.toArray();
  const queue = (await db.settings.get('ai.pendingItems'))?.value as AiPendingItem[] | undefined;
  const protectedIds = new Set([
    ...life.flatMap(note => note.photoRefs ?? []),
    ...drafts.flatMap(draft => draft.existingPhotoRefs),
    ...editions.flatMap(edition => edition.coverAttachmentId == null ? [] : [edition.coverAttachmentId]),
    ...(queue ?? []).flatMap(item => item.attachmentId == null ? [] : [item.attachmentId]),
  ]);
  for (const id of new Set(ids)) {
    if (!protectedIds.has(id) && !(await db.entryAttachments.where('attachmentId').equals(id).count())) {
      await db.attachments.delete(id);
    }
  }
}

export async function listEntryAttachments(entryId: number): Promise<Attachment[]> {
  const links = await db.entryAttachments.where('entryId').equals(entryId).sortBy('sortOrder');
  const attachments = await db.attachments.bulkGet(links.map(link => link.attachmentId));
  return attachments.filter((attachment): attachment is Attachment => attachment != null);
}

export async function setEntryAttachments(entryId: number, attachmentIds: number[]): Promise<void> {
  const ids = [...new Set(attachmentIds)];
  if (ids.length > MAX_ENTRY_ATTACHMENTS) throw new Error(`每笔最多 ${MAX_ENTRY_ATTACHMENTS} 张凭证`);
  if (ids.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error('附件编号无效');
  await db.transaction('rw', [db.entries, db.entryAttachments, db.attachments, db.lifeNotes, db.settings, db.lifeDrafts, db.lifeEditions], async () => {
    const entry = await db.entries.get(entryId);
    if (!entry || entry.deletedAt) throw new Error('账单不存在或已删除');
    const attachments = await db.attachments.bulkGet(ids);
    for (const attachment of attachments) {
      if (!attachment) throw new Error('附件不存在');
      if (!RECEIPT_MIME_TYPES.includes(attachment.mime)) throw new Error('凭证仅支持 JPG、PNG、WebP 图片');
      if (attachment.size <= 0 || attachment.size > MAX_RECEIPT_BYTES) throw new Error('凭证图片须在 10 MB 以内');
      if (!(attachment.blob instanceof Blob) || attachment.blob.size !== attachment.size) throw new Error('附件内容不完整');
    }
    const old = await db.entryAttachments.where('entryId').equals(entryId).toArray();
    await db.entryAttachments.where('entryId').equals(entryId).delete();
    await db.entryAttachments.bulkAdd(ids.map((attachmentId, sortOrder) => ({ entryId, attachmentId, sortOrder })));
    await collectUnreferencedAttachments(old.map(link => link.attachmentId).filter(id => !ids.includes(id)));
    emitAfterCommit('entries-changed', { id: entryId });
  });
}

/** 用于永久删除账单及其退款，保留其它业务的共享引用。 */
export async function removeEntryAttachmentLinks(entryIds: number[]): Promise<void> {
  if (!entryIds.length) return;
  const links = await db.entryAttachments.where('entryId').anyOf(entryIds).toArray();
  await db.entryAttachments.where('entryId').anyOf(entryIds).delete();
  await collectUnreferencedAttachments(links.map(link => link.attachmentId));
}
