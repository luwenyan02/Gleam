import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { db } from '../src/core/db';
import { getSetting, setSetting } from '../src/core/repo/settingsRepo';
import { exportAll, restoreAll, sanitizeDumpForBackup } from '../src/core/repo/backupRepo';
import { type NoteDecisionInput } from '../src/features/entry/noteDecision';

const mocks = vi.hoisted(() => ({ native: true, platform: 'android', key: 'synthetic-note-key', fetch: vi.fn(), getKey: vi.fn() }));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => mocks.native, getPlatform: () => mocks.platform }, registerPlugin: () => ({}) }));
vi.mock('../src/core/secretStore', () => ({ secretStore: { get: mocks.getKey } }));
vi.mock('../src/core/aiStreamTransport', () => ({ fetchAiStream: mocks.fetch }));
const input: NoteDecisionInput = { entryType: 'expense', note: '午饭支付宝', occurredAt: 1000, now: 1000, categories: [{ id: 1, name: '午饭', kind: 'expense' }], accounts: [{ id: 1, name: '支付宝', group: 'online', hidden: false }] };
const response = () => new Response(JSON.stringify({ answers: { category: { type: 'choice', choice: 'c_1', confidence: .99, probabilities: { c_1: .99, unknown: .01 } } } }));
const service = () => import('../src/features/entry/noteDecisionService');
async function configure() {
  await setSetting('ai.baseUrl', 'https://dashscope.aliyuncs.com/compatible-mode/v1');
  await setSetting('ai.noteDecision.workspace', 'synthetic-space');
  await setSetting('ai.noteDecision.enabled', true);
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(async () => {
  await db.delete(); await db.open(); vi.resetAllMocks(); mocks.native = true; mocks.platform = 'android'; mocks.key = 'synthetic-note-key';
  mocks.getKey.mockImplementation(async () => mocks.key); mocks.fetch.mockImplementation(async () => response());
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it('默认关闭，备份脱敏和恢复都不会继承外发授权', async () => {
  expect(await getSetting('ai.noteDecision.enabled')).toBe(false);
  await configure(); const dump = await exportAll();
  expect(sanitizeDumpForBackup(dump).settings).toContainEqual(expect.objectContaining({ key: 'ai.noteDecision.enabled', value: false }));
  await restoreAll(dump); expect(await getSetting('ai.noteDecision.enabled')).toBe(false);
});
it('关闭和网页环境不读取Key、不发请求', async () => {
  const { requestNoteDecision, noteDecisionSupported } = await service();
  expect(await requestNoteDecision(input)).toEqual({});
  await configure(); mocks.native = false;
  expect(noteDecisionSupported()).toBe(false); expect(await requestNoteDecision(input)).toEqual({});
  expect(mocks.getKey).not.toHaveBeenCalled(); expect(mocks.fetch).not.toHaveBeenCalled();
});
it.each(['https://other.invalid/v1', 'https://dashscope.aliyuncs.com.attacker.invalid', 'http://dashscope.aliyuncs.com', 'https://user:pass@dashscope.aliyuncs.com', 'https://dashscope.aliyuncs.com:8443'])('其他平台或不安全地址 %s 不读取或转发Key', async base => {
  await configure(); await setSetting('ai.baseUrl', base);
  expect(await (await service()).requestNoteDecision(input)).toEqual({}); expect(mocks.getKey).not.toHaveBeenCalled(); expect(mocks.fetch).not.toHaveBeenCalled();
});
it.each([['beijing', 'cn-beijing'], ['singapore', 'ap-southeast-1']] as const)('仅发往固定地域 %s，JSON使用纯模型投影', async (region, host) => {
  await configure(); await setSetting('ai.noteDecision.region', region);
  expect(await (await service()).requestNoteDecision(input)).toMatchObject({ category: { id: 1 } });
  const [url, init] = mocks.fetch.mock.calls[0];
  expect(url).toBe(`https://synthetic-space.${host}.maas.aliyuncs.com/compatible-mode/v1/systemone`);
  expect(init.method).toBe('POST'); expect(new Headers(init.headers).get('Authorization')).toBe('Bearer synthetic-note-key');
  const body = JSON.parse(init.body); expect(body.model).toBe('decision-model-preview'); expect(body.state.note).toBe(input.note); expect(body.questions.category.criteria.c_1).toBe('午饭');
});
it('空备注和非法空间不请求', async () => {
  await configure(); expect(await (await service()).requestNoteDecision({ ...input, note: '' })).toEqual({});
  await setSetting('ai.noteDecision.workspace', 'space/evil'); expect(await (await service()).requestNoteDecision(input)).toEqual({}); expect(mocks.fetch).not.toHaveBeenCalled();
});
it('外部取消立即结束且迟到结果不能采用', async () => {
  await configure(); const pending = deferred<Response>(); mocks.fetch.mockReturnValue(pending.promise); const abort = new AbortController();
  const result = (await service()).requestNoteDecision(input, abort.signal); await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalled()); abort.abort();
  expect(await result).toEqual({}); expect(mocks.fetch.mock.calls[0][1].signal.aborted).toBe(true); pending.resolve(response());
});
it('12秒超时中止不会阻塞保存，网络不响应也立即完成', async () => {
  await configure(); mocks.fetch.mockReturnValue(new Promise(() => {})); const { requestNoteDecision } = await service();
  const timers = vi.spyOn(globalThis, 'setTimeout');
  const result = requestNoteDecision(input); await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalled());
  const timeout = timers.mock.calls.find(([, ms]) => ms === 12_000);
  expect(timeout).toBeDefined(); (timeout![0] as () => void)();
  expect(await result).toEqual({}); expect(mocks.fetch.mock.calls[0][1].signal.aborted).toBe(true);
});
it.each(['enabled', 'workspace', 'region', 'base', 'key'] as const)('请求中 %s 改变，迟到结果丢弃', async field => {
  await configure(); const pending = deferred<Response>(); mocks.fetch.mockReturnValue(pending.promise);
  const result = (await service()).requestNoteDecision(input); await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalled());
  if (field === 'enabled') await setSetting('ai.noteDecision.enabled', false);
  if (field === 'workspace') await setSetting('ai.noteDecision.workspace', 'another-space');
  if (field === 'region') await setSetting('ai.noteDecision.region', 'singapore');
  if (field === 'base') await setSetting('ai.baseUrl', 'https://other.invalid');
  if (field === 'key') mocks.key = 'changed-synthetic-key';
  pending.resolve(response()); expect(await result).toEqual({});
});
it('HTTP错误只返回通用错误，不包含响应原文', async () => {
  await configure(); mocks.fetch.mockResolvedValue(new Response('sensitive upstream content', { status: 401 }));
  await expect((await service()).requestNoteDecision(input)).rejects.toThrow('备注推荐暂不可用，请稍后重试');
});
it.each(['not json', JSON.stringify({ answers: { category: { choice: 'c_1' } } }), 'x'.repeat(1024 * 1024 + 1)])('非法JSON、schema或超限响应安全拒绝', async body => {
  await configure(); mocks.fetch.mockResolvedValue(new Response(body));
  const result = await (await service()).requestNoteDecision(input).catch(error => error.message);
  expect([JSON.stringify({}), JSON.stringify('备注推荐暂不可用，请稍后重试')]).toContain(JSON.stringify(result));
});

