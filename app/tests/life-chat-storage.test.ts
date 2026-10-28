import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Dexie from 'dexie';
import { db } from '../src/core/db';
import type { LifeDraft, LifeNote } from '../src/core/types';
import { deleteLifeDraft, getLifeDraft, listLifeChatSessions, putLifeDraft, saveLifeDraft } from '../src/core/repo/lifeDraftRepo';
import { addLifeNote, getLifeNote, updateLifeNote } from '../src/core/repo/lifeRepo';
import { exportAll, restoreAll } from '../src/core/repo/backupRepo';
import { stageChatDraft, unsavedChatDrafts } from '../src/features/life/lifeChatSession';
import { buildSkbak, parseSkbak } from '../src/features/backup/skbak';

const makeDraft = (key: string, time = 1): LifeDraft => ({ key, title: '', body: '', occurredAt: time, chatUpdatedAt: time,
  existingPhotoRefs: [], photos: [], messages: [{ role: 'user', content: `虚构会话 ${key}` }], aiExcluded: false });
beforeEach(async () => {
  vi.restoreAllMocks(); unsavedChatDrafts.clear(); await db.delete(); await db.open();
  // Node 没有浏览器 FileReader；JSZip 仍读真实 Blob 字节。
  vi.stubGlobal('FileReader', class {
    onload?: (event: { target: { result: ArrayBuffer } }) => void;
    onerror?: (event: { target: { error: unknown } }) => void;
    readAsArrayBuffer(blob: Blob) { void blob.arrayBuffer().then(result => this.onload?.({ target: { result } }), error => this.onerror?.({ target: { error } })); }
  });
});
afterEach(() => vi.unstubAllGlobals());

it('聊天历史按索引分页，不读取任何会话正文，时间相同也不重复或漏项', async () => {
  for (let i = 0; i < 8; i++) await putLifeDraft(makeDraft(`chat:${i}`, i % 2));
  for (let i = 0; i < 7; i++) await db.lifeNotes.add({ kind: 'diary', title: `虚构保存 ${i}`, body: '很长正文'.repeat(1000),
    occurredAt: 1, createdAt: 1, updatedAt: i % 2, deletedAt: 0, conversation: [{ role: 'user', content: '很长会话'.repeat(1000) }] } as LifeNote);
  const drafts = vi.spyOn(db.lifeDrafts, 'toArray'), notes = vi.spyOn(db.lifeNotes, 'toArray');
  const rows = [];
  let before;
  for (let page = 0; page < 6; page++) {
    const part = await listLifeChatSessions({ limit: 3, before });
    expect(part.length).toBeLessThanOrEqual(3);
    rows.push(...part); before = part.at(-1);
    if (!part.length) break;
  }
  expect(rows).toHaveLength(15);
  expect(new Set(rows.map(row => row.key)).size).toBe(15);
  expect(drafts).not.toHaveBeenCalled(); expect(notes).not.toHaveBeenCalled();
  expect((await listLifeChatSessions({ limit: 1, draftsOnly: true }))[0].saved).toBe(false);
  expect((await listLifeChatSessions({ limit: 2, query: '保存 3' })).map(row => row.title)).toEqual(['虚构保存 3']);
});

it('存入聊天照片后只保存附件引用，文字编辑不重复解码或创建附件', async () => {
  const source = makeDraft('chat:photos');
  source.photos.push({ name: '虚构.png', dataUrl: 'data:image/png;base64,AQID' });
  await putLifeDraft(source);
  const saved = (await getLifeDraft(source.key))!;
  expect(saved.photos[0].dataUrl).toBe('');
  expect(saved.photos[0].attachmentId).toBeGreaterThan(0);
  const decode = vi.spyOn(globalThis, 'atob');
  saved.pendingReply = '新的文字'; await putLifeDraft(saved);
  expect(decode).not.toHaveBeenCalled(); expect(await db.attachments.count()).toBe(1);
  const archive = await exportAll();
  const packageFile = await buildSkbak(archive);
  await restoreAll((await parseSkbak(await packageFile.arrayBuffer())).dump);
  const restored = (await getLifeDraft(source.key))!;
  expect((await db.attachments.get(restored.photos[0].attachmentId!))?.blob.size).toBe(3);
  const noteId = await saveLifeDraft(source.key);
  expect((await getLifeNote(noteId))?.photoRefs).toEqual([restored.photos[0].attachmentId]);
  expect(await db.attachments.count()).toBe(1);
});

