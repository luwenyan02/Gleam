import 'fake-indexeddb/auto';
import { beforeEach, expect, it, vi } from 'vitest';
import { db } from '../src/core/db';
import { addAccount } from '../src/core/repo/accountRepo';
import { addEntry, softDeleteEntry } from '../src/core/repo/entryRepo';
import { addLifeNote } from '../src/core/repo/lifeRepo';
import { countLocalStats, exportAll } from '../src/core/repo/backupRepo';

beforeEach(async () => { await db.delete(); await db.open(); });

it('备份概览区分有效与回收站账单，包含隐藏账户，只统计有效生活记录', async () => {
  const accountId = await addAccount({ name: '虚构现金', group: 'cash', balance: 0 });
  await addAccount({ name: '虚构隐藏账户', group: 'other', balance: 0, hidden: true });
  await addEntry({ type: 'expense', amount: 100, accountId, occurredAt: 1 });
  const deletedId = await addEntry({ type: 'income', amount: 200, accountId, occurredAt: 2 });
  await softDeleteEntry(deletedId);
  await addLifeNote({ kind: 'diary', body: '虚构生活记录', occurredAt: 1 });
  const deletedNoteId = await addLifeNote({ kind: 'diary', body: '虚构回收站记录', occurredAt: 1 });
  await db.lifeNotes.update(deletedNoteId, { deletedAt: 2 });
  const before = await exportAll();
  // 概览不能为数条关联行而读取附件 Blob 或把标签误算成账单。
  const attachmentReads = vi.spyOn(db.attachments, 'toArray');
  expect(await countLocalStats()).toEqual({ liveEntries: 1, deletedEntries: 1, accounts: 2, liveLifeNotes: 1 });
  expect(attachmentReads).not.toHaveBeenCalled();
  attachmentReads.mockRestore();
  expect(await exportAll()).toEqual(before);
});

it('增加标签、附件关系和设置不会改变概览中的业务数量', async () => {
  const accountId = await addAccount({ name: '虚构现金', group: 'cash', balance: 0 });
  const entryId = await addEntry({ type: 'expense', amount: 100, accountId, occurredAt: 1 });
  const before = await countLocalStats();
  await db.entryTags.bulkAdd([{ entryId, tagId: 1 }, { entryId, tagId: 2 }]);
  await db.entryAttachments.add({ entryId, attachmentId: 1, sortOrder: 0 });
  await db.settings.put({ key: 'test.summary', value: '虚构设置', updatedAt: 1 });
  expect(await countLocalStats()).toEqual(before);
});
