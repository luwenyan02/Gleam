import 'fake-indexeddb/auto';
import { beforeEach, expect, it } from 'vitest';
import { db } from '../src/core/db';
import { exportAll, restoreAll, sanitizeDumpForBackup } from '../src/core/repo/backupRepo';
import { getLifeDraft, migrateLifeDraft, putLifeDraft } from '../src/core/repo/lifeDraftRepo';
import { addLifeNote, getLifeNote } from '../src/core/repo/lifeRepo';
import { getSetting, setSetting } from '../src/core/repo/settingsRepo';

beforeEach(async () => { await db.delete(); await db.open(); });

it('备份和恢复包含本地草稿与小报，但不继承生活 AI 授权', async () => {
  const messages = [
    { role: 'user' as const, content: '虚构原话' },
    { role: 'assistant' as const, content: '虚构追问' },
  ];
  await putLifeDraft({
    key: 'new', title: '', body: '', occurredAt: 1, photos: [], existingPhotoRefs: [], messages, aiExcluded: false,
    summaryProposal: { title: '草稿摘要', body: '虚构整理稿', tags: ['虚构'], sourceMessageCount: 2 },
  });
  const noteId = await addLifeNote({ kind: 'diary', title: '已确认', body: '正式记录', conversation: messages, occurredAt: 1 });
  await setSetting('life.aiEnabled', true);
  const dump = await exportAll();
  expect(dump.lifeDrafts).toHaveLength(1);
  expect(dump.lifeEditions).toEqual([]);
  expect(sanitizeDumpForBackup(dump).settings).toContainEqual(expect.objectContaining({ key: 'life.aiEnabled', value: false }));
  await restoreAll(dump);
  expect(await getLifeDraft('new')).toMatchObject({
    messages,
    summaryProposal: { title: '草稿摘要', body: '虚构整理稿', sourceMessageCount: 2 },
  });
  expect(await getLifeNote(noteId)).toMatchObject({ body: '正式记录', conversation: messages });
  expect(await getSetting('life.aiEnabled')).toBe(false);
});

it('超限历史标签迁移后备份往返不截断', async () => {
  const legacyTags = [...Array.from({ length: 13 }, (_, index) => `旧标签${index + 1}`), '超'.repeat(61)];
  const migrated = migrateLifeDraft({
    key: 'legacy-chat', title: '旧标题', body: '旧原话', occurredAt: 1,
    photos: [], existingPhotoRefs: [], messages: [], aiText: '旧整理稿', tags: legacyTags, aiExcluded: false,
  });
  await putLifeDraft(migrated);

  await restoreAll(await exportAll());
  expect((await getLifeDraft('legacy-chat'))?.summaryProposal?.tags).toEqual(legacyTags);
});
