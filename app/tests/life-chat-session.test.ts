import 'fake-indexeddb/auto';
import { beforeEach, expect, it, vi } from 'vitest';
import { db } from '../src/core/db';
import type { LifeDraft } from '../src/core/types';
import type { LifeAiInput, LifeChatTurnResult } from '../src/core/repo/lifeAiRepo';
import { getLifeDraft, migrateLifeDraft, validateLifeDraft } from '../src/core/repo/lifeDraftRepo';
import { emit } from '../src/core/store';
import type { LifeLedgerReview } from '../src/core/repo/lifeLedgerContextRepo';

const request = vi.hoisted(() => vi.fn<(input: LifeAiInput) => Promise<LifeChatTurnResult>>());
vi.mock('../src/core/repo/lifeAiRepo', () => ({ continueLifeChat: request }));
import { getActiveChatReply, persistChatDraft, startChatReply, unsavedChatDrafts } from '../src/features/life/lifeChatSession';

function draft(key = 'chat:new'): LifeDraft {
  return { key, title: '', body: '', occurredAt: 1, aiExcluded: false, photos: [], existingPhotoRefs: [],
    messages: [{ role: 'user', content: '虚构旅行计划' }] };
}
function hold() {
  let resolve!: (result: LifeChatTurnResult) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<LifeChatTurnResult>((yes, no) => { resolve = yes; reject = no; });
  request.mockReturnValueOnce(promise);
  return { resolve, reject };
}
const destination = { baseUrl: 'https://example.invalid', model: 'test' };

it('明确流式完成后才采用图表，重新回答不会残留旧图', async () => {
  const pending = hold(), source = draft();
  const chart = { version: 1, type: 'bar', title: '虚构图表', labels: ['一', '二'], series: [{ name: '数值', values: [1, 2] }] };
  const content = `虚构说明\n\n\`\`\`gleam-chart\n${JSON.stringify(chart)}\n\`\`\``;
  const reply = startChatReply(source, 0, false, { expectedDestination: destination });
  await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
  request.mock.calls[0][0].onDelta?.(content);
  expect(source.messages).toHaveLength(1);
  pending.resolve({ reply: content, readyToSummarize: false }); await reply.done;
  expect((await getLifeDraft(source.key))?.messages[1]).toMatchObject({ chart, content });
  const next = hold();
  const again = startChatReply(source, 0, true, { expectedDestination: destination });
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  next.resolve({ reply: '纯文字新回答', readyToSummarize: false }); await again.done;
  expect(source.messages).toHaveLength(2);
  expect(source.messages[1].chart).toBeUndefined();
});

it('账本图表忽略模型提供的数字，以已确认本机快照替代且可恢复', async () => {
  const source = draft(), pending = hold();
  const review: LifeLedgerReview = { question: '把我的本月支出画成柱状图', summary: {
    scope: { month: '2026-10', period: 'calendar', includeIncome: false }, range: { from: 1, to: 2, label: '虚构范围' },
    currency: 'CNY', unit: 'fen', reimbursementMode: 'offset',
    totals: { expenseFen: 12345, grossExpenseFen: 12345, refundFen: 0, reimbursementOffsetFen: 0, expenseCount: 1, refundCount: 0 },
    categories: [{ name: '本机分类', expenseFen: 12345, count: 1 }],
  } };
  const forged = { version: 1, type: 'bar', title: '模型伪造', labels: ['模型分类'], series: [{ name: '数值', values: [999999] }] };
  const reply = startChatReply(source, 0, false, { expectedDestination: destination, ledgerAnalysis: true, ledgerReview: review });
  await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
  pending.resolve({ reply: `请看图表。\n\`\`\`gleam-chart\n${JSON.stringify(forged)}\n\`\`\``, readyToSummarize: false });
  await reply.done;
  const saved = (await getLifeDraft(source.key))!.messages[1];
  expect(saved.chart).toMatchObject({ labels: ['本机分类'], series: [{ name: '净支出', values: [12345] }], valueDivisor: 100 });
  expect(saved.ledgerAnalysis).toBe(true);
  expect(saved.content).not.toContain('999999');
  expect(source.chatReply).toBeUndefined();
  review.summary.categories[0].expenseFen = NaN;
  const next = hold();
  const again = startChatReply(source, 0, true, { expectedDestination: destination, ledgerAnalysis: true, ledgerReview: review });
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  next.resolve({ reply: '文字回复已完成', readyToSummarize: false }); await again.done;
  const fallback = (await getLifeDraft(source.key))!.messages[1];
  expect(fallback.chart).toBeUndefined();
  expect(fallback.content).toContain('文字回复已完成');
  expect(fallback.content).toContain('图表暂时无法绘制');
  expect(source.chatReply).toBeUndefined();
  expect(again.error).toBeUndefined();
});

