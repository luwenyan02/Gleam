import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { db } from '../src/core/db';
import { requestAiChat } from '../src/core/repo/aiRepo';
import { setSetting } from '../src/core/repo/settingsRepo';
import { secretStore } from '../src/core/secretStore';

const paths = ['responses', 'chat-completions'] as const;
type Path = typeof paths[number];
const reply = '今天有雨。';
const encode = (data: unknown) => new TextEncoder().encode(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\r\n\r\n`);
const delta = (path: Path) => path === 'responses'
  ? { type: 'response.output_text.delta', delta: reply }
  : { choices: [{ delta: { content: reply } }] };
const complete = (path: Path) => path === 'responses'
  ? { type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: reply }] }] } }
  : { choices: [{ delta: {}, finish_reason: 'stop' }] };
const failed = (path: Path) => path === 'responses'
  ? { type: 'response.failed' }
  : { error: { message: 'synthetic failure' } };

function request(path: Path, signal?: AbortSignal, onDelta = vi.fn()) {
  return requestAiChat({ messages: [{ role: 'user', content: '合成问题' }], signal, onDelta, privateContent: true,
    ...(path === 'responses' ? { onSearch: () => {} } : {}) });
}

function controlledStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let releaseCancel!: () => void;
  const cancel = vi.fn(() => new Promise<void>(resolve => { releaseCancel = resolve; }));
  const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; }, cancel });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } })));
  return { send: (data: unknown) => controller.enqueue(encode(data)), cancel, release: () => releaseCancel() };
}

beforeEach(async () => {
  await db.delete(); await db.open();
  await setSetting('ai.baseUrl', 'https://dashscope.aliyuncs.com/compatible-mode/v1');
  await setSetting('ai.model', 'qwen3.8-max');
  await secretStore.set('ai.apiKey', 'synthetic-network-key');
});

afterEach(async () => {
  vi.unstubAllGlobals(); vi.restoreAllMocks();
  await secretStore.remove('ai.apiKey');
});

it.each(paths)('%s 收到完成事件后不等待异步取消清理或连接关闭', async path => {
  const stream = controlledStream();
  let result: string | undefined;
  const pending = request(path).then(value => { result = value; });
  stream.send(delta(path)); stream.send(complete(path));
  try {
    await vi.waitFor(() => expect(stream.cancel).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(result).toBe(reply), { timeout: 150, interval: 5 });
  } finally {
    stream.release(); await pending;
  }
});

it.each(paths)('%s 明确失败后不等待异步取消清理，也不重发请求', async path => {
  const stream = controlledStream();
  let error: Error | undefined;
  const pending = request(path).catch(value => { error = value; });
  stream.send(delta(path)); stream.send(failed(path));
  try {
    await vi.waitFor(() => expect(stream.cancel).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(error?.message).toMatch(/未完成|暂时不可用/), { timeout: 150, interval: 5 });
    expect(fetch).toHaveBeenCalledOnce();
  } finally {
    stream.release(); await pending;
  }
});

it.each(paths)('%s 调用者取消流式请求后拒绝已有片段，保持取消语义', async path => {
  const aborter = new AbortController(), onDelta = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async (_url, init: RequestInit) => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(encode(delta(path)));
    init.signal!.addEventListener('abort', () => controller.error(new DOMException('synthetic abort', 'AbortError')), { once: true });
  } }), { headers: { 'Content-Type': 'text/event-stream' } })));
  const pending = request(path, aborter.signal, onDelta);
  await vi.waitFor(() => expect(onDelta).toHaveBeenCalledWith(reply));
  aborter.abort();
  await expect(pending).rejects.toThrow('取消');
  expect(fetch).toHaveBeenCalledOnce();
});

it.each(paths)('%s 提前结束的流保留片段但不能冒充成功', async path => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(encode(delta(path)), { headers: { 'Content-Type': 'text/event-stream' } })));
  const onDelta = vi.fn();
  await expect(request(path, undefined, onDelta)).rejects.toThrow('中断');
  expect(onDelta).toHaveBeenCalledWith(reply);
});

it('Responses 只收到文字完成事件时继续等待整个响应完成', async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ start(value) { controller = value; } }), { headers: { 'Content-Type': 'text/event-stream' } })));
  const onDelta = vi.fn();
  let settled = false;
  const pending = request('responses', undefined, onDelta).finally(() => { settled = true; });
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  controller.enqueue(encode(delta('responses')));
  controller.enqueue(encode({ type: 'response.output_text.done', text: reply }));
  await vi.waitFor(() => expect(onDelta).toHaveBeenCalledWith(reply));
  expect(settled).toBe(false);
  controller.enqueue(encode(complete('responses')));
  await expect(pending).resolves.toBe(reply);
});

it('Responses 缺少 response.completed 的裸 DONE 及时失败，不采纳片段', async () => {
  const aborter = new AbortController();
  let error: Error | undefined;
  vi.stubGlobal('fetch', vi.fn(async (_url, init: RequestInit) => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(encode(delta('responses'))); controller.enqueue(encode('[DONE]'));
    init.signal!.addEventListener('abort', () => controller.error(new DOMException('synthetic abort', 'AbortError')), { once: true });
  } }), { headers: { 'Content-Type': 'text/event-stream' } })));
  const pending = request('responses', aborter.signal).catch(value => { error = value; });
  try {
    await vi.waitFor(() => expect(error?.message).toContain('中断'), { timeout: 150, interval: 5 });
    expect(fetch).toHaveBeenCalledOnce();
  } finally {
    aborter.abort(); await pending;
  }
});

it.each([1, 2, 3, 5, 7, 11, 64])('Responses 兼容 UTF-8、CRLF、多行 data 和 %i 字节分片', async size => {
  const text = `event: response.output_text.delta\r\ndata: {"type":"response.output_text.delta",\r\ndata: "delta":"${reply}"}\r\n\r\n`;
  const first = new TextEncoder().encode(text), last = encode(complete('responses'));
  const bytes = new Uint8Array(first.length + last.length); bytes.set(first); bytes.set(last, first.length);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += size) controller.enqueue(bytes.slice(i, i + size)); controller.close();
  } }), { headers: { 'Content-Type': 'text/event-stream' } })));
  const onDelta = vi.fn();
  await expect(request('responses', undefined, onDelta)).resolves.toBe(reply);
  expect(onDelta.mock.calls).toEqual([[reply]]);
});
