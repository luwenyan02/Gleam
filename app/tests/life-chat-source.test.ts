import 'fake-indexeddb/auto';
import { beforeEach, expect, it, vi } from 'vitest';
import { db } from '../src/core/db';
import type { LifeNote } from '../src/core/types';
import * as drafts from '../src/core/repo/lifeDraftRepo';
import { addLifeNote, getLifeNote, updateLifeNote } from '../src/core/repo/lifeRepo';
const conversation = [{ role: 'user' as const, content: '虚构原话' }, { role: 'assistant' as const, content: '虚构回复' }];
const note = (patch: Partial<LifeNote> = {}): LifeNote => ({ id: 1, kind: 'diary', title: '原标题', body: '原正文', occurredAt: 1,
  createdAt: 1, updatedAt: 1, deletedAt: 0, conversation: structuredClone(conversation), ...patch });
beforeEach(async () => { vi.restoreAllMocks(); await db.delete(); await db.open(); });

it('只读打开的旧草稿在仅标题变化后同步来源版本，保留未发送文字和失败检查点', async () => {
  const original = note();
  const draft = await drafts.newLifeChatDraft('chat:note:1', original);
  draft.pendingReply = '虚构未发送文字';
  draft.messages.push({ role: 'user', content: '虚构追加问题' });
  draft.chatReply = { messageIndex: 2, status: 'failed', regenerate: false, content: '已收到的片段' };
  const latest = note({ title: '新标题', updatedAt: 2 });
  expect(await drafts.reconcileLifeChatDraft(draft, latest)).toBe('ready');
  expect(draft.sourceUpdatedAt).toBe(2); expect(draft.pendingReply).toBe('虚构未发送文字');
  expect(draft.chatReply?.content).toBe('已收到的片段'); expect(draft.messages).toHaveLength(3);
});

it('确实没有用户增量的草稿可更新原会话和照片；已有增量时冲突原样保留', async () => {
  const original = note();
  const readonly = await drafts.newLifeChatDraft('chat:note:1', original);
  const latest = note({ updatedAt: 2, photoRefs: [7], conversation: [...conversation, { role: 'user', content: '另一处新增' }] });
  expect(await drafts.reconcileLifeChatDraft(readonly, latest)).toBe('ready');
  expect(readonly.messages).toEqual(latest.conversation); expect(readonly.existingPhotoRefs).toEqual([7]);
  for (const change of [
    { pendingReply: '不能丢的输入' }, { photos: [{ name: '图.png', dataUrl: 'data:image/png;base64,AQID' }] },
    { messages: [...conversation, { role: 'user' as const, content: '不能丢的新问题' }] },
    { summaryProposal: { title: '手工摘要', body: '不能丢的编辑', tags: [], sourceMessageCount: 2 } },
  ]) {
    const edited = Object.assign(await drafts.newLifeChatDraft('chat:note:1', original), change);
    const before = structuredClone(edited);
    expect(await drafts.reconcileLifeChatDraft(edited, latest)).toBe('conflict');
    expect(edited).toEqual(before);
  }
});

it('旧版没有基线的草稿仅在当前原会话与照片一致时自动恢复', async () => {
  const draft = { key: 'chat:note:1', noteId: 1, sourceUpdatedAt: 1, title: '', body: '', occurredAt: 1,
    existingPhotoRefs: [], photos: [], messages: structuredClone(conversation), aiExcluded: false };
  expect(await drafts.reconcileLifeChatDraft(draft, note({ updatedAt: 2 }))).toBe('ready');
  expect(draft.sourceUpdatedAt).toBe(2);
  const conflict = { ...draft, chatSource: undefined, sourceUpdatedAt: 1, messages: [{ role: 'user' as const, content: '另一段原话' }] };
  expect(await drafts.reconcileLifeChatDraft(conflict, note({ updatedAt: 2 }))).toBe('conflict');
});

it('活动请求不切换基线，删除和排除不能被恢复机制绕过，账本标记只增不减', async () => {
  const draft = await drafts.newLifeChatDraft('chat:note:1', note());
  expect(await drafts.reconcileLifeChatDraft(draft, note({ updatedAt: 2 }), true)).toBe('conflict');
  expect(draft.sourceUpdatedAt).toBe(1);
  expect(await drafts.reconcileLifeChatDraft(draft, note({ deletedAt: 4 }))).toBe('unavailable');
  expect(await drafts.reconcileLifeChatDraft(draft, undefined)).toBe('unavailable');
  expect(await drafts.reconcileLifeChatDraft(draft, note({ aiExcluded: true, updatedAt: 3 }))).toBe('excluded');
  expect(draft.sourceUpdatedAt).toBe(1);
  const localPrivate = await drafts.newLifeChatDraft('chat:note:1', note());
  localPrivate.aiExcluded = true;
  expect(await drafts.reconcileLifeChatDraft(localPrivate, note({ updatedAt: 2 }))).toBe('excluded');
  expect(localPrivate.aiExcluded).toBe(true);
  const fresh = await drafts.newLifeChatDraft('chat:note:1', note());
  const marked = note({ updatedAt: 2, conversation: [{ ...conversation[0], ledgerAnalysis: true }, conversation[1]] });
  expect(await drafts.reconcileLifeChatDraft(fresh, marked)).toBe('ready');
  expect(fresh.messages[0].ledgerAnalysis).toBe(true);
});