it('搜索进度和来源随回复检查点保存，最终消息保留来源，重新回答不继承旧来源', async () => {
  const pending = hold(), source = draft();
  const search = { status: 'searched' as const, sources: [{ title: '虚构来源', url: 'https://source.example.invalid/' }] };
  const reply = startChatReply(source, 0, false, { expectedDestination: destination });
  await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
  request.mock.calls[0][0].onSearch?.(search);
  request.mock.calls[0][0].onDelta?.('已搜索的片段');
  await persistChatDraft(source);
  const checkpoint = (await getLifeDraft(source.key))?.chatReply?.search;
  pending.resolve({ reply: '完整回复', readyToSummarize: false, search }); await reply.done;
  expect(checkpoint).toEqual(search);
  expect((await getLifeDraft(source.key))?.messages.at(-1)?.search).toEqual(search);
  const again = hold();
  const regenerated = startChatReply(source, 0, true, { expectedDestination: destination });
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  expect(source.chatReply?.search).toBeUndefined();
  again.resolve({ reply: '未搜索的新回复', readyToSummarize: false, search: { status: 'not-used', sources: [] } });
  await regenerated.done;
  expect(source.messages.at(-1)?.search).toEqual({ status: 'not-used', sources: [] });
});

beforeEach(async () => {
  vi.restoreAllMocks();
  request.mockReset(); unsavedChatDrafts.clear();
  await db.delete(); await db.open();
});

it('重启恢复保留检查点，拒绝损坏的消息引用、状态及超长文字', () => {
  const source = draft();
  source.chatReply = { messageIndex: 0, regenerate: false, status: 'streaming', content: '已收到的片段' };
  const restored = migrateLifeDraft(source);
  expect(restored.chatReply).toEqual(source.chatReply);
  expect(restored.messages).toHaveLength(1);
  for (const change of [{ messageIndex: -1 }, { messageIndex: 1 }, { status: 'complete' }, { content: '字'.repeat(12_001) }, { regenerate: 1 }, { ledgerAnalysis: 'yes' }]) {
    expect(() => validateLifeDraft({ ...source, chatReply: { ...source.chatReply, ...change } })).toThrow('未完成回复');
  }
});

it('磁盘写入失败仍留住完整回复，重新保存能恢复，不伪报保存成功', async () => {
  const pending = hold(), source = draft();
  const write = vi.spyOn(db.lifeDrafts, 'put').mockRejectedValue(new Error('synthetic quota'));
  const reply = startChatReply(source, 0, false, { expectedDestination: destination });
  await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
  pending.resolve({ reply: '完整回复仍在内存', readyToSummarize: false });
  await reply.done;
  expect(reply.saveFailed).toBe(true);
  expect(unsavedChatDrafts.get(source.key)?.messages.at(-1)?.content).toBe('完整回复仍在内存');
  write.mockRestore();
  await persistChatDraft(unsavedChatDrafts.get(source.key)!);
  expect((await getLifeDraft(source.key))?.messages.at(-1)?.content).toBe('完整回复仍在内存');
  expect(unsavedChatDrafts.has(source.key)).toBe(false);
});

it('重试在收到新片段前失败，不抹去原来已收到的文字', async () => {
  const pending = hold(), source = draft();
  source.chatReply = { messageIndex: 0, regenerate: false, status: 'failed', content: '原有片段' };
  const reply = startChatReply(source, 0, false, { expectedDestination: destination });
  await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
  pending.reject(new Error('network')); await reply.done;
  expect((await getLifeDraft(source.key))?.chatReply?.content).toBe('原有片段');
});

