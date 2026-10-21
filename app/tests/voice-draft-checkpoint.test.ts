import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import { db } from '../src/core/db';
import type { LifeDraft } from '../src/core/types';
import { VoiceDraftCheckpoint } from '../src/core/voiceTranscript';
import { getLifeDraft } from '../src/core/repo/lifeDraftRepo';
import { persistChatDraft } from '../src/features/life/lifeChatSession';

afterEach(() => vi.useRealTimers());
it('连续语音固定每秒实际提交IndexedDB，结束立即提交最新文字', async () => {
  await db.delete(); await db.open();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const draft: LifeDraft = { key: 'chat:checkpoint', title: '', body: '', occurredAt: 1, aiExcluded: false, photos: [], existingPhotoRefs: [], messages: [{ role: 'assistant', content: '' }] };
  const writes: Promise<void>[] = [];
  const checkpoint = new VoiceDraftCheckpoint(() => { const save = persistChatDraft(draft); writes.push(save); return save; });
  for (let i = 1; i <= 25; i++) {
    draft.messages[0].content = `片段${i}`; checkpoint.changed(); await vi.advanceTimersByTimeAsync(100);
    if (i === 10 || i === 20) {
      await Promise.all(writes);
      expect((await getLifeDraft(draft.key))?.messages[0].content).toBe(`片段${i}`);
    }
  }
  expect(writes).toHaveLength(2);
  checkpoint.flush(); await Promise.all(writes);
  expect((await getLifeDraft(draft.key))?.messages[0].content).toBe('片段25');
  checkpoint.flush(); expect(writes).toHaveLength(3);
});