it('元数据同步不覆盖用户已改日期或回访，且采用最新隐私设置', async () => {
  const draft = await drafts.newLifeChatDraft('chat:note:1', note({ review: { text: '旧回访' } }));
  draft.review = { text: '用户新回访' }; draft.occurredAt = 7;
  expect(await drafts.reconcileLifeChatDraft(draft, note({ updatedAt: 3, occurredAt: 4, review: { text: '另一处回访' } }))).toBe('ready');
  expect(draft.review?.text).toBe('用户新回访'); expect(draft.occurredAt).toBe(7);
});

it('真实冲突先原子保存完整副本再重新载入；写失败不删旧草稿', async () => {
  const id = await addLifeNote({ kind: 'diary', title: '原标题', occurredAt: 1, conversation });
  const draft = await drafts.newLifeChatDraft(`chat:note:${id}`, (await getLifeNote(id))!);
  draft.pendingReply = '未发送'; draft.photos.push({ name: '图.png', dataUrl: 'data:image/png;base64,AQID' });
  await drafts.putLifeDraft(draft);
  await updateLifeNote(id, { conversation: [{ role: 'user', content: '新原会话' }] });
  const fail = vi.spyOn(db.lifeDrafts, 'put').mockRejectedValueOnce(new Error('虚构存储失败'));
  await expect(drafts.recoverLifeChatDraft(draft)).rejects.toThrow('虚构存储失败');
  expect((await drafts.getLifeDraft(draft.key))?.pendingReply).toBe('未发送'); fail.mockRestore();
  const recovered = await drafts.recoverLifeChatDraft(draft);
  expect(recovered.draft.messages[0].content).toBe('新原会话');
  const copy = (await drafts.getLifeDraft(recovered.recoveredKey))!;
  expect(copy.pendingReply).toBe('未发送'); expect(copy.noteId).toBe(id);
  expect(copy.photos[0].attachmentId).toBe(draft.photos[0].attachmentId);
  expect(await db.attachments.count()).toBe(1); expect(await drafts.getLifeDraft(draft.key)).toBeUndefined();
});

it('原会话缩短时只有无增量草稿可以重载，有待发送内容或旧无基线时不能把移除内容发送出去', async () => {
  const original = note({ conversation: [...conversation, { role: 'user', content: '后来已移除的问题' }, { role: 'assistant', content: '后来已移除的回答' }] });
  const shorter = note({ updatedAt: 2 });
  const readonly = await drafts.newLifeChatDraft('chat:note:1', original);
  expect(await drafts.reconcileLifeChatDraft(readonly, shorter)).toBe('ready');
  expect(readonly.messages).toEqual(conversation);
  const edited = await drafts.newLifeChatDraft('chat:note:1', original);
  edited.pendingReply = '新的本地文字';
  expect(await drafts.reconcileLifeChatDraft(edited, shorter)).toBe('conflict');
  expect(edited.sourceUpdatedAt).toBe(1); expect(edited.messages).toHaveLength(4);
  const legacy = { ...edited, chatSource: undefined };
  expect(await drafts.reconcileLifeChatDraft(legacy, shorter)).toBe('conflict');
  expect(legacy.pendingReply).toBe('新的本地文字');
});

it('来源临时排除再恢复不会把继承的排除写成本地永久排除', async () => {
  const source = await drafts.newLifeChatDraft('chat:note:1', note());
  expect(await drafts.reconcileLifeChatDraft(source, note({ updatedAt: 2, aiExcluded: true }))).toBe('excluded');
  expect(await drafts.reconcileLifeChatDraft(source, note({ updatedAt: 3, aiExcluded: false }))).toBe('ready');
  expect(source.aiExcluded).toBe(false); expect(source.sourceUpdatedAt).toBe(3);
});

it('只读来源重排后仍保留相同文字已有的账本隐私标记', async () => {
  const draft = await drafts.newLifeChatDraft('chat:note:1', note());
  draft.messages[0].ledgerAnalysis = true;
  const changed = note({ updatedAt: 2, conversation: [{ role: 'user', content: '来源新增开头' }, ...conversation] });
  expect(await drafts.reconcileLifeChatDraft(draft, changed)).toBe('ready');
  expect(draft.messages[1].ledgerAnalysis).toBe(true);
});