it('网页设置折叠显示独立配置、披露数据范围且禁用开启', async () => {
  mocks.native = false;
  const html = await (await import('../src/features/settings/noteDecisionSettings')).noteDecisionSettingsHtml();
  expect(html).toContain('<summary>备注智能推荐（试验）</summary>'); expect(html).toContain('仅 Android 可用');
  expect(html).toMatch(/id="note-decision-enabled"[^>]*disabled/); expect(html).toContain('近 7/30/90 天使用统计');
  expect(html).toContain('高置信'); expect(html).toContain('仍需手动保存'); expect(html).not.toContain('type="password"');
});
it('网页版恢复的开启状态仍可关闭，不能重新开启', async () => {
  mocks.native = false; await configure();
  const settings = await import('../src/features/settings/noteDecisionSettings');
  expect(await settings.noteDecisionSettingsHtml()).not.toMatch(/id="note-decision-enabled"[^>]*disabled/);
  await settings.setNoteDecisionEnabled(false); expect(await getSetting('ai.noteDecision.enabled')).toBe(false);
  await expect(settings.setNoteDecisionEnabled(true)).rejects.toThrow('仅 Android 可用');
});
it('其他平台不能开启，也不会更改AI及语音已验证配置', async () => {
  await setSetting('ai.baseUrl', 'https://other.invalid/v1'); await setSetting('voice.bailian.workspace', 'voice-space');
  await setSetting('voice.bailian.region', 'singapore');
  await expect((await import('../src/features/settings/noteDecisionSettings')).setNoteDecisionEnabled(true)).rejects.toThrow('请先配置百炼 AI 记账');
  expect(await getSetting('ai.baseUrl')).toBe('https://other.invalid/v1');
  expect(await getSetting('voice.bailian.workspace')).toBe('voice-space'); expect(await getSetting('voice.bailian.region')).toBe('singapore');
});
