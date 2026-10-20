import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NativeLiveVoice } from '../src/core/nativeLiveVoice';

const bridge = vi.hoisted(() => ({ configuration: vi.fn(), addListener: vi.fn(), start: vi.fn(), mute: vi.fn(), interrupt: vi.fn(), end: vi.fn() }));
vi.mock('@capacitor/core', () => ({ registerPlugin: () => bridge, Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' } }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function setup() {
  let event!: (value: unknown) => void;
  const remove = vi.fn(async () => {}), callbacks = { onStatus: vi.fn(), onTranscript: vi.fn(), onState: vi.fn(), onEnd: vi.fn() };
  bridge.addListener.mockImplementation(async (_name, listener) => { event = listener; return { remove }; });
  const voice = new NativeLiveVoice(callbacks);
  return { voice, callbacks, remove, event: (data: object) => event({ sessionId: bridge.start.mock.calls[0]?.[0].sessionId, ...data }) };
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('document', Object.assign(new EventTarget(), { hidden: false }));
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(() => { throw new Error('browser microphone forbidden'); }) } });
  bridge.configuration.mockResolvedValue({ ready: true, credentialRevision: 'verified-revision' });
  bridge.start.mockImplementation(async options => ({ sessionId: options.sessionId }));
  for (const method of [bridge.end, bridge.mute, bridge.interrupt]) method.mockResolvedValue({});
});
afterEach(() => vi.unstubAllGlobals());

it('用实际会话状态驱动动画，旧会话和结束后的状态不回写', async () => {
  const s = setup(); await s.voice.start();
  expect(s.callbacks.onState).toHaveBeenCalledWith('connecting');
  expect(s.callbacks.onState).toHaveBeenLastCalledWith('listening');
  s.event({ sessionId: 'old', state: 'speaking' });
  expect(s.callbacks.onState).toHaveBeenLastCalledWith('listening');
  s.event({ state: 'speaking' }); expect(s.callbacks.onState).toHaveBeenLastCalledWith('speaking');
  s.event({ state: 'muted' }); expect(s.callbacks.onState).toHaveBeenLastCalledWith('muted');
  s.voice.close(); s.event({ state: 'speaking' });
  expect(s.callbacks.onState).toHaveBeenLastCalledWith('ended');
});

it('只按一次主动开始，使用原生已验证版本，不传 Key、地址或已有聊天，也不启用浏览器麦克风', async () => {
  const s = setup(); expect(bridge.start).not.toHaveBeenCalled();
  await Promise.all([s.voice.start(), s.voice.start()]);
  expect(bridge.start).toHaveBeenCalledOnce();
  expect(bridge.start.mock.calls[0][0]).toEqual({ sessionId: expect.any(String), expectedCredentialRevision: 'verified-revision', consent: true, userInitiated: true, instructions: expect.any(String) });
  expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  s.voice.close();
});

it('等待监听器或配置时退出，不启动原生采集，迟到监听器会被移除', async () => {
  const s = setup(), registration = deferred<{ remove(): Promise<void> }>();
  bridge.addListener.mockReturnValue(registration.promise);
  const pending = s.voice.start(); s.voice.close(); registration.resolve({ remove: s.remove }); await pending;
  expect(bridge.start).not.toHaveBeenCalled(); expect(s.remove).toHaveBeenCalledOnce();
  const next = setup(), config = deferred<{ ready: boolean; credentialRevision: string }>();
  bridge.configuration.mockReturnValue(config.promise);
  const waiting = next.voice.start(); await vi.waitFor(() => expect(bridge.configuration).toHaveBeenCalledOnce());
  next.voice.close(); config.resolve({ ready: true, credentialRevision: 'late' }); await waiting;
  expect(bridge.start).not.toHaveBeenCalled(); expect(next.callbacks.onEnd).toHaveBeenCalledOnce();
});

