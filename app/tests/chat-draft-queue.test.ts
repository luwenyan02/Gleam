import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LifeDraft } from '../src/core/types';
import type { LifeAiInput, LifeChatTurnResult } from '../src/core/repo/lifeAiRepo';

const api = vi.hoisted(() => ({
  put: vi.fn<(draft: LifeDraft) => Promise<void>>(),
  request: vi.fn<(input: LifeAiInput) => Promise<LifeChatTurnResult>>(),
}));
vi.mock('../src/core/repo/lifeDraftRepo', () => ({ putLifeDraft: api.put }));
vi.mock('../src/core/repo/lifeAiRepo', () => ({ continueLifeChat: api.request }));
vi.mock('../src/core/repo/settingsRepo', () => ({ getSetting: async () => true }));
vi.mock('../src/core/store', () => ({ on: () => () => {} }));
import { persistChatDraft, stageChatDraft, startChatReply, unsavedChatDrafts } from '../src/features/life/lifeChatSession';

function draft(key: string): LifeDraft {
  return { key, title: '', body: '', occurredAt: 1, aiExcluded: false, photos: [], existingPhotoRefs: [],
    messages: [{ role: 'user', content: '虚构问题' }] };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function ticks() { for (let i = 0; i < 16; i++) await Promise.resolve(); }

beforeEach(() => {
  api.put.mockReset().mockResolvedValue(undefined);
  api.request.mockReset();
  unsavedChatDrafts.clear();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('慢写期间只写首尾快照，被合并调用等最新内容落盘后才完成', async () => {
  const first = deferred<void>(), last = deferred<void>(), source = draft('chat:queue');
  api.put.mockReturnValueOnce(first.promise).mockReturnValueOnce(last.promise);
  const initial = persistChatDraft(source);
  await ticks(); expect(api.put).toHaveBeenCalledOnce();
  let completed = 0;
  const rest = Array.from({ length: 20 }, (_, index) => {
    source.pendingReply = `虚构修订${index}`;
    return persistChatDraft(source).then(() => { completed++; });
  });
  source.pendingReply = '调用后的未保存修改';
  expect(completed).toBe(0);
  first.resolve(); await initial; await ticks();
  const writes = api.put.mock.calls.length;
  const stored = api.put.mock.calls.at(-1)![0];
  const completedBeforeCommit = completed;
  last.resolve(); await Promise.all(rest);
  expect(writes).toBe(2);
  expect(stored.pendingReply).toBe('虚构修订19');
  expect(completedBeforeCommit).toBe(0);
  expect(completed).toBe(20);
  expect(unsavedChatDrafts.has(source.key)).toBe(false);
});

it('较早写入失败不阻塞合并后的最新写入，失败各自返回', async () => {
  const first = deferred<void>(), source = draft('chat:recover-first');
  api.put.mockReturnValueOnce(first.promise);
  const initial = persistChatDraft(source);
  const rejected = expect(initial).rejects.toThrow('synthetic quota');
  await ticks();
  source.pendingReply = '新的可恢复文字'; const middle = persistChatDraft(source);
  source.pendingReply = '最终文字'; const latest = persistChatDraft(source);
  first.reject(new Error('synthetic quota'));
  await rejected; await Promise.all([middle, latest]);
  expect(api.put).toHaveBeenCalledTimes(2);
  expect(api.put.mock.calls.at(-1)![0].pendingReply).toBe('最终文字');
  expect(unsavedChatDrafts.has(source.key)).toBe(false);
});

it('最新批次失败保留内存草稿，之后重试可以恢复', async () => {
  const first = deferred<void>(), source = draft('chat:recover-last');
  api.put.mockReturnValueOnce(first.promise).mockRejectedValueOnce(new Error('synthetic quota'));
  const initial = persistChatDraft(source); await ticks();
  source.pendingReply = '不能丢失的草稿';
  const latest = persistChatDraft(source), rejected = expect(latest).rejects.toThrow('synthetic quota');
  first.resolve(); await initial; await rejected;
  const retained = unsavedChatDrafts.get(source.key)!;
  expect(retained.pendingReply).toBe('不能丢失的草稿');
  await persistChatDraft(retained);
  expect(unsavedChatDrafts.has(source.key)).toBe(false);
});

it('旧写成功不清除只暂存尚未提交的新副本，不同会话不互相等待', async () => {
  const slow = deferred<void>(), a = draft('chat:slow'), b = draft('chat:other');
  api.put.mockImplementation(value => value.key === a.key ? slow.promise : Promise.resolve());
  const initial = persistChatDraft(a); await ticks();
  a.pendingReply = '新暂存副本'; const staged = stageChatDraft(a);
  await persistChatDraft(b);
  expect(unsavedChatDrafts.has(b.key)).toBe(false);
  slow.resolve(); await initial;
  expect(unsavedChatDrafts.get(a.key)).toBe(staged);
});

it('已经提交的批次不等待不断到来的后续批次', async () => {
  const first = deferred<void>(), second = deferred<void>(), source = draft('chat:batch-promise');
  api.put.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  let firstFinished = false;
  const initial = persistChatDraft(source).then(() => { firstFinished = true; }); await ticks();
  source.pendingReply = '后续草稿'; const latest = persistChatDraft(source);
  first.resolve(); await ticks();
  const finishedBeforeNextWrite = firstFinished;
  second.resolve(); await Promise.all([initial, latest]);
  expect(finishedBeforeNextWrite).toBe(true);
});

const destination = { baseUrl: 'https://example.invalid', model: 'test' };

it('连续输出每秒保存一次最新检查点，完成立即落盘且旧定时器不再写入', async () => {
  vi.useFakeTimers();
  const pending = deferred<LifeChatTurnResult>(), source = draft('chat:periodic');
  api.request.mockReturnValueOnce(pending.promise);
  const reply = startChatReply(source, 0, false, { expectedDestination: destination }); await ticks();
  try {
    expect(api.request).toHaveBeenCalledOnce();
    for (let i = 0; i < 80; i++) api.request.mock.calls[0][0].onDelta?.(`片段${i}`);
    await vi.advanceTimersByTimeAsync(999);
    expect(api.put).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(api.put).toHaveBeenCalledTimes(2);
    expect(api.put.mock.calls.at(-1)![0].chatReply?.content).toBe('片段79');
  } finally {
    pending.resolve({ reply: '完整答案', readyToSummarize: false }); await reply.done;
  }
  expect(api.put.mock.calls.at(-1)![0].messages.at(-1)?.content).toBe('完整答案');
  const count = api.put.mock.calls.length;
  await vi.advanceTimersByTimeAsync(2000); expect(api.put).toHaveBeenCalledTimes(count);
});

it.each(['visibilitychange', 'pagehide'])('不足一秒时 %s 也立即保存已收到文字', async event => {
  vi.useFakeTimers();
  const doc = Object.assign(new EventTarget(), { visibilityState: 'hidden' }), win = new EventTarget();
  vi.stubGlobal('document', doc); vi.stubGlobal('window', win);
  const pending = deferred<LifeChatTurnResult>(), source = draft(`chat:${event}`);
  api.request.mockReturnValueOnce(pending.promise);
  const reply = startChatReply(source, 0, false, { expectedDestination: destination }); await ticks();
  try {
    api.request.mock.calls[0][0].onDelta?.('离开前的文字');
    (event === 'pagehide' ? win : doc).dispatchEvent(new Event(event)); await ticks();
    expect(api.put.mock.calls.at(-1)![0].chatReply?.content).toBe('离开前的文字');
  } finally {
    pending.resolve({ reply: '完整答案', readyToSummarize: false }); await reply.done;
  }
});

it('停止时不等上游收尾即可保存已收到片段，迟到文字不进入草稿', async () => {
  vi.useFakeTimers();
  const pending = deferred<LifeChatTurnResult>(), source = draft('chat:stop-flush');
  api.request.mockReturnValueOnce(pending.promise);
  const reply = startChatReply(source, 0, false, { expectedDestination: destination }); await ticks();
  try {
    const input = api.request.mock.calls[0][0];
    input.onDelta?.('停止前的文字'); reply.stop(); input.onDelta?.('迟到文字'); await ticks();
    expect(api.put.mock.calls.at(-1)![0].chatReply).toMatchObject({ status: 'stopped', content: '停止前的文字' });
  } finally {
    pending.reject(new Error('cancelled')); await reply.done;
  }
});
