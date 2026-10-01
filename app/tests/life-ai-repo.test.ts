import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../src/core/db';
import { secretStore } from '../src/core/secretStore';
import { addLifeNote, listLifeNotes } from '../src/core/repo/lifeRepo';
import { getLifeDraft } from '../src/core/repo/lifeDraftRepo';
import { getLifeAiDestination, askLifeQuestion, continueLifeChat, generateLifeSummary, organizeLifeText, generateLifeEdition } from '../src/core/repo/lifeAiRepo';
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

describe('生活 AI 结构化多轮对话', () => {
  it('文字对话先识别当前意图，不默认陪聊、赞美或触发记录', async () => {
    const fetchSpy = vi.fn(async (_url: string, _init: RequestInit) => response('可以从自由对话和按需整理两部分设计。'));
    vi.stubGlobal('fetch', fetchSpy);
    await continueLifeChat({ body: '', messages: [{ role: 'user', content: '我想设计一个陪聊记录产品，怎么做？' }], onDelta: () => {} });
    const prompt = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body)).messages[0].content;
    expect(prompt).toContain('先识别当前意图');
    expect(prompt).toContain('不要默认用户是在请求你扮演');
    expect(prompt).toContain('不要用固定夸赞开场');
    expect(prompt).toContain('不必每次以问题结尾');
    expect(prompt).toContain('只有用户主动要求');
  });
  it('以原生角色发送多轮对话，照片只附在最后一条用户消息上', async () => {
    const fetchSpy = vi.fn(async (_url: string, _init: RequestInit) => response('直接回答当前问题。'));
    vi.stubGlobal('fetch', fetchSpy);
    const messages = [{ role: 'user' as const, content: '我在设计一个产品。' }, { role: 'assistant' as const, content: '可以从交互入手。' }, { role: 'user' as const, content: '看看这张界面。' }];
    await continueLifeChat({ body: '', messages, photos: ['data:image/png;base64,AQ=='], onDelta: () => {} });
    const sent = JSON.parse(String(fetchSpy.mock.calls[0][1].body)).messages;
    expect(sent.map((m: { role: string }) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(sent[1].content).toBe(messages[0].content);
    expect(sent[2].content).toBe(messages[1].content);
    expect(sent[3].content).toEqual([{ type: 'text', text: messages[2].content }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AQ==' } }]);
    expect(messages[2].content).toBe('看看这张界面。');
  });
  it('流式对话按分片更新，兼容切断的 UTF-8 和多条 SSE 事件', async () => {
    const payload = `data: ${JSON.stringify({ choices: [{ delta: { content: '你好' } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: { content: '，随便聊。' } }] })}\n\ndata: [DONE]\n\n`;
    const bytes = new TextEncoder().encode(payload);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ start(controller) {
      for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3)); controller.close();
    } }), { headers: { 'Content-Type': 'text/event-stream' } })));
    const onDelta = vi.fn();
    await expect(continueLifeChat({ body: '', messages: [{ role: 'user', content: '你好' }], onDelta })).resolves.toEqual({ reply: '你好，随便聊。', readyToSummarize: false });
    expect(onDelta.mock.calls.map(call => call[0])).toEqual(['你好', '你好，随便聊。']);
  });
  it('中断的流不能被当成已完成回复', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('data: {"choices":[{"delta":{"content":"半句"}}]}\n\n', { headers: { 'Content-Type': 'text/event-stream' } })));
    await expect(continueLifeChat({ body: '', messages: [{ role: 'user', content: '你好' }], onDelta: () => {} })).rejects.toThrow('中断');
  });
  it('返回简短回复与模型明确给出的摘要就绪状态', async () => {
    const fetchSpy = vi.fn(async (_url: string, init: RequestInit) => {
      const payload = JSON.parse(String(init.body)) as { messages: Array<{ content: unknown }> };
      expect(JSON.stringify(payload.messages)).toContain('池塘边有一只橘猫');
      return response(JSON.stringify({ reply: '还记得它当时在做什么吗？', readyToSummarize: true }));
    });
    vi.stubGlobal('fetch', fetchSpy);

    await expect(continueLifeChat({
      body: '',
      messages: [{ role: 'user', content: '池塘边有一只橘猫。' }],
      expectedDestination: { baseUrl: 'https://example.invalid/v1', model: 'vision-model' },
    })).resolves.toEqual({ reply: '还记得它当时在做什么吗？', readyToSummarize: true });
  });

  it('可安全降级的回复按普通文本展示且绝不猜测摘要就绪；畸形内容仍拒绝', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(response(JSON.stringify({ reply: '愿意的话，再讲一个小细节。' })))
      .mockResolvedValueOnce(response(JSON.stringify({ reply: '我们可以先停在这里。', readyToSummarize: 'true' })))
      .mockResolvedValueOnce(response('这是一段非 JSON 纯文本'))
      .mockResolvedValueOnce(response('{"readyToSummarize":true}'));
    vi.stubGlobal('fetch', fetchSpy);
    const input = { body: '', messages: [{ role: 'user' as const, content: '今天散步。' }] };

    await expect(continueLifeChat(input)).resolves.toEqual({ reply: '愿意的话，再讲一个小细节。', readyToSummarize: false });
    await expect(continueLifeChat(input)).resolves.toEqual({ reply: '我们可以先停在这里。', readyToSummarize: false });
    await expect(continueLifeChat(input)).resolves.toEqual({ reply: '这是一段非 JSON 纯文本', readyToSummarize: false });
    await expect(continueLifeChat(input)).rejects.toThrow('对话格式无效');
  });

  it('后续纯文字请求不会把会话中已发送照片重复带出设备', async () => {
    const fetchSpy = vi.fn(async (_url: string, init: RequestInit) => {
      expect(String(init.body)).toContain('带照片的第一句');
      expect(String(init.body)).not.toContain('data:image/png;base64,AQ==');
      return response(JSON.stringify({ reply: '这次只收到了文字。', readyToSummarize: false }));
    });
    vi.stubGlobal('fetch', fetchSpy);
    await expect(continueLifeChat({ body: '', messages: [
      { role: 'user', content: '带照片的第一句', photos: [{ name: '已发送.png', dataUrl: 'data:image/png;base64,AQ==' }] },
      { role: 'assistant', content: '我看见了。' },
      { role: 'user', content: '这次只补一句文字。' },
    ] })).resolves.toEqual({ reply: '这次只收到了文字。', readyToSummarize: false });
  });
});

