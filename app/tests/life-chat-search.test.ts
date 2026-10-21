import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { db } from '../src/core/db';
import { secretStore } from '../src/core/secretStore';
import { setSetting } from '../src/core/repo/settingsRepo';
import { continueLifeChat, organizeLifeText } from '../src/core/repo/lifeAiRepo';

const base = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const messages = [{ role: 'user' as const, content: '今天贵阳天气怎么样？' }];
const source = { title: '虚构天气来源', url: 'https://weather.example.invalid/guiyang' };
const output = (items: unknown[] = [], text = '根据本次检索结果，今天有雨。') => ({
  status: 'completed', output: [...items, { type: 'message', role: 'assistant',
    content: [{ type: 'output_text', text }] }],
});
const search = (sources: unknown[] = [source]) => ({ type: 'web_search_call', id: 'search-1', status: 'completed', action: { type: 'search', sources } });
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });

beforeEach(async () => {
  await db.delete(); await db.open();
  await setSetting('life.aiEnabled', true);
  await setSetting('ai.baseUrl', base); await setSetting('ai.model', 'qwen3.8-max');
  await secretStore.set('ai.apiKey', 'synthetic-search-key');
});
afterEach(async () => { vi.unstubAllGlobals(); vi.restoreAllMocks(); await secretStore.remove('ai.apiKey'); });

it('百炼 qwen3.8-max 使用 Responses 搜索工具并只采用接口返回的安全来源', async () => {
  const fetch = vi.fn(async () => json(output([search([source, source,
    { title: '<img onerror=alert(1)>', url: 'javascript:alert(1)' },
    { title: '含凭据链接', url: 'https://user:secret@example.invalid/' }])])));
  vi.stubGlobal('fetch', fetch); const onSearch = vi.fn();
  const result = await continueLifeChat({ body: '', messages, onSearch });
  const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe(base + '/responses');
  const body = JSON.parse(String(init.body));
  expect(body.tools).toEqual([{ type: 'web_search' }]);
  expect(body.reasoning).toEqual({ effort: 'none' });
  expect(body.enable_thinking).toBeUndefined();
  expect(body.store).toBe(false);
  expect(body.input.at(-1)).toEqual(messages[0]);
  expect(JSON.stringify(body.input)).not.toContain('没有联网工具');
  expect(JSON.stringify(body.input)).toContain('未执行搜索');
  expect(result.search).toEqual({ status: 'searched', sources: [source] });
  expect(onSearch.mock.calls.at(-1)?.[0]).toEqual(result.search);
});

it.each([
  ['qwen3.8-max-0902', { effort: 'none' }, undefined],
  ['qwen3.8-flash', { effort: 'none' }, undefined],
  ['qwen3.7-plus', undefined, false],
  ['qwen3.7-flash', undefined, false],
  ['qwen3.7-max', undefined, false],
  ['qwen3.7-max-preview', undefined, undefined],
  ['qwen3.7-max-2026-05-17', undefined, undefined],
  ['kimi-k3', undefined, undefined],
  ['deepseek-v4-pro-0813', undefined, undefined],
] as const)('搜索协议仅为已确认的 %s 设置兼容思考参数', async (model, reasoning, thinking) => {
  await setSetting('ai.model', model);
  const fetch = vi.fn(async () => json(output()));
  vi.stubGlobal('fetch', fetch);
  await continueLifeChat({ body: '', messages });
  expect(fetch).toHaveBeenCalledOnce();
  const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  const body = JSON.parse(String(init.body));
  expect(url).toBe(base + '/responses');
  expect(body.tools).toEqual([{ type: 'web_search' }]);
  expect(body.reasoning).toEqual(reasoning);
  expect(body.enable_thinking).toBe(thinking);
  expect(body.reasoning_effort).toBeUndefined();
});

it('搜索状态随 SSE 工具事件更新，分片文字和最终来源一起交接', async () => {
  const events = [
    { type: 'response.web_search_call.searching', item_id: 'search-1' },
    { type: 'response.output_item.done', item: search() },
    { type: 'response.output_text.delta', delta: '今天' },
    { type: 'response.output_text.delta', delta: '有雨。' },
    { type: 'response.completed', response: output([search()], '今天有雨。') },
  ];
  const bytes = new TextEncoder().encode(events.map(e => 'event: ' + e.type + '\r\ndata: ' + JSON.stringify(e) + '\r\n\r\n').join(''));
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ start(c) {
    for (let i = 0; i < bytes.length; i += 5) c.enqueue(bytes.slice(i, i + 5)); c.close();
  } }), { headers: { 'Content-Type': 'text/event-stream' } })));
  const onSearch = vi.fn(), onDelta = vi.fn();
  const result = await continueLifeChat({ body: '', messages, onSearch, onDelta });
  expect(onDelta.mock.calls.map(c => c[0])).toEqual(['今天', '今天有雨。']);
  expect(onSearch.mock.calls.map(c => c[0].status)).toContain('searching');
  expect(result.reply).toBe('今天有雨。');
  expect(result.search).toEqual({ status: 'searched', sources: [source] });
});

