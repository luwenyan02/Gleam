import { db, now, stamp } from '../db';
import type { Attachment, LifeChatMessage, LifeDraft, LifeDraftPhoto, LifeNote } from '../types';
import { emitAfterCommit as emit } from './transactionEvents';
import { collectUnreferencedAttachments, MAX_ENTRY_ATTACHMENTS, MAX_RECEIPT_BYTES } from './entryAttachmentRepo';

const DATA_URL_RE = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]*={0,2})$/;

/**
 * 把旧版对话草稿转为“原始会话 + 独立摘要方案”。
 * 返回新副本，可重复调用，不修改入参。
 */
export function migrateLifeDraft(input: unknown): LifeDraft {
  validateLifeDraft(input);
  const draft = structuredClone(input);
  const hasLegacyChat = draft.messages.length > 0 || draft.aiText != null || draft.summaryProposal != null;
  if (!hasLegacyChat) return draft;

  const legacyBody = draft.body.trim();
  if (legacyBody && !(draft.messages[0]?.role === 'user' && draft.messages[0].content.trim() === legacyBody)) {
    draft.messages.unshift({ role: 'user', content: legacyBody });
    draft.originalBody = legacyBody;
    draft.migratedBodyMessage = legacyBody;
  }
  draft.body = '';

  const legacySummary = draft.aiText?.trim();
  if (legacySummary && !draft.summaryProposal) {
    draft.summaryProposal = {
      title: draft.title.trim(),
      body: legacySummary,
      mood: draft.mood?.trim() || undefined,
      tags: [...(draft.tags ?? [])],
      sourceMessageCount: draft.messages.length,
    };
  }
  if (legacySummary || draft.summaryProposal) {
    draft.title = '';
    draft.mood = undefined;
    draft.tags = undefined;
    draft.aiText = undefined;
  }
  return draft;
}

/** 旧版“记录表单内聊两句”草稿须从快速记录入口分离出来。 */
export function isLifeChatDraft(draft: LifeDraft | undefined): boolean {
  return !!draft && (draft.messages.length > 0 || draft.aiText != null || draft.summaryProposal != null || !!draft.pendingReply?.trim());
}

/** 首次进入新版聊天时认领旧 key 下的混合草稿；普通快速记录草稿不移动。 */
export async function claimLegacyLifeChatDraft(targetKey: string, legacyKeys: string[]): Promise<LifeDraft | undefined> {
  return db.transaction('rw', db.lifeDrafts, async () => {
    const current = await db.lifeDrafts.get(targetKey);
    let claimed = current ? migrateLifeDraft(current) : undefined;
    for (const key of legacyKeys) {
      if (key === targetKey) continue;
      const legacy = await db.lifeDrafts.get(key);
      if (!isLifeChatDraft(legacy)) continue;
      const migrated = migrateLifeDraft(legacy);
      if (claimed) {
        const currentClaimed = claimed;
        const claimedIsPrefix = migrated.messages.length >= currentClaimed.messages.length
          && currentClaimed.messages.every((message, index) => sameMessage(message, migrated.messages[index]));
        const migratedIsPrefix = currentClaimed.messages.length >= migrated.messages.length
          && migrated.messages.every((message, index) => sameMessage(message, currentClaimed.messages[index]));
        currentClaimed.messages = claimedIsPrefix ? structuredClone(preserveLedgerMarkers(migrated.messages, currentClaimed.messages))
          : migratedIsPrefix ? preserveLedgerMarkers(currentClaimed.messages, migrated.messages)
            : [...currentClaimed.messages, ...structuredClone(migrated.messages)];
        claimed.summaryProposal ??= migrated.summaryProposal;
        claimed.pendingReply ||= migrated.pendingReply;
        claimed.entryId ??= migrated.entryId;
        claimed.existingPhotoRefs = [...new Set([...claimed.existingPhotoRefs, ...migrated.existingPhotoRefs])];
        const seenPhotos = new Set(claimed.photos.map(photo => photo.dataUrl));
        claimed.photos.push(...migrated.photos.filter(photo => !seenPhotos.has(photo.dataUrl)));
      } else {
        claimed = migrated;
      }
      claimed.key = targetKey;
      validateLifeDraft(claimed);
      await db.lifeDrafts.put(structuredClone(claimed));
      await db.lifeDrafts.delete(key);
    }
    return claimed;
  });
}

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

