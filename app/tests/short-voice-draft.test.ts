import 'fake-indexeddb/auto';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { db } from '../src/core/db';
import { secretStore } from '../src/core/secretStore';
import { setSetting } from '../src/core/repo/settingsRepo';
import {
  prepareVoiceRecognition, approveVoiceRecognition, recognizeVoiceDraft,
  revokeVoicePreview, type VoiceRecognitionPreview,
} from '../src/core/repo/aiRepo';
import { canAutoConfirmAiItem, voiceDraftItem } from '../src/core/aiInboxPolicy';

const valid = { type: 'expense', amount: '28.01', category: '餐饮/午餐', account: '虚构现金',
  time: '2026-10-02 12:00', note: '虚构午餐', confidence: 100 };
const response = (raw: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: typeof raw === 'string' ? raw : JSON.stringify(raw) } }] }),
  { status: 200, headers: { 'Content-Type': 'application/json' } });

beforeEach(async () => {
  vi.unstubAllGlobals();
  await db.delete(); await db.open();
  await db.categories.bulkPut([
    { id: 1, name: '餐饮', kind: 'expense', icon: '', sortOrder: 1, createdAt: 1, updatedAt: 1 },
    { id: 2, name: '午餐', kind: 'expense', parentId: 1, icon: '', sortOrder: 2, createdAt: 1, updatedAt: 1 },
    { id: 3, name: '工资', kind: 'income', icon: '', sortOrder: 1, createdAt: 1, updatedAt: 1 },
  ]);
  await db.accounts.put({ id: 1, name: '虚构现金', group: 'cash', balance: 123456, hidden: false, countInNetWorth: true,
    sortOrder: 1, createdAt: 1, updatedAt: 1 });
  await db.entries.put({ id: 1, type: 'expense', amount: 999, occurredAt: 1, accountId: 1, categoryId: 2,
    note: 'PRIVATE_OLD_ENTRY', reimburseStatus: 'none', deletedAt: 0, createdAt: 1, updatedAt: 1 });
  await setSetting('ai.baseUrl', 'https://voice-test.invalid/v1');
  await setSetting('ai.model', 'test-model');
  await secretStore.set('ai.apiKey', 'synthetic-only-key');
  vi.stubGlobal('fetch', vi.fn(async () => response([valid])));
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await secretStore.remove('ai.apiKey'); });

it('预览不发送；同意才发送已预览文本、候选名称和目的地，无账本余额或旧备注', async () => {
  const preview = await prepareVoiceRecognition('午餐花了28.01元，虚构现金');
  expect(preview.text).toBe('午餐花了28.01元，虚构现金');
  expect(preview.destination).toEqual({ baseUrl: 'https://voice-test.invalid/v1', model: 'test-model' });
  expect(preview.categoryNames).toEqual(['餐饮/午餐', '工资']);
  expect(preview.accountNames).toEqual(['虚构现金']);
  expect(fetch).not.toHaveBeenCalled();
  const before = await db.entries.toArray();
  const bill = await recognizeVoiceDraft(approveVoiceRecognition(preview));
  expect(bill).toMatchObject({ amount: 2801, confidence: 100 });
  const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
  expect(body.messages).toHaveLength(2);
  expect(body.messages[1].content).toBe(preview.text);
  expect(JSON.stringify(body)).toContain('餐饮/午餐');
  expect(JSON.stringify(body)).not.toMatch(/PRIVATE_OLD_ENTRY|123456|synthetic-only-key|audio|image_url/);
  expect(await db.entries.toArray()).toEqual(before);
});

it('授权一次消费，伪造、取消或二次确认都不能发送', async () => {
  expect(() => approveVoiceRecognition({} as VoiceRecognitionPreview)).toThrow('重新预览');
  const cancelled = await prepareVoiceRecognition('午餐28元'); revokeVoicePreview(cancelled);
  expect(() => approveVoiceRecognition(cancelled)).toThrow('重新预览');
  const preview = await prepareVoiceRecognition('午餐28元');
  const grant = approveVoiceRecognition(preview);
  expect(() => approveVoiceRecognition(preview)).toThrow('重新预览');
  await recognizeVoiceDraft(grant);
  await expect(recognizeVoiceDraft(grant)).rejects.toThrow('重新确认');
  expect(fetch).toHaveBeenCalledOnce();
});

