import { afterEach, expect, it, vi } from 'vitest';
import { BailianVoiceSession, shortVoiceError } from '../src/core/bailianVoiceSession';
import { bailianVoiceDestination, validateBailianVoiceConfig, BAILIAN_VOICE_MODEL } from '../src/core/bailianVoiceConfig';
import type { NativeSpeechPlugin, NativeSpeechStateEvent, NativeSpeechResult } from '../src/core/nativeSpeech';

const config = { region: 'beijing' as const, workspace: 'synthetic-workspace', model: BAILIAN_VOICE_MODEL };
const readiness = { supported: true, hasKey: true, credentialRevision: 'synthetic-revision' };
function setup() {
  let event!: (value: NativeSpeechStateEvent) => void;
  let resolve!: (value: NativeSpeechResult) => void;
  const remove = vi.fn(async () => {});
  const bridge = { addListener: vi.fn(async (_name, callback) => { event = callback; return { remove }; }),
    start: vi.fn(() => new Promise<NativeSpeechResult>(done => { resolve = done; })),
    stop: vi.fn(async () => {}), cancel: vi.fn(async () => {}),
  } as unknown as NativeSpeechPlugin;
  const callbacks = { onState: vi.fn(), onText: vi.fn(), onPartial: vi.fn(), onError: vi.fn() };
  const session = new BailianVoiceSession(bridge, callbacks);
  return { session, bridge, callbacks, remove,
    event: (state: NativeSpeechStateEvent['state'], id?: string) => event({ sessionId: id ?? vi.mocked(bridge.start).mock.calls.at(-1)![0].sessionId, state }),
    resolve: (text: string, id?: string) => resolve({ text, sessionId: id ?? vi.mocked(bridge.start).mock.calls.at(-1)![0].sessionId }),
    partial: (text: string, id?: string) => event({ sessionId: id ?? vi.mocked(bridge.start).mock.calls.at(-1)![0].sessionId, state: 'listening', text }),
  };
}
afterEach(() => vi.useRealTimers());

it('中间转写仅预览，隔离旧会话、超长文字及取消后的事件，最终结果仍独立核验', async () => {
  const s = setup(); const pending = s.session.start(config, readiness);
  await vi.waitFor(() => expect(s.bridge.start).toHaveBeenCalledOnce());
  s.partial('旧文字', 'stale'); s.partial('x'.repeat(501));
  expect(s.callbacks.onPartial).not.toHaveBeenCalled();
  s.partial('午餐二十'); s.partial('午餐28元');
  expect(s.callbacks.onPartial).toHaveBeenLastCalledWith('午餐28元');
  expect(s.callbacks.onText).not.toHaveBeenCalled();
  s.session.cancel(); s.partial('取消后文字'); s.resolve('迟到最终文字'); await pending;
  expect(s.callbacks.onPartial).toHaveBeenCalledTimes(2);
  expect(s.callbacks.onText).not.toHaveBeenCalled();
});

it('只在明确开始时创建一次会话，重复点击与旧事件不进入第二次采集', async () => {
  const s = setup(); expect(s.bridge.start).not.toHaveBeenCalled();
  const first = s.session.start(config, readiness);
  await vi.waitFor(() => expect(s.bridge.start).toHaveBeenCalledOnce());
  await s.session.start(config, readiness);
  const options = vi.mocked(s.bridge.start).mock.calls[0][0];
  expect(options).toMatchObject({ ...config, expectedCredentialRevision: readiness.credentialRevision, consent: true, userInitiated: true });
  s.event('listening', 'stale'); expect(s.callbacks.onState).not.toHaveBeenCalledWith('listening');
  s.event('listening'); await s.session.stop(); await s.session.stop();
  expect(s.bridge.stop).toHaveBeenCalledOnce();
  s.resolve('午餐28元'); await first;
  expect(s.callbacks.onText).toHaveBeenCalledExactlyOnceWith('午餐28元');
  expect(s.remove).toHaveBeenCalledOnce(); expect(s.session.busy).toBe(false);
});

it('录音尚未开始时停止等同取消，迟到文本无法覆盖新会话', async () => {
  const s = setup(); const old = s.session.start(config, readiness);
  await vi.waitFor(() => expect(s.bridge.start).toHaveBeenCalledOnce());
  await s.session.stop(); expect(s.bridge.cancel).toHaveBeenCalledOnce(); expect(s.bridge.stop).not.toHaveBeenCalled();
  s.resolve('迟到'); await old; expect(s.callbacks.onText).not.toHaveBeenCalled();
  const next = s.session.start(config, readiness);
  await vi.waitFor(() => expect(s.bridge.start).toHaveBeenCalledTimes(2));
  s.resolve('新短句'); await next;
  expect(s.callbacks.onText).toHaveBeenCalledExactlyOnceWith('新短句');
});