describe('生活 AI 独立摘要方案', () => {
  it('只返回当前会话的结构化方案，不自动写入草稿或正式记录', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(JSON.stringify({
      title: '池塘边的橘猫',
      body: '今天去公园，在池塘边看到一只橘猫。',
      mood: '轻松',
      tags: ['散步', '橘猫'],
      sourceMessageCount: 3,
    }))));
    const messages = [
      { role: 'user' as const, content: '今天去了公园。' },
      { role: 'assistant' as const, content: '有什么小细节想留下？' },
      { role: 'user' as const, content: '池塘边有一只橘猫。' },
    ];

    await expect(generateLifeSummary({
      body: '', messages,
      expectedDestination: { baseUrl: 'https://example.invalid/v1', model: 'vision-model' },
    })).resolves.toEqual({
      title: '池塘边的橘猫', body: '今天去公园，在池塘边看到一只橘猫。',
      mood: '轻松', tags: ['散步', '橘猫'], sourceMessageCount: 3,
    });
    expect(await getLifeDraft('chat')).toBeUndefined();
    expect(await listLifeNotes()).toEqual([]);
  });

  it('拒绝消息数不匹配或字段伪造的摘要响应', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(response(JSON.stringify({ title: '旧摘要', body: '内容', tags: [], sourceMessageCount: 1 })))
      .mockResolvedValueOnce(response(JSON.stringify({ title: '错误标签', body: '内容', tags: '散步', sourceMessageCount: 2 })))
      .mockResolvedValueOnce(response('not-json'));
    vi.stubGlobal('fetch', fetchSpy);
    const input = { body: '', messages: [
      { role: 'user' as const, content: '今天散步。' },
      { role: 'assistant' as const, content: '看到了什么？' },
    ] };

    await expect(generateLifeSummary(input)).rejects.toThrow('版本');
    await expect(generateLifeSummary(input)).rejects.toThrow('摘要格式无效');
    await expect(generateLifeSummary(input)).rejects.toThrow('摘要格式无效');
  });
});

describe('生活周刊生成', () => {
  it('周刊只发送用户确认的正式记录，不带出本地原始会话', async () => {
    const noteId = await addLifeNote({
      kind: 'diary', title: '正式标题', body: '正式正文', occurredAt,
      conversation: [
        { role: 'user', content: '不应进入周刊请求的原话' },
        { role: 'assistant', content: '不应进入周刊请求的追问' },
      ],
    });
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const sent = String(init.body);
      expect(sent).toContain('正式标题');
      expect(sent).toContain('正式正文');
      expect(sent).not.toContain('不应进入周刊请求');
      return response(JSON.stringify({ title: '本周', blocks: [{ noteId, text: '正式片段' }] }));
    }));

    await expect(generateLifeEdition({ weekKey: week.key, noteIds: [noteId] })).resolves.toMatchObject({
      blocks: [{ noteId, text: '正式片段' }],
    });
  });

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
