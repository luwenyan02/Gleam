import { db } from '../db';
import { addEntry, updateEntry, type NewEntry } from './entryRepo';
import { addAttachment, addLifeNote, type NewLifeNote } from './lifeRepo';
import { touchMerchant } from './merchantRepo';
import { setEntryAttachments } from './entryAttachmentRepo';

export interface EntrySaveRequest {
  editingId?: number;
  entry: NewEntry;
  tagIds: number[];
  originalMerchantId?: number;
  lifeNote?: NewLifeNote;
  attachmentIds?: number[];
  /** 新图片只在内存中暂存，直到与账单一起提交。数组顺序即显示顺序。 */
  receipts?: Array<{ id: number } | { blob: Blob; name?: string; thumbnail?: string }>;
}

/** 账单及附属写入同成同败，避免“保存失败”后重试导致双份账单/孤立日记。 */
export interface EntrySaveResult {
  result: 'created' | 'updated';
  entryId: number;
}

export async function saveEntryWithContext(request: EntrySaveRequest): Promise<EntrySaveResult> {
  return db.transaction('rw', [db.entries, db.accounts, db.entryTags, db.lifeNotes, db.merchants, db.entryAttachments, db.attachments, db.settings, db.lifeDrafts, db.lifeEditions], async () => {
    const entry = { ...request.entry };
    let attachmentIds = request.attachmentIds;
    if (request.receipts !== undefined) {
      attachmentIds = [];
      for (const receipt of request.receipts) {
        attachmentIds.push('id' in receipt ? receipt.id : await addAttachment(receipt.blob, receipt.name, receipt.thumbnail));
      }
    }
    if (request.lifeNote) entry.lifeNoteId = await addLifeNote(request.lifeNote);
    if (request.editingId != null) {
      const old = await db.entries.get(request.editingId);
      await updateEntry(request.editingId, entry, request.tagIds);
      if (attachmentIds !== undefined) await setEntryAttachments(request.editingId, attachmentIds);
      if (entry.merchantId != null && entry.merchantId !== old?.merchantId) await touchMerchant(entry.merchantId);
      return { result: 'updated' as const, entryId: request.editingId };
    }
    const entryId = await addEntry(entry, request.tagIds);
    if (attachmentIds !== undefined) await setEntryAttachments(entryId, attachmentIds);
    if (entry.merchantId != null) await touchMerchant(entry.merchantId);
    return { result: 'created' as const, entryId };
  });
}