it('关闭发生在监听器尚未注册时，不能继续开始或回写', async () => {
  const s = setup(); let register!: (value: { remove(): Promise<void> }) => void;
  vi.mocked(s.bridge.addListener).mockImplementation(() => new Promise(done => { register = done; }));
  const pending = s.session.start(config, readiness); s.session.dispose();
  register({ remove: s.remove }); await pending;
  expect(s.bridge.start).not.toHaveBeenCalled(); expect(s.remove).toHaveBeenCalledOnce();
  expect(s.callbacks.onText).not.toHaveBeenCalled();
});

it('总等待超时取消，后台/关闭后结果不采用；错误不回显任何上游正文', async () => {
  vi.useFakeTimers(); const s = setup(); const pending = s.session.start(config, readiness);
  await Promise.resolve(); await Promise.resolve();
  await vi.advanceTimersByTimeAsync(95_000);
  expect(s.bridge.cancel).toHaveBeenCalledOnce(); s.resolve('超时后文本'); await pending;
  expect(s.callbacks.onText).not.toHaveBeenCalled();
  vi.mocked(s.bridge.start).mockRejectedValue(new Error('SECRET_UPSTREAM_TEXT'));
  await s.session.start(config, readiness);
  expect(JSON.stringify(s.callbacks.onError.mock.calls)).not.toContain('SECRET_UPSTREAM_TEXT');
});

it('权限与建连耗时不挤占30秒录音及独立转写窗口', async () => {
  vi.useFakeTimers(); const s = setup(); const pending = s.session.start(config, readiness);
  await Promise.resolve(); await Promise.resolve();
  await vi.advanceTimersByTimeAsync(40_000); s.event('listening');
  await vi.advanceTimersByTimeAsync(29_000); await s.session.stop();
  await vi.advanceTimersByTimeAsync(14_000);
  expect(s.bridge.cancel).not.toHaveBeenCalled();
  s.resolve('较晚但仍有效的短句'); await pending;
  expect(s.callbacks.onText).toHaveBeenCalledExactlyOnceWith('较晚但仍有效的短句');
});

it.each(['', 'x'.repeat(501)])('空/超长转录不截断成账单草稿', async text => {
  const s = setup(); const pending = s.session.start(config, readiness);
  await vi.waitFor(() => expect(s.bridge.start).toHaveBeenCalledOnce());
  s.resolve(text); await pending; expect(s.callbacks.onText).not.toHaveBeenCalled();
  expect(s.callbacks.onError).toHaveBeenCalledOnce();
});

it('缺Key或Web环境不发起原生请求', async () => {
  const s = setup();
  await s.session.start(config, { ...readiness, hasKey: false });
  await s.session.start(config, { ...readiness, supported: false });
  expect(s.bridge.start).not.toHaveBeenCalled();
});

it('安全错误按固定代码区分，不能回显远端消息或凭据', () => {
  expect(shortVoiceError({ code: 'SPEECH_PERMISSION_DENIED', message: 'PRIVATE' })).toContain('麦克风未获授权');
  expect(shortVoiceError({ code: 'SPEECH_KEY_CHANGED', message: 'PRIVATE' })).toContain('Key 已变化');
  expect(shortVoiceError({ code: 'constructor', message: 'PRIVATE' })).not.toContain('PRIVATE');
  expect(shortVoiceError({ code: 'UNKNOWN', message: 'PRIVATE' })).toContain('语音未完成');
});

it('百炼地址严格由地域、workspace及固定模型推导，拒绝注入与任意第三方地址', () => {
  expect(bailianVoiceDestination(config)).toBe('synthetic-workspace.cn-beijing.maas.aliyuncs.com');
  expect(bailianVoiceDestination({ ...config, region: 'singapore' })).toBe('synthetic-workspace.ap-southeast-1.maas.aliyuncs.com');
  for (const workspace of ['-space', 'space-', 'evil.example/path', 'space?x=1', 'x'.repeat(64), '空格']) {
    expect(() => validateBailianVoiceConfig({ ...config, workspace })).toThrow();
  }
  expect(() => validateBailianVoiceConfig({ ...config, region: 'evil' as never })).toThrow();
  expect(() => validateBailianVoiceConfig({ ...config, model: 'other' as never })).toThrow();
});
