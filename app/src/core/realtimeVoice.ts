import type { LifeChatMessage } from './types';
import { LIFE_CHAT_PROMPT } from './lifeChatPrompt';

export interface VoiceOptions {
  model: string; region: string; workspace: string;
  onStatus: (text: string) => void;
  onTranscript: (messages: LifeChatMessage[]) => void;
  onEnd: () => void;
}

/** 语音不读取账本、照片或聊天历史；只保存本次返回的转录，不录制音频文件。 */
export class RealtimeVoice {
  private pc?: RTCPeerConnection;
  private stream?: MediaStream;
  private audio = new Audio();
  private controller = new AbortController();
  private closed = false;
  private muted = false;
  private configured = false;
  private deadline?: ReturnType<typeof setTimeout>;
  private duration?: ReturnType<typeof setTimeout>;
  private channel?: RTCDataChannel;
  private senders: Array<{ sender: RTCRtpSender; track: MediaStreamTrack }> = [];
  private responding = false;
  private seen = new Set<string>();
  private transcript = new Map<string, LifeChatMessage>();
  private order: string[] = [];
  private leave = () => { this.options.onStatus('页面已离开，麦克风已关闭'); this.close(); };
  private visibility = () => { if (document.hidden) this.leave(); };

  constructor(private options: VoiceOptions) { this.audio.autoplay = true; }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.controller.abort();
    if (typeof window !== 'undefined') { window.removeEventListener('pagehide', this.leave); document.removeEventListener('visibilitychange', this.visibility); }
    clearTimeout(this.deadline); clearTimeout(this.duration);
    this.stream?.getTracks().forEach(track => track.stop());
    this.pc?.close(); this.audio.pause(); this.audio.srcObject = null;
    this.options.onEnd();
  }

  mute(): boolean {
    this.muted = !this.muted;
    this.stream?.getAudioTracks().forEach(track => { track.enabled = !this.muted && this.configured; });
    return this.muted;
  }

  interrupt(): void {
    if (this.responding && this.channel?.readyState === 'open') {
      this.audio.muted = true;
      this.channel.send(JSON.stringify({ type: 'response.cancel' }));
      this.responding = false;
    }
  }

  async resumeAudio(): Promise<void> { await this.audio.play(); }

  private receive(raw: string, channel: RTCDataChannel): void {
    if (this.closed) return;
    let event: { type: string; event_id?: string; item_id?: string; transcript?: string; item?: { id?: string }; response?: { status?: string } };
    try { event = JSON.parse(raw); } catch { return; }
    if (event.event_id) { if (this.seen.has(event.event_id)) return; this.seen.add(event.event_id); }
    if (event.type === 'session.created') {
      this.channel = channel;
      channel.send(JSON.stringify({ type: 'session.update', session: {
        modalities: ['text', 'audio'], voice: this.options.model.startsWith('qwen-audio') ? 'longanqian_v3.1' : 'Tina',
        instructions: `${LIFE_CHAT_PROMPT}\n使用自然中文口语，先讲最有用的内容，适合语音听取，不朗读 Markdown 标记。`,
        ...(this.options.model.startsWith('qwen-audio') ? {} : { input_audio_transcription: { model: 'qwen3-asr-flash-realtime' } }),
        turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 700 },
      } }));
    }
    if (event.type === 'session.updated') {
      this.configured = true; clearTimeout(this.deadline);
      this.stream?.getAudioTracks().forEach(track => { track.enabled = !this.muted; });
      void Promise.all(this.senders.map(({ sender, track }) => sender.replaceTrack(track))).then(() => {
        if (!this.closed) this.options.onStatus(this.muted ? '麦克风已静音' : '已连接，随时开口');
      }).catch(() => { if (!this.closed) { this.options.onStatus('麦克风音轨无法启动，请重试'); this.close(); } });
    }
    const id = event.item_id ?? event.item?.id;
    if (id && !this.order.includes(id)) this.order.push(id);
    if (event.type === 'input_audio_buffer.speech_started') { this.interrupt(); this.options.onStatus('正在听你说…'); }
    if (event.type === 'response.created') { this.responding = true; this.audio.muted = false; this.options.onStatus('拾光正在回应…'); }
    if (event.type === 'response.done') { this.responding = false; this.options.onStatus(this.muted ? '麦克风已静音' : '已连接，随时开口'); }
    if (event.type === 'error') { this.options.onStatus('语音服务返回错误，请结束后重试或更换模型'); this.close(); return; }
    if (id && event.transcript?.trim() && ['conversation.item.input_audio_transcription.completed', 'response.audio_transcript.done', 'response.output_audio_transcript.done'].includes(event.type)) {
      this.transcript.set(id, { role: event.type.startsWith('conversation.') ? 'user' : 'assistant', content: event.transcript.slice(0, 12_000) });
      this.options.onTranscript(this.order.flatMap(key => this.transcript.has(key) ? [this.transcript.get(key)!] : []));
    }
  }

  async start(): Promise<void> {
    try {
      if (!navigator.mediaDevices?.getUserMedia || !globalThis.RTCPeerConnection) throw new Error('请使用支持麦克风的本地或 HTTPS 浏览器');
      this.options.onStatus('请允许使用麦克风');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      if (this.closed) { stream.getTracks().forEach(track => track.stop()); return; }
      this.stream = stream;
      window.addEventListener('pagehide', this.leave);
      document.addEventListener('visibilitychange', this.visibility);
      stream.getTracks().forEach(track => { track.enabled = false; });
      this.pc = new RTCPeerConnection({ iceServers: [] });
      const pc = this.pc;
      for (const track of stream.getAudioTracks()) {
        const sender = pc.addTrack(track, stream);
        this.senders.push({ sender, track });
        // enabled=false 仍会发出静音 RTP；Qwen-Audio 要求配置前完全没有音频。
        await sender.replaceTrack(null);
      }
      const bind = (channel: RTCDataChannel) => { channel.onmessage = event => this.receive(String(event.data), channel); };
      bind(pc.createDataChannel('oai-events'));
      pc.ondatachannel = event => bind(event.channel);
      pc.ontrack = event => {
        if (this.closed) return;
        this.audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
        void this.audio.play().catch(() => { if (!this.closed) this.options.onStatus('浏览器暂停了声音，点击「播放声音」继续'); });
      };
      pc.onconnectionstatechange = () => {
        if (!this.closed && ['failed', 'disconnected'].includes(pc.connectionState)) { this.options.onStatus('连接已断开，麦克风已关闭'); this.close(); }
      };
      this.deadline = setTimeout(() => { this.options.onStatus('连接超时，麦克风已关闭，请重试'); this.close(); }, 30_000);
      this.duration = setTimeout(() => { this.options.onStatus('本次通话已达 5 分钟，可重新开始'); this.close(); }, 300_000);
      this.options.onStatus('正在连接阿里云百炼…');
      await pc.setLocalDescription(await pc.createOffer());
      await new Promise<void>((resolve, reject) => {
        const signal = this.controller.signal;
        const done = () => { pc.removeEventListener('icegatheringstatechange', check); signal.removeEventListener('abort', abort); };
        const check = () => { if (pc.iceGatheringState === 'complete') { done(); resolve(); } };
        const abort = () => { done(); reject(new Error('连接已取消')); };
        if (signal.aborted) return abort();
        pc.addEventListener('icegatheringstatechange', check); signal.addEventListener('abort', abort, { once: true }); check();
      });
      const response = await fetch('/__gleam/voice/session', { method: 'POST', signal: this.controller.signal,
        headers: { 'Content-Type': 'application/json', 'X-Gleam-Voice': '1' },
        body: JSON.stringify({ model: this.options.model, region: this.options.region, workspace: this.options.workspace, sdp: pc.localDescription!.sdp }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : '语音连接失败');
      if (!this.closed) await pc.setRemoteDescription({ type: 'answer', sdp: result.sdp });
    } catch (error) {
      if (!this.closed) { this.options.onStatus(error instanceof DOMException && error.name === 'NotAllowedError' ? '麦克风未获授权，可在浏览器设置中允许后重试' : error instanceof Error ? error.message : '语音连接失败'); this.close(); }
    }
  }
}
