import 'fake-indexeddb/auto';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { db } from '../src/core/db';
import { secretStore } from '../src/core/secretStore';
import { setSetting } from '../src/core/repo/settingsRepo';
import { generateLifeSummary } from '../src/core/repo/lifeAiRepo';
import { addLifeNote } from '../src/core/repo/lifeRepo';
import type { LifeChatMessage } from '../src/core/types';

const destination = { baseUrl: 'https://summary-only.invalid/v1', model: 'synthetic-summary' };
const response = (content: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { headers: { 'Content-Type': 'application/json' } });
const proposal = (count: number) => ({ title: '虚构公园随记', body: '我在公园散步。', tags: ['公园'], sourceMessageCount: count });
const longMessages = (): LifeChatMessage[] => Array.from({ length: 60 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `虚构消息${i}：${'散步时看见树叶，保留原始细节。'.repeat(60)}` }));

beforeEach(async () => {
  await db.delete(); await db.open();
  await setSetting('ai.baseUrl', destination.baseUrl); await setSetting('ai.model', destination.model);
  await setSetting('life.aiEnabled', true); await secretStore.set('ai.apiKey', 'synthetic-summary-key');
});
afterEach(async () => { vi.unstubAllGlobals(); vi.restoreAllMocks(); await secretStore.remove('ai.apiKey'); });

it('超过30条但文字不长的历史一次整理，完整发送每条文字，不发送历史照片或元数据', async () => {
  const messages: LifeChatMessage[] = Array.from({ length: 42 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `虚构短消息${i}`, photos: [{ name: '不应重复发送.png', dataUrl: 'data:image/png;base64,AQ==' }] }));
  const fetchSpy = vi.fn(async (_url: string, init: RequestInit) => {
    const source = JSON.parse(JSON.parse(String(init.body)).messages[1].content);
    expect(source.对话).toEqual(messages.map(({ role, content }) => ({ role, content })));
    return response(proposal(messages.length));
  });
  vi.stubGlobal('fetch', fetchSpy);
  await expect(generateLifeSummary({ body: '', messages, expectedDestination: destination })).resolves.toEqual(proposal(42));
  expect(fetchSpy).toHaveBeenCalledOnce();
});

it('长历史分段完整覆盖每条原话，再合并为一个方案，保留输入和全量消息版本', async () => {
  const messages = longMessages(), before = structuredClone(messages), sent: any[] = [], stages: unknown[] = [];
  const fetchSpy = vi.fn(async (_url: string, init: RequestInit) => {
    const payload = JSON.parse(String(init.body)), source = JSON.parse(payload.messages[1].content);
    expect(payload.messages[1].content.length).toBeLessThanOrEqual(24_000);
    expect(payload.model).toBe(destination.model);
    sent.push(source);
    return response(source.对话 ? { notes: `第${sent.length}段：用户明确说在公园散步。` } : proposal(messages.length));
  });
  vi.stubGlobal('fetch', fetchSpy);
  const result = await generateLifeSummary({ body: '虚构开头', messages, expectedDestination: destination, onSummaryProgress: value => stages.push(value) });
  expect(result.sourceMessageCount).toBe(messages.length);
  const pieces = sent.filter(source => source.对话);
  expect(pieces.length).toBeGreaterThan(1);
  expect(pieces.flatMap(source => source.对话)).toEqual([{ role: 'user', content: '虚构开头' }, ...messages.map(({ role, content }) => ({ role, content }))]);
  expect(sent.at(-1).分段素材).toHaveLength(pieces.length);
  expect(stages).toContainEqual(expect.objectContaining({ stage: 'summary' }));
  expect(messages).toEqual(before);
  expect(await db.lifeDrafts.count()).toBe(0); expect(await db.lifeNotes.count()).toBe(0);
});

it('单条超长消息按Unicode边界分割，所有字符都被发送且不修改原文', async () => {
  const text = '虚构emoji🌱与引号"换行\n'.repeat(2100), parts: LifeChatMessage[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const payload = JSON.parse(String(init.body)), source = JSON.parse(payload.messages[1].content);
    expect(payload.messages[1].content.length).toBeLessThanOrEqual(24_000);
    if (source.对话) {
      parts.push(...source.对话);
      for (const part of source.对话) expect(part.content).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
    }
    return response(source.对话 ? { notes: '用户在虚构公园散步。' } : proposal(1));
  }));
  await generateLifeSummary({ body: '', messages: [{ role: 'user', content: text }], expectedDestination: destination });
  expect(parts.map(part => part.content).join('')).toBe(text);
});

it('分段失败不自动重试，不返回部分方案也不保存原始会话', async () => {
  const fetchSpy = vi.fn().mockResolvedValueOnce(response({ notes: '第一段素材' })).mockResolvedValueOnce(new Response('', { status: 500 }));
  vi.stubGlobal('fetch', fetchSpy);
  await expect(generateLifeSummary({ body: '', messages: longMessages(), expectedDestination: destination })).rejects.toThrow('暂时不可用');
  expect(fetchSpy).toHaveBeenCalledTimes(2);
  expect(await db.lifeDrafts.count()).toBe(0); expect(await db.lifeNotes.count()).toBe(0);
});