export function validateLifeDraft(input: unknown): asserts input is LifeDraft {
  const draft = input as LifeDraft;
  if (!draft || typeof draft.key !== 'string' || !draft.key.trim()) throw new Error('草稿 key 无效');
  if (typeof draft.title !== 'string' || typeof draft.body !== 'string') throw new Error('草稿文字无效');
  if (!Number.isFinite(draft.occurredAt)) throw new Error('草稿发生时间无效');
  if (draft.chatUpdatedAt != null && !Number.isFinite(draft.chatUpdatedAt)) throw new Error('会话更新时间无效');
  if (draft.sourceUpdatedAt != null && !Number.isFinite(draft.sourceUpdatedAt)) throw new Error('草稿来源版本无效');
  if (typeof draft.aiExcluded !== 'boolean' || [draft.aiText, draft.pendingReply, draft.mood, draft.originalBody, draft.migratedBodyMessage].some(value => value != null && typeof value !== 'string')) throw new Error('草稿可选字段无效');
  if (draft.tags != null && (!Array.isArray(draft.tags) || draft.tags.some(tag => typeof tag !== 'string'))) throw new Error('草稿标签无效');
  if (!Array.isArray(draft.existingPhotoRefs) || !Array.isArray(draft.photos) || !Array.isArray(draft.messages)) {
    throw new Error('草稿结构无效');
  }
  if (draft.summaryProposal != null) {
    const proposal = draft.summaryProposal;
    if (typeof proposal !== 'object'
      || typeof proposal.title !== 'string'
      || typeof proposal.body !== 'string'
      || !proposal.body.trim()
      || (proposal.mood != null && typeof proposal.mood !== 'string')
      || !Array.isArray(proposal.tags)
      || proposal.tags.some(tag => typeof tag !== 'string')
      || !Number.isSafeInteger(proposal.sourceMessageCount)
      || proposal.sourceMessageCount < 0
      || proposal.sourceMessageCount > draft.messages.length) {
      throw new Error('草稿摘要方案无效');
    }
  }
  if (draft.review != null && (typeof draft.review !== 'object'
    || (draft.review.verdict != null && !['again', 'neutral', 'not-for-me'].includes(draft.review.verdict))
    || (draft.review.text != null && typeof draft.review.text !== 'string')
    || [draft.review.revisitAt, draft.review.dismissedAt].some(value => value != null && !Number.isFinite(value)))) throw new Error('回访内容无效');
  if (draft.noteId != null && (!Number.isSafeInteger(draft.noteId) || draft.noteId <= 0)) throw new Error('生活记录编号无效');
  if (draft.entryId != null && (!Number.isSafeInteger(draft.entryId) || draft.entryId <= 0)) throw new Error('账单编号无效');
  const refs = new Set(draft.existingPhotoRefs);
  if (refs.size !== draft.existingPhotoRefs.length
    || draft.existingPhotoRefs.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error('既有照片引用无效');
  }
  const chatPhotos = draft.messages.flatMap(message => message.photos ?? []);
  if (draft.existingPhotoRefs.length + draft.photos.length + chatPhotos.length > MAX_ENTRY_ATTACHMENTS) {
    throw new Error(`每篇故事最多 ${MAX_ENTRY_ATTACHMENTS} 张照片`);
  }
  for (const photo of draft.photos) validatePhoto(photo);
  for (const message of draft.messages) {
    if (!message || (message.role !== 'user' && message.role !== 'assistant') || typeof message.content !== 'string') {
      throw new Error('对话草稿结构无效');
    }
    if (message.ledgerAnalysis != null && typeof message.ledgerAnalysis !== 'boolean') throw new Error('账本分析标记无效');
    if (message.photos != null && !Array.isArray(message.photos)) throw new Error('对话照片结构无效');
    for (const photo of message.photos ?? []) validatePhoto(photo);
    if (message.photoRefs != null && (!Array.isArray(message.photoRefs)
      || new Set(message.photoRefs).size !== message.photoRefs.length
      || message.photoRefs.some(id => !Number.isSafeInteger(id) || id <= 0 || !refs.has(id)))) {
      throw new Error('对话照片引用无效');
    }
  }
}

