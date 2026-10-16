import 'fake-indexeddb/auto';
import { beforeEach, expect, it } from 'vitest';
import { db } from '../src/core/db';
import { saveImportAtomically, clearLedgerForImport } from '../src/core/repo/importSaveRepo';
import { addAccount } from '../src/core/repo/accountRepo';

beforeEach(async () => { await db.delete(); await db.open(); });
it('替换仅清账本与失效引用，保留生活、设置和密钥；失败完整回滚', async () => {
  await addAccount({ name: '旧账户', group: 'cash', balance: 100 });
  await db.settings.bulkPut([{ key: 'ai.apiKey', value: 'fictional-test-secret', updatedAt: 1 }, { key: 'theme.mode', value: 'dark', updatedAt: 1 }, { key: 'recurring.pendingConfirms', value: [{ ruleId: 1 }], updatedAt: 1 }]);
  await db.lifeNotes.add({ id: 1, title: '保留生活', photoRefs: [1] } as never);
  await db.lifeDrafts.add({ key: 'draft', entryId: 7, body: '保留草稿', existingPhotoRefs: [] } as never);
  await db.attachments.bulkAdd([{ id: 1 }, { id: 2 }] as never[]);
  await db.entryAttachments.add({ entryId: 7, attachmentId: 2, sortOrder: 0 });
  await expect(saveImportAtomically(async () => { await clearLedgerForImport(); throw new Error('中断'); })).rejects.toThrow('中断');
  expect(await db.accounts.count()).toBe(1);
  expect(await db.attachments.count()).toBe(2);
  expect((await db.lifeDrafts.get('draft'))?.entryId).toBe(7);
  await saveImportAtomically(clearLedgerForImport);
  expect(await db.accounts.count()).toBe(0);
  expect(await db.entryAttachments.count()).toBe(0);
  expect(await db.attachments.toCollection().primaryKeys()).toEqual([1]);
  expect((await db.lifeNotes.get(1))?.title).toBe('保留生活');
  expect((await db.lifeDrafts.get('draft'))?.body).toBe('保留草稿');
  expect((await db.lifeDrafts.get('draft'))?.entryId).toBeUndefined();
  expect((await db.settings.get('ai.apiKey'))?.value).toBe('fictional-test-secret');
  expect((await db.settings.get('theme.mode'))?.value).toBe('dark');
  expect(await db.settings.get('recurring.pendingConfirms')).toBeUndefined();
});
