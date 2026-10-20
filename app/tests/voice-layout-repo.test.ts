import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { db } from '../src/core/db';
import { secretStore } from '../src/core/secretStore';
import { setSetting } from '../src/core/repo/settingsRepo';
import { formatLifeVoiceReply } from '../src/core/repo/lifeAiRepo';
import { addLifeNote, updateLifeNote } from '../src/core/repo/lifeRepo';

const destination = { baseUrl: 'https://voice-text.invalid/v1', model: 'text-model' };
const transcript = '周六去公园，周日去博物馆。';
const response = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content } }] }));
beforeEach(async () => {
  await db.delete(); await db.open();
  await setSetting('life.aiEnabled', true);
  await setSetting('ai.baseUrl', destination.baseUrl); await setSetting('ai.model', destination.model);
  await secretStore.set('ai.apiKey', 'synthetic-only');
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it('只发送本轮助手转写、沿用指定文字模型，不含搜索、历史、照片或录音', async () => {
  const fetchSpy = vi.fn(async () => response('## 周末\n\n- 周六：公园\n- 周日：博物馆'));
  vi.stubGlobal('fetch', fetchSpy);
  const display = await formatLifeVoiceReply({ transcript, expectedDestination: destination });
  expect(display).toContain('## 周末');
  const [url, options] = fetchSpy.mock.calls[0];
  expect(url).toBe(destination.baseUrl + '/chat/completions');
  const body = JSON.parse(options.body);
  expect(body.model).toBe(destination.model); expect(body.tools).toBeUndefined(); expect(body.stream).toBeUndefined();
  expect(body.messages).toHaveLength(2);
  expect(JSON.parse(body.messages[1].content)).toEqual({ transcript });
  expect(body.messages[0].content).toContain('不新增');
  expect(body.messages[0].content).toContain('表格');
});
it('未启用、来源排除、目的地变更和取消均不发送', async () => {
  const fetchSpy = vi.fn(); vi.stubGlobal('fetch', fetchSpy);
  await setSetting('life.aiEnabled', false);
  await expect(formatLifeVoiceReply({ transcript, expectedDestination: destination })).rejects.toThrow('开启');
  await setSetting('life.aiEnabled', true);
  await expect(formatLifeVoiceReply({ transcript, expectedDestination: { ...destination, model: 'old' } })).rejects.toThrow('配置已变化');
  const noteId = await addLifeNote({ kind: 'diary', occurredAt: 1, aiExcluded: true });
  await expect(formatLifeVoiceReply({ transcript, expectedDestination: destination, noteId })).rejects.toThrow('排除');
  const controller = new AbortController(); controller.abort();
  await expect(formatLifeVoiceReply({ transcript, expectedDestination: destination, signal: controller.signal })).rejects.toThrow('取消');
  expect(fetchSpy).not.toHaveBeenCalled();
});
it('响应返回前模型或原记录改变时不采用；私密错误不读取远端正文', async () => {
  const noteId = await addLifeNote({ kind: 'diary', occurredAt: 1 });
  for (const mode of ['model', 'note', 'empty', 'too-long', 'error']) {
    await setSetting('ai.model', destination.model); await updateLifeNote(noteId, { aiExcluded: false });
    const text = vi.fn(async () => 'private-provider-marker');
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (mode === 'model') await setSetting('ai.model', 'changed');
      if (mode === 'note') await updateLifeNote(noteId, { aiExcluded: true });
      if (mode === 'error') return { ok: false, status: 500, text };
      return response(mode === 'empty' ? '' : mode === 'too-long' ? '字'.repeat(12001) : '整理文字');
    }));
    await expect(formatLifeVoiceReply({ transcript, expectedDestination: destination, noteId })).rejects.toThrow();
    expect(text).not.toHaveBeenCalled();
  }
});