it('离页只取消订阅，等待和流式回复都能重接同一请求，完成后持久化且不重复发送', async () => {
  const pending = hold(), source = draft();
  const reply = startChatReply(source, 0, false, { expectedDestination: destination });
  const observer = vi.fn(), off = reply.subscribe(observer);
  await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
  const input = request.mock.calls[0][0];
  off();
  expect(input.signal?.aborted).toBe(false);
  input.onDelta?.('先从北京出发');
  expect(observer).not.toHaveBeenCalled();
  expect(getActiveChatReply(source.key)).toBe(reply);
  expect(reply.draft.chatReply?.content).toBe('先从北京出发');
  await persistChatDraft(reply.draft);
  expect((await getLifeDraft(source.key))?.chatReply?.content).toBe('先从北京出发');
  const reentered = vi.fn(); reply.subscribe(reentered);
  input.onDelta?.('先从北京出发，安排一周的行程。');
  expect(reentered).toHaveBeenCalledOnce();
  pending.resolve({ reply: '先从北京出发，安排一周的行程。', readyToSummarize: false });
  await reply.done;
  expect(reply.running).toBe(false);
  expect(getActiveChatReply(source.key)).toBeUndefined();
  const stored = await getLifeDraft(source.key);
  expect(stored?.messages.map(m => m.role)).toEqual(['user', 'assistant']);
  expect(stored?.chatReply).toBeUndefined();
  expect(request).toHaveBeenCalledOnce();
});

it('同会话禁止重复请求，其他会话互不覆盖，失败保留已收到文字供重启恢复', async () => {
  const first = hold(), second = hold();
  const a = startChatReply(draft('chat:a'), 0, false, { expectedDestination: destination });
  expect(startChatReply(a.draft, 0, false, { expectedDestination: destination })).toBe(a);
  const b = startChatReply(draft('chat:b'), 0, false, { expectedDestination: destination });
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  request.mock.calls[0][0].onDelta?.('收到的半段回复');
  first.reject(new Error('网络中断'));
  second.resolve({ reply: '另一个会话的回复', readyToSummarize: false });
  await Promise.all([a.done, b.done]);
  expect((await getLifeDraft('chat:a'))?.chatReply).toMatchObject({ status: 'failed', content: '收到的半段回复', messageIndex: 0 });
  expect((await getLifeDraft('chat:a'))?.messages).toHaveLength(1);
  expect((await getLifeDraft('chat:b'))?.messages.at(-1)?.content).toBe('另一个会话的回复');
});

it('停止后不接收迟到的片段或完整回复，部分文字仍可恢复和重试', async () => {
  const pending = hold(), reply = startChatReply(draft(), 0, false, { expectedDestination: destination });
  await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
  const input = request.mock.calls[0][0];
  input.onDelta?.('已收到'); reply.stop(); input.onDelta?.('不应收到');
  pending.resolve({ reply: '迟到的结果', readyToSummarize: false });
  await reply.done;
  expect(input.signal?.aborted).toBe(true);
  expect((await getLifeDraft('chat:new'))?.chatReply).toMatchObject({ status: 'stopped', content: '已收到' });
  expect(reply.draft.messages).toHaveLength(1);
});

it('重新回答未完成时保留原回答，成功后才替换；账本标记不随重试丢失', async () => {
  const pending = hold(), source = draft();
  source.messages.push({ role: 'assistant', content: '原回答', ledgerAnalysis: true });
  const reply = startChatReply(source, 0, true, { expectedDestination: destination, ledgerAnalysis: true });
  await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
  request.mock.calls[0][0].onDelta?.('新回答片段');
  expect(source.messages.at(-1)?.content).toBe('原回答');
  pending.resolve({ reply: '新回答', readyToSummarize: false }); await reply.done;
  expect(source.messages).toHaveLength(2);
  expect(source.messages[0].ledgerAnalysis).toBe(true);
  expect(source.messages[1]).toMatchObject({ content: '新回答', ledgerAnalysis: true });
});

it('写入按会话排序，旧进度不能覆盖后续完整回复；关闭生活 AI 能停止离页请求', async () => {
  const pending = hold(), source = draft();
  await db.settings.put({ key: 'life.aiEnabled', value: false, updatedAt: 1 });
  const reply = startChatReply(source, 0, false, { expectedDestination: destination });
  await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
  request.mock.calls[0][0].onDelta?.('半段');
  const write = persistChatDraft(source);
  emit('settings-changed');
  await vi.waitFor(() => expect(request.mock.calls[0][0].signal?.aborted).toBe(true));
  pending.reject(new Error('已取消')); await Promise.all([write, reply.done]);
  expect((await getLifeDraft(source.key))?.chatReply?.status).toBe('stopped');
});