it('挂载工具但未实际调用时明确未搜索，不把模型正文里的链接当搜索来源', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json(output([], '可以看看 https://invented.example.invalid/ 。'))));
  const result = await continueLifeChat({ body: '', messages, onSearch: () => {} });
  expect(result.search).toEqual({ status: 'not-used', sources: [] });
});

it('已执行搜索但没有返回可用链接时保留真实状态，不伪造来源', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json(output([search([])]))));
  expect((await continueLifeChat({ body: '', messages, onSearch: () => {} })).search)
    .toEqual({ status: 'searched', sources: [] });
});

it('工具执行失败不当成已搜索，不采用失败工具携带的来源', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json(output([{ ...search(), status: 'failed' }], '搜索未完成，尚未核实天气。'))));
  expect((await continueLifeChat({ body: '', messages, onSearch: () => {} })).search)
    .toEqual({ status: 'failed', sources: [] });
});

it('取消后拒绝迟到结果，不把迟到来源或搜索成功状态交给页面', async () => {
  let resolve!: (value: Response) => void;
  const fetch = vi.fn(() => new Promise<Response>(yes => { resolve = yes; }));
  vi.stubGlobal('fetch', fetch); const controller = new AbortController(), onSearch = vi.fn();
  const pending = continueLifeChat({ body: '', messages, signal: controller.signal, onSearch });
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce()); controller.abort();
  resolve(json(output([search()])));
  await expect(pending).rejects.toThrow('取消');
  expect(onSearch.mock.calls.map(c => c[0].status)).not.toContain('searched');
});

it('含既有账本分析的聊天不调用搜索工具，不将财务上下文用于联网检索', async () => {
  const fetch = vi.fn(async () => json({ choices: [{ message: { content: '这里只分析已提供的账本摘要。' } }] }));
  vi.stubGlobal('fetch', fetch);
  const result = await continueLifeChat({ body: '', messages: [
    { role: 'user', content: '分析这份账本', ledgerAnalysis: true },
    { role: 'assistant', content: '虚构账本摘要', ledgerAnalysis: true },
    { role: 'user', content: '和最近的天气有什么关系？' },
  ], onSearch: () => {} });
  const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe(base + '/chat/completions'); expect(JSON.parse(String(init.body)).tools).toBeUndefined();
  expect(result.search).toBeUndefined();
});

it('搜索失败不会读取远端错误正文，也不会静默回退再次发送私密对话', async () => {
  const text = vi.fn(), warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const fetch = vi.fn(async () => ({ ok: false, status: 500, text }));
  vi.stubGlobal('fetch', fetch); const onSearch = vi.fn();
  await expect(continueLifeChat({ body: '', messages, onSearch })).rejects.toThrow('联网');
  expect(text).not.toHaveBeenCalled(); expect(warn).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledOnce();
  expect(onSearch.mock.calls.at(-1)?.[0].status).toBe('failed');
});

it('缺少 response.completed 的流保留文字但不能伪报完成或搜索成功', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('data: {"type":"response.output_text.delta","delta":"半句话"}\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } })));
  const onDelta = vi.fn(), onSearch = vi.fn();
  await expect(continueLifeChat({ body: '', messages, onDelta, onSearch })).rejects.toThrow('中断');
  expect(onDelta).toHaveBeenCalledWith('半句话');
  expect(onSearch.mock.calls.at(-1)?.[0].status).toBe('failed');
});

it('自定义接口继续原聊天协议，能力提示按当前配置生成，不给未知接口强加搜索参数', async () => {
  await setSetting('ai.baseUrl', 'https://custom.example.invalid/v1');
  const fetch = vi.fn(async () => json({ choices: [{ message: { content: '本次未核实实时天气。' } }] }));
  vi.stubGlobal('fetch', fetch);
  const result = await continueLifeChat({ body: '', messages, onSearch: () => {} });
  const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe('https://custom.example.invalid/v1/chat/completions');
  const body = JSON.parse(String(init.body));
  expect(body.tools).toBeUndefined(); expect(JSON.stringify(body.messages)).not.toContain('没有联网工具');
  expect(result.search).toEqual({ status: 'unsupported', sources: [] });
});

it('整理生活记录继续只用选中素材，不启用搜索或改变请求协议', async () => {
  const fetch = vi.fn(async () => json({ choices: [{ message: { content: '今天去散步。' } }] }));
  vi.stubGlobal('fetch', fetch);
  await organizeLifeText({ body: '今天去散步。', messages: [] });
  const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe(base + '/chat/completions'); expect(JSON.parse(String(init.body)).tools).toBeUndefined();
});
