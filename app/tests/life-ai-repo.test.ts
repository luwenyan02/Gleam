import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../src/core/db';
import { secretStore } from '../src/core/secretStore';
import { addLifeNote } from '../src/core/repo/lifeRepo';
import { getLifeAiDestination, askLifeQuestion, organizeLifeText, generateLifeEdition } from '../src/core/repo/lifeAiRepo';
import { setSetting } from '../src/core/repo/settingsRepo';
import { lifeWeekForTimestamp } from '../src/core/lifeWeek';

const occurredAt = new Date(2026, 8, 16, 12).getTime();
const week = lifeWeekForTimestamp(occurredAt);

function response(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(async () => {
  vi.unstubAllGlobals();
  await db.delete();
  await db.open();
  await setSetting('ai.baseUrl', 'https://example.invalid/v1');
  await setSetting('ai.model', 'vision-model');
  await setSetting('life.aiEnabled', true);
  await secretStore.set('ai.apiKey', 'test-only-key');
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await secretStore.remove('ai.apiKey');
});

describe('生活 AI 显式授权边界', () => {
  it('确认后接口或模型改变时不把私密内容发给新目的地', async () => {
    const fetchSpy = vi.fn(); vi.stubGlobal('fetch', fetchSpy);
    await expect(askLifeQuestion({ body: '私密原话', messages: [], expectedDestination: { baseUrl: 'https://old.invalid/v1', model: 'vision-model' } })).rejects.toThrow('配置已变化');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('目的地只公开地址和模型；默认未开启时不发请求', async () => {
    expect(await getLifeAiDestination()).toEqual({ baseUrl: 'https://example.invalid/v1', model: 'vision-model' });
    await setSetting('life.aiEnabled', false);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(askLifeQuestion({ body: '今天散步。', messages: [] })).rejects.toThrow('开启');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('轻问与整理只发送调用方显式传入的图片，正文与用户回答参与整理', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(response('你愿意记下散步时最喜欢的一个瞬间吗？'))
      .mockResolvedValueOnce(response('今天散步时，我看到了一只橘猫。'));
    vi.stubGlobal('fetch', fetchSpy);
    const input = {
      body: '今天散步。',
      messages: [{ role: 'user' as const, content: '看到一只橘猫。' }],
      photos: ['data:image/png;base64,AQ=='],
    };
    await expect(askLifeQuestion(input)).resolves.toContain('愿意');
    await expect(organizeLifeText(input)).resolves.toContain('橘猫');
    for (const call of fetchSpy.mock.calls) {
      const payload = JSON.parse((call[1] as RequestInit).body as string) as { messages: unknown[] };
      const encoded = JSON.stringify(payload.messages);
      expect(encoded).toContain('今天散步');
      expect(encoded).toContain('看到一只橘猫');
      expect(encoded).toContain('data:image/png;base64,AQ==');
    }
  });

  it('取消或请求中关闭生活 AI 后拒绝迟到结果', async () => {
    let resolveFetch!: (value: Response) => void;
    const fetchSpy = vi.fn(() => new Promise<Response>((resolve) => { resolveFetch = resolve; }));
    vi.stubGlobal('fetch', fetchSpy);
    const controller = new AbortController();
    const pending = organizeLifeText({ body: '不会被采用', messages: [], signal: controller.signal });
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce());
    controller.abort();
    resolveFetch(response('迟到结果'));
    await expect(pending).rejects.toThrow(/取消|中止/);

    fetchSpy.mockClear();
    const pendingDisabled = organizeLifeText({ body: '也不会被采用', messages: [] });
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce());
    await setSetting('life.aiEnabled', false);
    resolveFetch(response('关闭后的迟到结果'));
    await expect(pendingDisabled).rejects.toThrow('关闭');
  });

  it('接口错误不读取或记录响应正文', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const text = vi.fn(async () => '包含不应记录的远端请求回显');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, text })));
    await expect(askLifeQuestion({ body: '测试', messages: [] })).rejects.toThrow('暂时不可用');
    expect(text).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('生活周刊生成', () => {
  it('只发送用户选中的有效来源，返回带版本快照但不自动保存', async () => {
    const selectedId = await addLifeNote({ kind: 'diary', body: '选中的虚构散步故事', occurredAt });
    await addLifeNote({ kind: 'diary', body: '绝不能发出的未选中内容', occurredAt });
    const selected = (await db.lifeNotes.get(selectedId))!;
    const fetchSpy = vi.fn(async (_url: string, init: RequestInit) => {
      const sent = String(init.body);
      expect(sent).toContain('选中的虚构散步故事');
      expect(sent).not.toContain('绝不能发出的未选中内容');
      return response(JSON.stringify({
        title: '散步的一周',
        blocks: [{ noteId: selectedId, text: '周三，我去公园散步。' }],
      }));
    });
    vi.stubGlobal('fetch', fetchSpy);

    await expect(generateLifeEdition({ weekKey: week.key, noteIds: [selectedId] })).resolves.toEqual({
      weekKey: week.key,
      title: '散步的一周',
      blocks: [{ noteId: selectedId, text: '周三，我去公园散步。' }],
      sourceRefs: [{ noteId: selectedId, updatedAt: selected.updatedAt }],
    });
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(await db.lifeEditions.count()).toBe(0);
  });

  it('拒绝未知/重复来源、空白或过大模型输出，且不自动重试', async () => {
    const noteId = await addLifeNote({ kind: 'diary', body: '有效来源', occurredAt });
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(response(JSON.stringify({ title: '恶意', blocks: [{ noteId: 999, text: '伪造' }] })))
      .mockResolvedValueOnce(response(JSON.stringify({ title: ' ', blocks: [{ noteId, text: '内容' }] })))
      .mockResolvedValueOnce(response(JSON.stringify({ title: '过大', blocks: [{ noteId, text: '字'.repeat(2_001) }] })));
    vi.stubGlobal('fetch', fetchSpy);
    await expect(generateLifeEdition({ weekKey: week.key, noteIds: [noteId] })).rejects.toThrow('来源');
    await expect(generateLifeEdition({ weekKey: week.key, noteIds: [noteId] })).rejects.toThrow('标题');
    await expect(generateLifeEdition({ weekKey: week.key, noteIds: [noteId] })).rejects.toThrow('过长');
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    await expect(generateLifeEdition({ weekKey: week.key, noteIds: [noteId, noteId] })).rejects.toThrow('重复');
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('响应期间来源变化会拒绝迟到周刊', async () => {
    const noteId = await addLifeNote({ kind: 'diary', body: '请求时版本', occurredAt });
    const note = (await db.lifeNotes.get(noteId))!;
    let resolveFetch!: (value: Response) => void;
    const fetchSpy = vi.fn(() => new Promise<Response>((resolve) => { resolveFetch = resolve; }));
    vi.stubGlobal('fetch', fetchSpy);
    const pending = generateLifeEdition({ weekKey: week.key, noteIds: [noteId] });
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce());
    await db.lifeNotes.update(noteId, { body: '响应前已修改', updatedAt: note.updatedAt + 1 });
    resolveFetch(response(JSON.stringify({ title: '迟到', blocks: [{ noteId, text: '旧版本' }] })));
    await expect(pending).rejects.toThrow('变化');
  });
});