it('只接受本会话的合法文字和状态，结束后隔离迟到结果且只释放一次', async () => {
  const s = setup(); await s.voice.start();
  s.event({ sessionId: 'old', state: 'speaking', messages: [{ role: 'assistant', content: '旧结果' }] });
  s.event({ state: 'speaking', messages: [null] });
  s.event({ state: 'speaking', messages: [{ role: 'tool', content: '工具结果' }] });
  expect(s.callbacks.onTranscript).not.toHaveBeenCalled();
  s.event({ state: 'speaking', messages: [{ role: 'user', content: '你好' }, { role: 'assistant', content: '你好呀', id: 'discard-extra' }] });
  expect(s.callbacks.onTranscript).toHaveBeenCalledExactlyOnceWith([{ role: 'user', content: '你好' }, { role: 'assistant', content: '你好呀' }]);
  expect(s.callbacks.onStatus).toHaveBeenLastCalledWith('拾光在说话…');
  s.event({ state: 'ended', reason: 'background' }); s.voice.close();
  s.event({ state: 'speaking', messages: [{ role: 'assistant', content: '迟到' }] });
  expect(s.callbacks.onTranscript).toHaveBeenCalledOnce(); expect(bridge.end).toHaveBeenCalledOnce();
  expect(s.remove).toHaveBeenCalledOnce(); expect(s.callbacks.onEnd).toHaveBeenCalledOnce();
});

it('麦克风授权等待不会被短暂失焦取消；真正进入后台后停止且不自动恢复', async () => {
  const s = setup(), start = deferred<{ sessionId: string }>(); bridge.start.mockReturnValue(start.promise);
  const pending = s.voice.start(); await vi.waitFor(() => expect(bridge.start).toHaveBeenCalledOnce());
  Object.assign(document, { hidden: true }); document.dispatchEvent(new Event('visibilitychange'));
  expect(bridge.end).not.toHaveBeenCalled();
  Object.assign(document, { hidden: false }); start.resolve({ sessionId: bridge.start.mock.calls[0][0].sessionId }); await pending;
  Object.assign(document, { hidden: true }); document.dispatchEvent(new Event('visibilitychange'));
  expect(bridge.end).toHaveBeenCalledOnce();
  Object.assign(document, { hidden: false }); document.dispatchEvent(new Event('visibilitychange'));
  expect(bridge.start).toHaveBeenCalledOnce(); expect(s.callbacks.onEnd).toHaveBeenCalledOnce();
});

it('连接迟到完成时若已关闭或仍在后台，立即结束而不恢复听音状态', async () => {
  for (const close of [false, true]) {
    const s = setup(), start = deferred<{ sessionId: string }>(); bridge.start.mockReturnValue(start.promise);
    const previous = bridge.start.mock.calls.length, pending = s.voice.start();
    await vi.waitFor(() => expect(bridge.start.mock.calls.length).toBe(previous + 1));
    if (close) s.voice.close(); else Object.assign(document, { hidden: true });
    start.resolve({ sessionId: bridge.start.mock.calls.at(-1)![0].sessionId }); await pending;
    expect(s.callbacks.onEnd).toHaveBeenCalledOnce();
    expect(s.callbacks.onStatus).not.toHaveBeenCalledWith('正在听，直接说话就好');
  }
});

it('静音成功才改变按钮状态，失败可重试；结束后不能再控制原生音频', async () => {
  const s = setup(); await s.voice.start(); bridge.mute.mockRejectedValueOnce(new Error('声音不可用'));
  await expect(s.voice.mute()).rejects.toThrow();
  expect(await s.voice.mute()).toBe(true); expect(bridge.mute.mock.calls.at(-1)![0].muted).toBe(true);
  expect(await s.voice.mute()).toBe(false);
  s.voice.interrupt(); expect(bridge.interrupt).toHaveBeenCalledOnce(); s.voice.close();
  s.voice.interrupt(); await s.voice.mute(); expect(bridge.interrupt).toHaveBeenCalledOnce(); expect(bridge.mute).toHaveBeenCalledTimes(3);
});

it('未验证配置或权限拒绝时结束会话并给出可恢复反馈', async () => {
  const s = setup(); bridge.configuration.mockResolvedValueOnce({ ready: false, credentialRevision: 'unverified' });
  await s.voice.start(); expect(bridge.start).not.toHaveBeenCalled(); expect(s.callbacks.onStatus).toHaveBeenLastCalledWith('请先在 AI 设置中完成语音配置');
  const next = setup(); bridge.start.mockRejectedValueOnce(new Error('请允许使用麦克风后重试'));
  await next.voice.start(); expect(next.callbacks.onStatus).toHaveBeenLastCalledWith('请允许使用麦克风后重试'); expect(next.callbacks.onEnd).toHaveBeenCalledOnce();
});
