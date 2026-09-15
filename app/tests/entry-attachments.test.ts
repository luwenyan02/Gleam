import 'fake-indexeddb/auto';
import { beforeEach, expect, it } from 'vitest';
import { db } from '../src/core/db';
import { addAccount } from '../src/core/repo/accountRepo';
import { addEntry, softDeleteEntry, restoreEntry, purgeEntry } from '../src/core/repo/entryRepo';
import { saveEntryWithContext } from '../src/core/repo/entrySaveRepo';
import { setEntryAttachments, listEntryAttachments } from '../src/core/repo/entryAttachmentRepo';
import { addAttachment, addLifeNote, softDeleteLifeNote, purgeLifeNote } from '../src/core/repo/lifeRepo';
import { addAiPendingItems, removeAiPendingItems } from '../src/core/repo/aiRepo';

let accountId: number;
const input = () => ({ type: 'expense' as const, amount: 100, accountId, occurredAt: 1000 });
const photo = () => addAttachment(new Blob(['fictional receipt'], { type: 'image/png' }), 'demo.png');
beforeEach(async () => {
  await db.delete(); await db.open();
  accountId = await addAccount({ name: '虚构现金', group: 'cash', balance: 10000 });
});

it('附件映射按顺序保存、重复引用去重，软删除恢复保留凭证', async () => {
  const entryId = await addEntry(input());
  const a = await photo(), b = await photo();
  await setEntryAttachments(entryId, [b, a, b]);
  expect((await listEntryAttachments(entryId)).map(x => x.id)).toEqual([b, a]);
  await softDeleteEntry(entryId); await restoreEntry(entryId);
  expect((await listEntryAttachments(entryId)).map(x => x.id)).toEqual([b, a]);
});

it('非法附件导致账单与余额一起回滚', async () => {
  await expect(saveEntryWithContext({ entry: input(), tagIds: [], attachmentIds: [999] })).rejects.toThrow('附件');
  expect(await db.entries.count()).toBe(0);
  expect((await db.accounts.get(accountId))?.balance).toBe(10000);
});

it('永久删除仅回收无其他账单、生活或 AI 队列引用的附件', async () => {
  const a = await photo(), b = await photo();
  const first = await addEntry(input()), second = await addEntry(input());
  await setEntryAttachments(first, [a, b]); await setEntryAttachments(second, [a]);
  const note = await addLifeNote({ kind: 'photo', occurredAt: 1000, photoRefs: [b] });
  await softDeleteEntry(first); await purgeEntry(first);
  expect(await db.attachments.count()).toBe(2);
  await softDeleteLifeNote(note); await purgeLifeNote(note);
  expect(await db.attachments.get(b)).toBeUndefined();
  expect(await db.attachments.get(a)).toBeDefined();
  await softDeleteEntry(second); await purgeEntry(second);
  expect(await db.attachments.count()).toBe(0);
  expect(await db.entryAttachments.count()).toBe(0);
});

it('生活照片清理保护仍被账单引用的凭证', async () => {
  const a = await photo(), entryId = await addEntry(input());
  await setEntryAttachments(entryId, [a]);
  const note = await addLifeNote({ kind: 'photo', occurredAt: 1000, photoRefs: [a] });
  await softDeleteLifeNote(note); await purgeLifeNote(note);
  expect(await db.attachments.get(a)).toBeDefined();
});

it('清理 AI 待确认素材不删除账单共享图片', async () => {
  const a = await photo(), entryId = await addEntry(input());
  await setEntryAttachments(entryId, [a]);
  await addAiPendingItems([{ tempId: 'fixture', source: 'pick', status: 'pending', attachmentId: a, createdAt: 1 }]);
  await removeAiPendingItems(['fixture']);
  expect(await db.attachments.get(a)).toBeDefined();
});

it('新凭证与账单一起保存，失败不残留图片', async () => {
  const receipt = { blob: new Blob(['fixture'], { type: 'image/png' }), name: '凭证.png' };
  await expect(saveEntryWithContext({ entry: input(), tagIds: [], receipts: [receipt, { id: 999 }] })).rejects.toThrow();
  expect(await db.attachments.count()).toBe(0);
  expect(await db.entries.count()).toBe(0);
  const saved = await saveEntryWithContext({ entry: input(), tagIds: [], receipts: [receipt] });
  expect((await listEntryAttachments(saved.entryId))[0]?.name).toBe('凭证.png');
});
