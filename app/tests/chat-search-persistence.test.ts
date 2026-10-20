import 'fake-indexeddb/auto';
import { beforeEach, expect, it } from 'vitest';
import { db } from '../src/core/db';
import { getLifeNote } from '../src/core/repo/lifeRepo';
import { getLifeDraft, putLifeDraft, saveLifeDraft, validateLifeDraft } from '../src/core/repo/lifeDraftRepo';
import type { LifeDraft } from '../src/core/types';

beforeEach(async () => { await db.delete(); await db.open(); });
const search = { status: 'searched' as const, sources: [{ title: '天气来源', url: 'https://weather.example.invalid/' }] };
const draft = (): LifeDraft => ({ key: 'chat:search', title: '虚构出行', body: '', occurredAt: 1,
  existingPhotoRefs: [], photos: [], aiExcluded: false,
  messages: [{ role: 'user', content: '明天天气？' }, { role: 'assistant', content: '有雨。', search }] });

it('保存生活记录和重新打开后保留每条回复的搜索事实及来源', async () => {
  const source = draft(); await putLifeDraft(source);
  expect((await getLifeDraft(source.key))?.messages.at(-1)?.search).toEqual(search);
  const id = await saveLifeDraft(source.key);
  expect((await getLifeNote(id))?.conversation?.at(-1)?.search).toEqual(search);
});

it('草稿及未完成回复拒绝非法搜索状态和可执行/含凭据来源链接', () => {
  for (const invalid of [
    { status: 'invented', sources: [] },
    { status: 'not-used', sources: search.sources },
    { status: 'searched', sources: [{ title: '错误链接', url: 'javascript:alert(1)' }] },
    { status: 'searched', sources: [{ title: '凭据', url: 'https://user:secret@example.invalid/' }] },
  ]) {
    const source = draft();
    expect(() => validateLifeDraft({ ...source, messages: [source.messages[0], { ...source.messages[1], search: invalid }] })).toThrow('搜索');
    expect(() => validateLifeDraft({ ...source, chatReply: { messageIndex: 0, regenerate: false, status: 'streaming', content: '', search: invalid } })).toThrow('搜索');
  }
});
