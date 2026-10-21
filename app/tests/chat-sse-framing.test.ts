import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { db } from '../src/core/db';
import { requestAiChat } from '../src/core/repo/aiRepo';
import { setSetting } from '../src/core/repo/settingsRepo';
import { secretStore } from '../src/core/secretStore';

const reply = '今天有雨。';
const message = { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: reply }] };
const delta = { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: '今天' };
const completed = { type: 'response.completed', response: { status: 'completed' } };
const frame = (value: Record<string, unknown>) => `event: ${value.type}\r\ndata: ${JSON.stringify(value)}\r\n\r\n`;
const doneSnapshots = [
  { type: 'response.output_text.done', output_index: 0, content_index: 0, text: reply },
  { type: 'response.content_part.done', output_index: 0, content_index: 0, part: { type: 'output_text', text: reply } },
  { type: 'response.output_item.done', output_index: 0, item: message },
];

// Android Capacitor 8.5.0 HttpRequestHandler.readStreamAsString uses readLine +
// separators between lines, so the final wire line ending is lost after buffering.
const capacitorText = (wire: string) => wire.replace(/\r\n|\r/g, '\n').replace(/\n$/, '');
const stub = (body: string) => vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })));
const request = (search = true, onDelta = vi.fn()) => requestAiChat({ messages: [{ role: 'user', content: '合成天气问题' }],
  onDelta, privateContent: true, ...(search ? { onSearch: () => {} } : {}) });

beforeEach(async () => {
  await db.delete(); await db.open();
  await setSetting('ai.baseUrl', 'https://dashscope.aliyuncs.com/compatible-mode/v1');
  await setSetting('ai.model', 'qwen3.8-max');
  await secretStore.set('ai.apiKey', 'synthetic-sse-key');
});
afterEach(async () => {
  vi.unstubAllGlobals(); vi.restoreAllMocks();
  await secretStore.remove('ai.apiKey');
});

it.each([true, false])('Android 原生桥去掉末尾换行后仍消费合法终帧（搜索=%s）', async search => {
  const wire = search ? frame({ ...delta, delta: reply }) + frame({ ...completed, response: { status: 'completed', output: [message] } })
    : `data: ${JSON.stringify({ choices: [{ delta: { content: reply } }] })}\r\n\r\ndata: [DONE]\r\n\r\n`;
  const bridged = capacitorText(wire);
  expect(bridged.endsWith('\n')).toBe(true); expect(bridged.endsWith('\n\n')).toBe(false);
  stub(bridged);
  const onDelta = vi.fn();
  await expect(request(search, onDelta)).resolves.toBe(reply);
  expect(onDelta).toHaveBeenCalledWith(reply);
  expect(fetch).toHaveBeenCalledOnce();
});

it.each([true, false])('终帧不带换行仍须凭完整终态成功（搜索=%s）', async search => {
  const wire = search ? frame({ ...delta, delta: reply }) + frame({ ...completed, response: { status: 'completed', output: [message] } })
    : `data: ${JSON.stringify({ choices: [{ delta: { content: reply } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}`;
  stub(wire.replace(/[\r\n]+$/, ''));
  await expect(request(search)).resolves.toBe(reply);
});

it('Responses 兼容标准 event 行提供事件类型，并仍验证响应状态', async () => {
  stub(`event: response.output_text.delta\ndata: {"delta":"今天"}\n\nevent: response.completed\ndata: ${JSON.stringify({ response: { status: 'completed', output: [message] } })}\n`);
  await expect(request()).resolves.toBe(reply);
});

it.each(doneSnapshots)('Responses 的 $type 全文校正片段，但须等全局 completed', async snapshot => {
  stub(frame(delta) + frame(snapshot) + frame(completed));
  await expect(request()).resolves.toBe(reply);
});

it('全文 done 事件重复出现时不重复拼接同一内容块', async () => {
  stub(frame(delta) + doneSnapshots.map(frame).join('') + frame(completed));
  await expect(request()).resolves.toBe(reply);
});

it('按 output_index/content_index 保留多个内容块，全文快照不覆盖其他块', async () => {
  const values = [
    { ...delta, delta: '第一' },
    { type: 'response.output_text.done', output_index: 0, content_index: 0, text: '第一段。' },
    { ...delta, content_index: 1, delta: '第二' },
    { type: 'response.content_part.done', output_index: 0, content_index: 1, part: { type: 'output_text', text: '第二段。' } },
    { type: 'response.output_item.done', output_index: 1, item: { ...message, content: [{ type: 'output_text', text: '第三段。' }] } },
    completed,
  ];
  stub(values.map(frame).join(''));
  await expect(request()).resolves.toBe('第一段。第二段。第三段。');
});

it.each([
  { output_index: -1 }, { output_index: '0' }, { output_index: null },
  { content_index: -1 }, { content_index: 1.5 }, { content_index: Number.MAX_SAFE_INTEGER + 1 },
])('拒绝非法内容索引 $output_index / $content_index，不合并不明内容块', async index => {
  stub(frame({ ...delta, ...index }) + frame(completed));
  await expect(request()).rejects.toThrow('索引');
});

it('稀疏但合法的大索引使用有限内容块，不创建巨大数组或重复全文快照', async () => {
  const first = { ...delta, output_index: 99_999, content_index: 99_999, delta: '第一段。' };
  const last = { type: 'response.output_text.done', output_index: 99_999, content_index: 99_999, text: '第一段。' };
  stub(frame(first) + frame(last) + frame({ ...delta, output_index: 100_000, delta: '第二段。' }) + frame(completed));
  await expect(request()).resolves.toBe('第一段。第二段。');
});

it.each(doneSnapshots)('EOF 前只有 $type 不能冒充整体完成', async snapshot => {
  stub(capacitorText(frame(delta) + frame(snapshot)));
  await expect(request()).rejects.toThrow('中断');
});

it('EOF 前只有 delta，即使文字像完整答案也不能冒充完成', async () => {
  stub(capacitorText(frame({ ...delta, delta: reply })));
  const onDelta = vi.fn();
  await expect(request(true, onDelta)).rejects.toThrow('中断');
  expect(onDelta).toHaveBeenCalledWith(reply);
});

it('不接受无事件类型的 completed 数据或截断 JSON', async () => {
  stub(frame(delta) + `data: ${JSON.stringify({ response: { status: 'completed', output: [message] } })}\n`);
  await expect(request()).rejects.toThrow('中断');
  stub(frame(delta) + 'event: response.completed\ndata: {"type":"response.completed","response":');
  await expect(request()).rejects.toThrow(/失败|中断/);
});

it.each(['response.failed', 'response.incomplete'])('EOF 中的明确 %s 仍优先按失败处理', async type => {
  stub(capacitorText(frame(delta) + frame({ type })));
  await expect(request()).rejects.toThrow('未完成');
});

it.each([1, 3, 7])('UTF-8 与终帧跨 %i 字节分片，EOF 后仍校验 completed', async size => {
  const bytes = new TextEncoder().encode(capacitorText(frame({ ...delta, delta: reply }) + frame(completed)));
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += size) controller.enqueue(bytes.slice(i, i + size)); controller.close();
  } }), { headers: { 'Content-Type': 'text/event-stream' } })));
  await expect(request()).resolves.toBe(reply);
});
