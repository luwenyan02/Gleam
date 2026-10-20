import { afterEach, expect, it, vi } from 'vitest';
import { RealtimeVoice } from '../src/core/realtimeVoice';

afterEach(() => vi.unstubAllGlobals());

function setup() {
  vi.stubGlobal('Audio', class { autoplay = false; srcObject = null; pause() {} });
  const onTranscript = vi.fn(), onEnd = vi.fn(), onStatus = vi.fn();
  const voice = new RealtimeVoice({ model: 'qwen3.8-omni-flash-realtime', region: 'beijing', workspace: '', onTranscript, onEnd, onStatus });
  const channel = { readyState: 'open', send: vi.fn() } as unknown as RTCDataChannel;
  const event = (data: unknown) => voice['receive'](JSON.stringify(data), channel);
  return { voice, event, onTranscript, onEnd, channel };
}
it('先按事件顺序定位，转录异步到达也不会把用户与 AI 颠倒；去重重复事件', () => {
  const { event, onTranscript } = setup();
  event({ type: 'input_audio_buffer.speech_started', item_id: 'user' });
  event({ type: 'response.output_item.added', item: { id: 'bot' } });
  event({ type: 'response.audio_transcript.done', event_id: 'b1', item_id: 'bot', transcript: '你好' });
  event({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'user', transcript: '测试' });
  event({ type: 'response.audio_transcript.done', event_id: 'b1', item_id: 'bot', transcript: '重复' });
  expect(onTranscript).toHaveBeenCalledTimes(2);
  expect(onTranscript.mock.calls.at(-1)?.[0]).toEqual([{ role: 'user', content: '测试', id: 'user' }, { role: 'assistant', content: '你好', id: 'bot', search: { status: 'enabled', sources: [] } }]);
});
it('关闭后不采用迟到事件；重复关闭只触发一次结束', () => {
  const { voice, event, onTranscript, onEnd } = setup();
  voice.close(); voice.close();
  event({ type: 'response.audio_transcript.done', item_id: 'bot', transcript: '迟到' });
  expect(onTranscript).not.toHaveBeenCalled(); expect(onEnd).toHaveBeenCalledOnce();
});
it('等待麦克风授权时关闭，迟到的媒体流立即停止', async () => {
  const { voice } = setup();
  let resolve!: (value: unknown) => void;
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => new Promise(r => { resolve = r; }) } });
  vi.stubGlobal('RTCPeerConnection', class {});
  const pending = voice.start(); voice.close();
  const stop = vi.fn(); resolve({ getTracks: () => [{ stop }] });
  await pending; expect(stop).toHaveBeenCalledOnce();
});

it('会话确认前不发送声音，静音与结束均停止采集，转录不包含历史记录', async () => {
  const { voice, event, channel } = setup();
  vi.stubGlobal('window', new EventTarget()); vi.stubGlobal('document', new EventTarget());
  const track = { enabled: true, stop: vi.fn() };
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }) } });
  const close = vi.fn();
  const replaceTrack = vi.fn(async () => {});
  vi.stubGlobal('RTCPeerConnection', class extends EventTarget {
    iceGatheringState = 'complete'; localDescription = { sdp: 'v=0\nm=audio' };
    createDataChannel() { return {}; } addTrack() { return { replaceTrack }; } async createOffer() { return this.localDescription; }
    async setLocalDescription() {} async setRemoteDescription() {} close = close;
  });
  const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ sdp: 'v=0' })));
  vi.stubGlobal('fetch', fetchSpy);
  await voice.start();
  expect(track.enabled).toBe(false);
  expect(replaceTrack).toHaveBeenLastCalledWith(null);
  event({ type: 'session.created' });
  const session = JSON.parse(vi.mocked(channel.send).mock.calls[0][0] as string).session;
  expect(session).not.toHaveProperty('messages');
  expect(session.instructions).toContain('先识别当前意图');
  expect(session.instructions).toContain('不必每次以问题结尾');
  expect(session.instructions).toContain('不朗读 Markdown 标记');
  event({ type: 'session.updated' }); expect(track.enabled).toBe(true);
  expect(replaceTrack).toHaveBeenLastCalledWith(track);
  expect(voice.mute()).toBe(true); expect(track.enabled).toBe(false);
  expect(voice.mute()).toBe(false); expect(track.enabled).toBe(true);
  voice.close(); expect(track.stop).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
  expect(JSON.parse(fetchSpy.mock.calls[0][1].body)).not.toHaveProperty('apiKey');
});

it('空闲时打断不发无效取消；回复中只取消一次', () => {
  const { voice, event, channel } = setup();
  voice.interrupt(); expect(channel.send).not.toHaveBeenCalled();
  event({ type: 'session.created' }); vi.mocked(channel.send).mockClear();
  event({ type: 'response.created' }); voice.interrupt(); voice.interrupt();
  expect(channel.send).toHaveBeenCalledOnce();
  expect(channel.send).toHaveBeenCalledWith(JSON.stringify({ type: 'response.cancel' }));
});