it('分段之间取消，不能继续发送下一段或采用迟到结果', async () => {
  const controller = new AbortController();
  const fetchSpy = vi.fn(async () => { controller.abort(); return response({ notes: '已取消的分段' }); });
  vi.stubGlobal('fetch', fetchSpy);
  await expect(generateLifeSummary({ body: '', messages: longMessages(), expectedDestination: destination, signal: controller.signal })).rejects.toThrow(/取消|中止/);
  expect(fetchSpy).toHaveBeenCalledOnce();
});

it('分段之间更换目的地，不能将剩余原话发给新服务', async () => {
  const fetchSpy = vi.fn(async () => { await setSetting('ai.baseUrl', 'https://different.invalid/v1'); return response({ notes: '旧服务的素材' }); });
  vi.stubGlobal('fetch', fetchSpy);
  await expect(generateLifeSummary({ body: '', messages: longMessages(), expectedDestination: destination })).rejects.toThrow('配置已变化');
  expect(fetchSpy).toHaveBeenCalledOnce();
});

it('分段之间原记录被修改，停止后续请求且不采用旧素材', async () => {
  const noteId = await addLifeNote({ kind: 'diary', body: '虚构来源', occurredAt: Date.now() });
  const sourceUpdatedAt = (await db.lifeNotes.get(noteId))!.updatedAt;
  const fetchSpy = vi.fn(async () => { await db.lifeNotes.update(noteId, { updatedAt: sourceUpdatedAt + 1 }); return response({ notes: '旧记录' }); });
  vi.stubGlobal('fetch', fetchSpy);
  await expect(generateLifeSummary({ body: '', messages: longMessages(), noteId, sourceUpdatedAt, expectedDestination: destination })).rejects.toThrow('原记录已有更新');
  expect(fetchSpy).toHaveBeenCalledOnce();
});

it('拒绝超出有界分段预算的历史，在任何模型请求前清楚报错', async () => {
  const fetchSpy = vi.fn(); vi.stubGlobal('fetch', fetchSpy);
  await expect(generateLifeSummary({ body: '', messages: [{ role: 'user', content: '字'.repeat(200_001) }] })).rejects.toThrow(/过长.*保留/);
  expect(fetchSpy).not.toHaveBeenCalled();
});

it('拒绝过长或伪造的中间素材，不能把非法输出继续发给模型', async () => {
  const fetchSpy = vi.fn(async () => response({ notes: '字'.repeat(2001) })); vi.stubGlobal('fetch', fetchSpy);
  await expect(generateLifeSummary({ body: '', messages: longMessages() })).rejects.toThrow('分段整理');
  expect(fetchSpy).toHaveBeenCalledOnce();
});

it('中间提要仍较长时有界归并所有分段，不能超出请求限制或丢掉任一段', async () => {
  const messages: LifeChatMessage[] = Array.from({ length: 12 }, (_, i) => ({ role: 'user', content: `虚构段${i}：${'字'.repeat(15_980)}` }));
  const originals: string[] = [], merges: string[] = [], finalMaterials: string[][] = [];
  const fetchSpy = vi.fn(async (_url: string, init: RequestInit) => {
    const payload = JSON.parse(String(init.body)), source = JSON.parse(payload.messages[1].content);
    expect(payload.messages[1].content.length).toBeLessThanOrEqual(24_000);
    if (source.对话) {
      const marker = `片段${originals.length}`; originals.push(marker);
      return response({ notes: marker + '\\'.repeat(1_975) });
    }
    if (payload.messages[0].content.includes('sourceMessageCount必须')) {
      finalMaterials.push(source.分段素材);
      return response(proposal(12));
    }
    const included = (source.分段素材 as string[]).map(note => note.match(/^片段\d+/)![0]).join('、');
    merges.push(included);
    return response({ notes: included });
  });
  vi.stubGlobal('fetch', fetchSpy);
  const result = await generateLifeSummary({ body: '', messages, expectedDestination: destination });
  expect(result.sourceMessageCount).toBe(12);
  expect(originals).toHaveLength(12);
  expect(merges.length).toBeGreaterThan(1);
  expect(merges.length).toBeLessThan(originals.length);
  expect(finalMaterials).toEqual([merges]);
  expect(merges.join('、').split('、')).toEqual(originals);
  expect(fetchSpy.mock.calls.length).toBeLessThanOrEqual(2 * originals.length);
});

it('消息数量或转义后的分段数超限时，仍在首个请求前停止', async () => {
  const fetchSpy = vi.fn(); vi.stubGlobal('fetch', fetchSpy);
  await expect(generateLifeSummary({ body: '', messages: Array.from({ length: 2_001 }, () => ({ role: 'user' as const, content: '虚构消息' })) })).rejects.toThrow(/过长.*保留/);
  await expect(generateLifeSummary({ body: '', messages: [{ role: 'user', content: '\u0001'.repeat(85_000) }] })).rejects.toThrow(/过长.*保留/);
  expect(fetchSpy).not.toHaveBeenCalled();
});

it('分段期间关闭生活AI，不再继续发送剩余素材', async () => {
  const fetchSpy = vi.fn(async () => { await setSetting('life.aiEnabled', false); return response({ notes: '关闭前的素材' }); });
  vi.stubGlobal('fetch', fetchSpy);
  await expect(generateLifeSummary({ body: '', messages: longMessages(), expectedDestination: destination })).rejects.toThrow(/开启|关闭/);
  expect(fetchSpy).toHaveBeenCalledOnce();
});