function mergedUserText(draft: LifeDraft): string {
  return [draft.body, ...draft.messages.filter((message) => message.role === 'user').map((message) => message.content)]
    .map((part) => part.trim())
    .filter(Boolean)
    .join('\n\n');
}

function sameMessage(left: LifeChatMessage, right: LifeChatMessage): boolean {
  return left.role === right.role && left.content === right.content
    && JSON.stringify(left.photoRefs ?? []) === JSON.stringify(right.photoRefs ?? []);
}

/** 去重/迁移可以补齐旧内容，但不能抹去相同消息已有的财务隐私标记。 */
function preserveLedgerMarkers(preferred: LifeChatMessage[], known: LifeChatMessage[]): LifeChatMessage[] {
  return preferred.map((message, index) => known[index]?.ledgerAnalysis && sameMessage(message, known[index])
    ? { ...message, ledgerAnalysis: true } : message);
}

function mergeConversation(
  existing: LifeChatMessage[] | undefined,
  storedMessages: LifeChatMessage[],
  migratedMessages: LifeChatMessage[],
  migratedBodyMessage: string | undefined,
): LifeChatMessage[] | undefined {
  if (!existing?.length) return migratedMessages.length ? structuredClone(migratedMessages) : undefined;
  const existingUserText = existing
    .filter((message) => message.role === 'user')
    .map((message) => message.content.trim())
    .filter(Boolean)
    .join('\n\n');
  const messages = migratedBodyMessage
    && migratedMessages[0]?.role === 'user'
    && migratedMessages[0].content === migratedBodyMessage
    && existingUserText === migratedBodyMessage
    ? migratedMessages.slice(1)
    : migratedMessages;
  const containsExistingPrefix = messages.length >= existing.length
    && existing.every((message, index) => sameMessage(message, messages[index]));
  if (containsExistingPrefix) return structuredClone(preserveLedgerMarkers(messages, existing));
  const storedContainsExistingPrefix = storedMessages.length >= existing.length
    && existing.every((message, index) => sameMessage(message, storedMessages[index]));
  if (storedContainsExistingPrefix) return structuredClone(preserveLedgerMarkers(storedMessages, existing));
  if (!messages.length) return structuredClone(existing);
  return structuredClone([...existing, ...messages]);
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

export interface LifeChatSession { key: string; title: string; updatedAt: number; noteId?: number; saved: boolean; }

/** 普通快速记录不混入聊天；已保存会话仍可从历史继续。 */
export async function listLifeChatSessions(): Promise<LifeChatSession[]> {
  const [drafts, notes] = await Promise.all([db.lifeDrafts.toArray(), db.lifeNotes.toArray()]);
  const chats = drafts.filter(draft => draft.key.startsWith('chat:') && (isLifeChatDraft(draft) || draft.photos.length));
  const sessions: LifeChatSession[] = chats.map(draft => ({ key: draft.key, noteId: draft.noteId,
    title: draft.messages.find(message => message.role === 'user')?.content.slice(0, 80) || draft.pendingReply?.slice(0, 80) || '照片里的片刻',
    updatedAt: draft.chatUpdatedAt ?? draft.occurredAt, saved: false }));
  for (const note of notes) {
    if (note.deletedAt || !note.conversation?.length || chats.some(draft => draft.noteId === note.id)) continue;
    sessions.push({ key: `chat:note:${note.id}`, noteId: note.id, title: note.title || note.conversation[0].content.slice(0, 80), updatedAt: note.updatedAt, saved: true });
  }
  return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
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
    const storedDraft = await db.lifeDrafts.get(key);
    if (!storedDraft) throw new Error('草稿不存在');
    validateLifeDraft(storedDraft);
    const draft = migrateLifeDraft(storedDraft);

    const rawText = mergedUserText(draft);
    const proposal = draft.summaryProposal;
    const proposedBody = proposal?.body.trim() ?? '';
    if (!rawText && !proposedBody && draft.existingPhotoRefs.length === 0 && draft.photos.length === 0) {
      throw new Error('请先写下内容或添加照片');
    }

    const entry = draft.entryId == null ? undefined : await db.entries.get(draft.entryId);
    if (draft.entryId != null && (!entry || entry.deletedAt !== 0)) {
      throw new Error('关联账单已不存在或已删除，草稿已保留');
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
    const addPhoto = async (photo: LifeDraftPhoto): Promise<number> => {
      const parsed = validatePhoto(photo);
      const blob = new Blob([bytesFromBase64(parsed.base64)], { type: parsed.mime });
      return db.attachments.add(stamp({
        mime: parsed.mime, name: photo.name || undefined, size: parsed.size, blob,
      }) as Attachment);
    };
    const newPhotoRefs: number[] = [];
    for (const photo of draft.photos) newPhotoRefs.push(await addPhoto(photo));
    const persistedMessages: LifeChatMessage[] = [];
    for (const message of draft.messages) {
      const messageRefs = [...(message.photoRefs ?? [])];
      for (const photo of message.photos ?? []) {
        const ref = await addPhoto(photo);
        messageRefs.push(ref);
        newPhotoRefs.push(ref);
      }
      persistedMessages.push({
        role: message.role,
        content: message.content,
        ...(message.repliedAt != null ? { repliedAt: message.repliedAt } : {}),
        ...(message.ledgerAnalysis ? { ledgerAnalysis: true } : {}),
        ...(messageRefs.length ? { photoRefs: messageRefs } : {}),
      });
    }
    const photoRefs = [...draft.existingPhotoRefs, ...newPhotoRefs];
    const body = proposedBody || rawText || undefined;
    const originalBody = proposal ? rawText : undefined;
    const title = (proposal?.title ?? draft.title).trim() || undefined;
    const mood = (proposal?.mood ?? draft.mood)?.trim() || undefined;
    const tags = (proposal?.tags ?? draft.tags)?.map((tag) => tag.trim()).filter(Boolean);
    const changedAt = now();
    let noteId: number;
    const persistedStoredMessages = draft.migratedBodyMessage && persistedMessages.length === storedDraft.messages.length + 1
      ? persistedMessages.slice(1)
      : persistedMessages;
    const conversation = mergeConversation(existing?.conversation, persistedStoredMessages, persistedMessages, draft.migratedBodyMessage);
    if (existing) {
      noteId = existing.id;
      await db.lifeNotes.put({
        ...existing,
        title,
        body,
        originalBody,
        conversation,
        occurredAt: draft.occurredAt,
        photoRefs: photoRefs.length ? photoRefs : undefined,
        mood,
        tags,
        review: draft.review,
        aiExcluded: draft.aiExcluded,
        updatedAt: changedAt,
      });
    } else {
      noteId = await db.lifeNotes.add(stamp({
        kind: rawText || proposedBody ? 'diary' : 'photo',
        title,
        body,
        originalBody,
        conversation,
        occurredAt: draft.occurredAt,
        photoRefs: photoRefs.length ? photoRefs : undefined,
        mood,
        tags,
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