it('语音转录随增量更新同一轮气泡，最终修正覆盖临时文字且不接受迟到增量', () => {
  const { event, onTranscript } = setup();
  event({ type: 'input_audio_buffer.speech_started', item_id: 'user' });
  event({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'user', text: '', stash: '周六' });
  expect(onTranscript).toHaveBeenLastCalledWith([{ role: 'user', content: '周六', id: 'user' }]);
  event({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'user', text: '周六', stash: '去散步' });
  event({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'user', transcript: '周六去爬山' });
  event({ type: 'response.created', response: { id: 'reply' } });
  event({ type: 'response.audio_transcript.delta', event_id: 'd1', response_id: 'reply', item_id: 'bot', delta: 'Hello ' });
  event({ type: 'response.audio_transcript.delta', event_id: 'd1', response_id: 'reply', item_id: 'bot', delta: 'Hello ' });
  event({ type: 'response.output_audio_transcript.delta', response_id: 'reply', item_id: 'bot', delta: 'world' });
  expect(onTranscript).toHaveBeenLastCalledWith([{ role: 'user', content: '周六去爬山', id: 'user' }, { role: 'assistant', content: 'Hello world', id: 'bot', search: { status: 'enabled', sources: [] } }]);
  event({ type: 'response.audio_transcript.done', response_id: 'reply', item_id: 'bot', transcript: 'Hello, world!' });
  event({ type: 'response.audio_transcript.delta', response_id: 'reply', item_id: 'bot', delta: '迟到' });
  expect(onTranscript.mock.calls.at(-1)?.[0][1].content).toBe('Hello, world!');
});

it('打断后的旧回复结束事件不会停止新回复的状态与后续打断', () => {
  const { voice, event, channel } = setup();
  event({ type: 'session.created' }); vi.mocked(channel.send).mockClear();
  event({ type: 'response.created', response: { id: 'old' } }); voice.interrupt();
  event({ type: 'response.created', response: { id: 'new' } });
  event({ type: 'response.done', response: { id: 'old', status: 'cancelled' } });
  voice.interrupt();
  expect(channel.send).toHaveBeenCalledTimes(2);
});

it('只有当前成功结束的完整转写可排版，取消与重复完成不产生新轮次', () => {
  const { voice, event, onTranscript } = setup();
  event({ type: 'response.created', response: { id: 'reply-1' } });
  event({ type: 'response.audio_transcript.done', response_id: 'reply-1', item_id: 'bot-1', transcript: '第一轮' });
  expect(onTranscript.mock.calls.at(-1)?.[0][0].complete).not.toBe(true);
  event({ type: 'response.done', response: { id: 'reply-1', status: 'completed' } });
  expect(onTranscript.mock.calls.at(-1)?.[0][0]).toMatchObject({ id: 'bot-1', complete: true });
  event({ type: 'response.created', response: { id: 'reply-2' } });
  event({ type: 'response.audio_transcript.done', response_id: 'reply-2', item_id: 'bot-2', transcript: '被打断' });
  voice.interrupt(); event({ type: 'response.done', response: { id: 'reply-2', status: 'completed' } });
  expect(onTranscript.mock.calls.at(-1)?.[0][1].complete).not.toBe(true);
  voice.close();
});

it('实时会话启用内置搜索与来源，搜索计量按回复隔离并拒绝打断后的迟到结果', () => {
  const { voice, event, channel, onTranscript } = setup();
  event({ type: 'session.created' });
  const session = JSON.parse(vi.mocked(channel.send).mock.calls[0][0] as string).session;
  expect(session.enable_search).toBe(true); expect(session.search_options).toEqual({ enable_source: true });
  expect(session.tools).toBeUndefined();
  expect(session.instructions).not.toContain('当前语音未提供联网搜索工具');
  event({ type: 'response.created', response: { id: 'weather' } });
  event({ type: 'response.audio_transcript.done', response_id: 'weather', item_id: 'a1', transcript: '根据预报，今天有雨。' });
  event({ type: 'response.done', response: { id: 'weather', status: 'completed', usage: { plugins: { search: { count: 1 } } }, search_info: { search_results: [{ title: '天气', url: 'https://weather.invalid/beijing' }] } } });
  expect(onTranscript.mock.calls.at(-1)?.[0][0].search).toEqual({ status: 'searched', sources: [{ title: '天气', url: 'https://weather.invalid/beijing' }] });
  event({ type: 'response.created', response: { id: 'cancelled' } });
  event({ type: 'response.audio_transcript.delta', response_id: 'cancelled', item_id: 'a2', delta: '未完成' });
  voice.interrupt();
  event({ type: 'response.done', response: { id: 'cancelled', status: 'completed', usage: { plugins: { search: { count: 1 } } } } });
  expect(onTranscript.mock.calls.at(-1)?.[0][1].search?.status).not.toBe('searched');
  voice.close();
});

it('服务端明确关闭搜索时结束连接，不把未启用冒充可联网', () => {
  const { event, onEnd } = setup();
  event({ type: 'session.updated', session: { enable_search: false } });
  expect(onEnd).toHaveBeenCalledOnce();
});