it.each(['ai.baseUrl', 'ai.model'] as const)('目的地 %s 变化后不发往新服务', async key => {
  const grant = approveVoiceRecognition(await prepareVoiceRecognition('午餐28元'));
  await setSetting(key, key === 'ai.baseUrl' ? 'https://new.invalid' : 'new-model');
  await expect(recognizeVoiceDraft(grant)).rejects.toThrow('配置已变化');
  expect(fetch).not.toHaveBeenCalled();
});

it('取消前不发送，取消后迟到响应不会形成草稿，失败重试需重新同意', async () => {
  const controller = new AbortController(); controller.abort();
  const grant = approveVoiceRecognition(await prepareVoiceRecognition('午餐28元'));
  await expect(recognizeVoiceDraft(grant, controller.signal)).rejects.toThrow('取消');
  expect(fetch).not.toHaveBeenCalled();
  let resolve!: (value: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(done => { resolve = done; })));
  const live = new AbortController();
  const pending = recognizeVoiceDraft(approveVoiceRecognition(await prepareVoiceRecognition('午餐28元')), live.signal);
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  live.abort(); resolve(response([valid]));
  await expect(pending).rejects.toThrow('取消');
});

it('私密接口错误不读取回显正文、不记录文字', async () => {
  const text = vi.fn(async () => 'PRIVATE_ECHO');
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, text })));
  const warn = vi.spyOn(console, 'warn');
  await expect(recognizeVoiceDraft(approveVoiceRecognition(await prepareVoiceRecognition('午餐28元')))).rejects.toThrow();
  expect(text).not.toHaveBeenCalled(); expect(warn).not.toHaveBeenCalled();
});

it.each(['转账100元', '借出100元', '收到退款20元', '报销到账50元', '还信用卡100元', '借款100元'])('特殊账务 %s 不降级成支出收入', async text => {
  await expect(prepareVoiceRecognition(text)).rejects.toThrow('手动');
  expect(fetch).not.toHaveBeenCalled();
});

it.each([
  [], [valid, valid], [{ ...valid, type: 'transfer' }], [{ ...valid, type: 'loan' }], [{ ...valid, type: 'refund' }],
  [{ ...valid, amount: -1 }], [{ ...valid, amount: '28.001' }], [{ ...valid, amount: 28.001 }],
  [{ ...valid, amount: '90071992547409.91' }], [{ ...valid, amount: null }], '午餐28元', '{invalid}',
])('只接受单笔、明确类型、可安全精确转为整数分的 JSON：%j', async raw => {
  vi.stubGlobal('fetch', vi.fn(async () => response(raw)));
  await expect(recognizeVoiceDraft(approveVoiceRecognition(await prepareVoiceRecognition('午餐28元')))).rejects.toThrow();
});

it('语音即使置信度100且自动阈值0也必须人工确认，旧素材仍按既有规则', () => {
  const item = voiceDraftItem({ type: 'expense', amount: 2801, occurredAt: 1, confidence: 100 }, '虚构原文');
  expect(item).toMatchObject({ status: 'ready', source: 'voice', rawText: '虚构原文' });
  expect(canAutoConfirmAiItem({ ...item, confidence: 100 }, 0)).toBe(false);
  expect(canAutoConfirmAiItem({ ...item, source: 'paste', confidence: 100 }, 80)).toBe(true);
  expect(canAutoConfirmAiItem({ ...item, source: 'paste', status: 'pending', confidence: 100 }, 0)).toBe(false);
});

it('语音候选排除应收应付账户，模型返回非候选账户不能被模糊映射', async () => {
  await db.accounts.put({ id: 2, name: '虚构应收应付', group: 'receivable', balance: 12345, hidden: false,
    countInNetWorth: true, sortOrder: 2, createdAt: 1, updatedAt: 1 });
  const preview = await prepareVoiceRecognition('午餐28元');
  expect(preview.accountNames).not.toContain('虚构应收应付');
  vi.stubGlobal('fetch', vi.fn(async () => response([{ ...valid, account: '虚构应收应付' }])));
  const bill = await recognizeVoiceDraft(approveVoiceRecognition(preview));
  expect(bill.accountName).toBeUndefined();
  expect(JSON.stringify(JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string))).not.toContain('虚构应收应付');
});
