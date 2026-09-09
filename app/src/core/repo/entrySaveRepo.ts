import { db } from '../db';
import { addEntry, updateEntry, type NewEntry } from './entryRepo';
import { addLifeNote, type NewLifeNote } from './lifeRepo';
import { touchMerchant } from './merchantRepo';

export interface EntrySaveRequest {
  editingId?: number;
  entry: NewEntry;
  tagIds: number[];
  originalMerchantId?: number;
  lifeNote?: NewLifeNote;
}

/** 账单及附属写入同成同败，避免“保存失败”后重试导致双份账单/孤立日记。 */
export interface EntrySaveResult {
  result: 'created' | 'updated';
  entryId: number;
}

export async function saveEntryWithContext(request: EntrySaveRequest): Promise<EntrySaveResult> {
  return db.transaction('rw', [db.entries, db.accounts, db.entryTags, db.lifeNotes, db.merchants], async () => {
    const entry = { ...request.entry };
    if (request.lifeNote) entry.lifeNoteId = await addLifeNote(request.lifeNote);
    if (request.editingId != null) {
      const old = await db.entries.get(request.editingId);
      await updateEntry(request.editingId, entry, request.tagIds);
      if (entry.merchantId != null && entry.merchantId !== old?.merchantId) await touchMerchant(entry.merchantId);
      return { result: 'updated' as const, entryId: request.editingId };
    }
    const entryId = await addEntry(entry, request.tagIds);
    if (entry.merchantId != null) await touchMerchant(entry.merchantId);
    return { result: 'created' as const, entryId };
  });
}