it('新版备份拒绝缺失的聊天附件，旧版内联照片恢复后仍可使用', async () => {
  const legacy = makeDraft('chat:old-backup');
  legacy.photos.push({ name: '旧图.png', dataUrl: 'data:image/png;base64,AQID' });
  const oldDump = await exportAll(); oldDump.lifeDrafts.push(legacy);
  await restoreAll((await parseSkbak(await (await buildSkbak(oldDump)).arrayBuffer())).dump);
  const restored = (await getLifeDraft(legacy.key))!;
  expect(restored.photos[0].dataUrl).toContain('base64,AQID');
  await putLifeDraft(restored);
  expect(restored.photos[0].attachmentId).toBeGreaterThan(0);
  const broken = await exportAll(); broken.attachments = [];
  await expect(parseSkbak(await (await buildSkbak(broken)).arrayBuffer())).rejects.toThrow('生活草稿');
});

it('输入暂存保留最新内容且不在每个按键复制完整会话', () => {
  const source = makeDraft('chat:typing');
  source.photos.push({ name: '虚构.png', dataUrl: 'data:image/png;base64,AQID' });
  const clone = vi.spyOn(globalThis, 'structuredClone');
  for (let i = 0; i < 12; i++) { source.pendingReply = `输入 ${i}`; stageChatDraft(source); }
  expect(unsavedChatDrafts.get(source.key)?.pendingReply).toBe('输入 11');
  expect(clone).not.toHaveBeenCalled();
});

it('索引随标题、删除和恢复整库更新，恢复旧备份无需已有派生字段', async () => {
  const id = await addLifeNote({ kind: 'diary', title: '旧标题', occurredAt: 1, conversation: [{ role: 'user', content: '虚构原话' }] });
  await updateLifeNote(id, { title: '新标题' });
  expect((await listLifeChatSessions())[0].title).toBe('新标题');
  const dump = await exportAll();
  for (const row of dump.lifeNotes as any[]) { delete row.chatOrder; delete row.chatTitle; }
  await restoreAll(dump);
  expect((await listLifeChatSessions())[0].title).toBe('新标题');
  await db.lifeNotes.update(id, { deletedAt: 2 });
  expect(await listLifeChatSessions()).toEqual([]);
});

it('移除最后一份引用才回收聊天附件，失败保存不留下半份照片', async () => {
  const source = makeDraft('chat:gc');
  source.photos.push({ name: '虚构.png', dataUrl: 'data:image/png;base64,AQID' });
  await putLifeDraft(source);
  const copy = { ...(await getLifeDraft(source.key))!, key: 'chat:copy' }; await putLifeDraft(copy);
  await deleteLifeDraft(source.key); expect(await db.attachments.count()).toBe(1);
  await deleteLifeDraft(copy.key); expect(await db.attachments.count()).toBe(0);
  const broken = makeDraft('chat:rollback'); broken.photos.push({ name: '虚构.png', dataUrl: 'data:image/png;base64,AQID' });
  vi.spyOn(db.lifeDrafts, 'put').mockRejectedValueOnce(new Error('虚构写失败'));
  await expect(putLifeDraft(broken)).rejects.toThrow('虚构写失败');
  expect(await db.attachments.count()).toBe(0); expect(broken.photos[0].dataUrl).toContain('base64');
});

it('v6 数据升级生成轻量索引且不改变旧草稿内容', async () => {
  await db.delete();
  const old = new Dexie('GleamDB');
  old.version(6).stores({ lifeNotes: '++id, occurredAt, kind, deletedAt, [deletedAt+occurredAt], habitId', lifeDrafts: '&key' });
  await old.open(); await old.table('lifeDrafts').put(makeDraft('chat:legacy'));
  await old.table('lifeNotes').put({ id: 7, kind: 'diary', title: '虚构旧记录', occurredAt: 1, createdAt: 1, updatedAt: 2, deletedAt: 0, conversation: [{ role: 'user', content: '虚构旧会话' }] });
  old.close(); await db.open();
  expect((await listLifeChatSessions()).map(row => row.key)).toEqual(['chat:note:7', 'chat:legacy']);
  expect((await getLifeDraft('chat:legacy'))?.messages[0].content).toBe('虚构会话 chat:legacy');
});
