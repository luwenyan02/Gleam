import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { LIFE_CHAT_PROMPT } from './lifeChatPrompt';
import type { VoiceTranscriptMessage } from './voiceTranscript';
import type { VoiceState } from './realtimeVoice';

export interface LiveVoiceReadiness { ready: boolean; credentialRevision: string; }
interface LiveState {
  sessionId: string;
  state: 'connecting' | 'listening' | 'speaking' | 'muted' | 'ended';
  reason?: string;
  message?: string;
  messages?: VoiceTranscriptMessage[];
}
interface LivePlugin {
  configuration(): Promise<LiveVoiceReadiness>;
  start(options: { sessionId: string; expectedCredentialRevision: string; consent: true; userInitiated: true; instructions: string }): Promise<{ sessionId: string }>;
  mute(options: { sessionId: string; muted: boolean }): Promise<void>;
  interrupt(options: { sessionId: string }): Promise<void>;
  end(options: { sessionId: string }): Promise<void>;
  addListener(name: 'state', listener: (event: LiveState) => void): Promise<PluginListenerHandle>;
}
export const liveVoicePlugin = registerPlugin<LivePlugin>('GleamLiveVoice');
export const nativeLiveVoiceSupported = () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
interface Options {
  onStatus: (text: string) => void;
  onTranscript: (messages: VoiceTranscriptMessage[]) => void;
  onEnd: () => void;
  onState?: (state: VoiceState) => void;
}

/** JS sees only readiness, an isolation revision and returned text. Audio and keys remain native. */
export class NativeLiveVoice {
  private readonly id = crypto.randomUUID();
  private closed = false;
  private begun = false;
  private muted = false;
  private connected = false;
  private listener?: PluginListenerHandle;
  private visibility = () => { if (document.hidden && this.connected) { this.options.onStatus('语音已结束'); this.close(); } };
  private leave = () => this.close();
  constructor(private options: Options) {}
  async start(): Promise<void> {
    if (this.begun || this.closed) return;
    this.begun = true;
    this.options.onState?.('connecting');
    try {
      const listener = await liveVoicePlugin.addListener('state', event => {
        if (this.closed || event.sessionId !== this.id) return;
        if (event.messages) {
          if (!Array.isArray(event.messages) || event.messages.length > 120
            || event.messages.some(m => !m || !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string' || m.content.length > 12_000)) return;
          this.options.onTranscript(event.messages.map(({ role, content, id, complete }) => ({ role, content,
            ...(typeof id === 'string' && id.length > 0 && id.length <= 160 ? { id, ...(typeof complete === 'boolean' ? { complete } : {}) } : {}),
          })));
        }
        if (event.state === 'ended') {
          this.options.onStatus(event.message || '语音已结束'); this.close(); return;
        }
        this.options.onState?.(event.state);
        this.options.onStatus(event.state === 'muted' ? '麦克风已静音' : event.state === 'speaking' ? '拾光在说话…' : event.state === 'connecting' ? '正在连接…' : '正在听，直接说话就好');
      });
      if (this.closed) { await listener.remove(); return; }
      this.listener = listener;
      window.addEventListener('pagehide', this.leave); document.addEventListener('visibilitychange', this.visibility);
      const readiness = await liveVoicePlugin.configuration();
      if (this.closed) return;
      if (!readiness.ready) throw new Error('请先在 AI 设置中完成语音配置');
      await liveVoicePlugin.start({ sessionId: this.id, expectedCredentialRevision: readiness.credentialRevision,
        consent: true, userInitiated: true,
        instructions: `${LIFE_CHAT_PROMPT}\n使用简短自然的中文口语，不朗读 Markdown。当前语音未提供联网搜索工具，实时信息未核实，不沿用其他文字对话的工具能力。`,
      });
      if (this.closed) return;
      if (document.hidden) { this.options.onStatus('语音已结束'); this.close(); return; }
      this.connected = true; this.options.onState?.('listening'); this.options.onStatus('正在听，直接说话就好');
    } catch (error) {
      if (!this.closed) { this.options.onStatus(error instanceof Error ? error.message : '语音未连接，请重试'); this.close(); }
    }
  }
  async mute(): Promise<boolean> {
    if (this.closed) return false;
    const next = !this.muted;
    await liveVoicePlugin.mute({ sessionId: this.id, muted: next });
    if (!this.closed) this.muted = next;
    return this.muted;
  }
  interrupt(): void { if (!this.closed) void liveVoicePlugin.interrupt({ sessionId: this.id }).catch(() => {}); }
  close(): void {
    if (this.closed) return; this.closed = true;
    window.removeEventListener('pagehide', this.leave); document.removeEventListener('visibilitychange', this.visibility);
    void liveVoicePlugin.end({ sessionId: this.id }).catch(() => {});
    void this.listener?.remove().catch(() => {}); this.listener = undefined;
    this.options.onState?.('ended');
    this.options.onEnd();
  }
}
