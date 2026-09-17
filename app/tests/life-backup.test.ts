import 'fake-indexeddb/auto';
import { beforeEach, expect, it } from 'vitest';
import { db } from '../src/core/db';
import { exportAll, restoreAll, sanitizeDumpForBackup } from '../src/core/repo/backupRepo';
import { putLifeDraft } from '../src/core/repo/lifeDraftRepo';

beforeEach(async () => { await db.delete(); await db.open(); });

it('备份和恢复包含本地草稿与小报，但不继承生活 AI 授权', async () => {
  await putLifeDraft({ key: 'new', title: '', body: '虚构原话', occurredAt: 1, photos: [], existingPhotoRefs: [], messages: [], aiExcluded: false });
  await db.settings.put({ key: 'life.aiEnabled', value: true, updatedAt: 1 });
  const dump = await exportAll();
  expect(dump.lifeDrafts).toHaveLength(1);
  expect(dump.lifeEditions).toEqual([]);
  expect(sanitizeDumpForBackup(dump).settings).toContainEqual({ key: 'life.aiEnabled', value: false, updatedAt: 1 });
  await restoreAll(dump);
  expect(await db.lifeDrafts.get('new')).toMatchObject({ body: '虚构原话' });
  expect((await db.settings.get('life.aiEnabled'))?.value).toBe(false);
});
