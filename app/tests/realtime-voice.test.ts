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
  expect(onTranscript.mock.calls.at(-1)?.[0]).toEqual([{ role: 'user', content: '测试' }, { role: 'assistant', content: '你好' }]);
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
