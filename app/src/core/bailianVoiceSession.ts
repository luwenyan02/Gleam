import type { BailianVoiceConfig } from './bailianVoiceConfig';
import type { NativeSpeechPlugin, NativeSpeechConfiguration, NativeSpeechStateEvent } from './nativeSpeech';

export type ShortVoiceState = 'idle' | NativeSpeechStateEvent['state'];
interface SessionCallbacks {
  onState(state: ShortVoiceState): void;
  onText(text: string): void;
  onError(message: string): void;
}
type ActiveSession = { id: string; listener?: { remove(): Promise<void> }; timer?: ReturnType<typeof setTimeout> };
const SAFE_ERRORS: Record<string, string> = {
  SPEECH_PERMISSION_DENIED: '麦克风未获授权，可在手机系统设置中允许后重试，或手动输入',
  SPEECH_PERMISSION_CANCELLED: '麦克风授权已取消，可重新开始或手动输入',
  SPEECH_KEY_CHANGED: '语音 Key 已变化或清除，请重新核对设置后开始',
  SPEECH_KEY_REQUIRED: '请先在设置中保存独立百炼语音 Key',
  SPEECH_AUTH: '百炼语音鉴权失败，请核对独立 Key、地域与业务空间',
  SPEECH_RATE_LIMIT: '百炼语音请求受限，请稍后重试',
  SPEECH_TIMEOUT: '语音等待超时，请重新开始或手动输入',
  SPEECH_LIMIT: '本次录音已达30秒上限，已取消，请录更短的一句',
  SPEECH_INTERRUPTED: '语音已被后台或来电中断，请重新开始',
  SPEECH_CANCELLED: '语音已取消，文字未发送给记账 AI',
  SPEECH_TRANSCRIPT_LIMIT: '转录超过500字，未截断或入账，请录更短的一句',
};

export function shortVoiceError(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? (error as { code: unknown }).code : undefined;
  return typeof code === 'string' && Object.hasOwn(SAFE_ERRORS, code) ? SAFE_ERRORS[code]
    : '语音未完成，请检查权限、网络、Key 与业务空间，或改用手动输入';
}

/** 隔离每一次用户同意的短句；不保存或处理音频，不自动发送转写文字。 */
export class BailianVoiceSession {
  private active?: ActiveSession;
  private disposed = false;
  private state: ShortVoiceState = 'idle';
  constructor(private bridge: NativeSpeechPlugin, private callbacks: SessionCallbacks) {}

  get busy(): boolean { return !!this.active; }

  async start(config: BailianVoiceConfig, readiness: NativeSpeechConfiguration): Promise<void> {
    if (this.disposed || this.active) return;
    if (!readiness.supported || !readiness.hasKey) { this.callbacks.onError('请先在 Android 设置中保存独立的百炼语音 Key'); return; }
    const session: ActiveSession = { id: crypto.randomUUID() };
    this.active = session;
    this.update('connecting');
    // 原生各阶段上限：权限30s + 建连15s + 录音30s + 转写15s；桥回调再留5s。
    session.timer = setTimeout(() => this.cancel('语音等待超时，请重新开始'), 95_000);
    try {
      const listener = await this.bridge.addListener('state', event => {
        if (this.active !== session || this.disposed || event.sessionId !== session.id) return;
        this.update(event.state);
      });
      if (this.active !== session || this.disposed) { await listener.remove(); return; }
      session.listener = listener;
      const result = await this.bridge.start({ ...config, sessionId: session.id,
        expectedCredentialRevision: readiness.credentialRevision, consent: true, userInitiated: true });
      if (this.active !== session || this.disposed || result.sessionId !== session.id) return;
      const text = result.text.trim();
      if (!text || text.length > 500) throw new Error('未得到可核对的短句，请重试或手动输入');
      this.finish(session);
      this.callbacks.onText(text);
    } catch (error) {
      if (this.active !== session || this.disposed) return;
      this.finish(session);
      // 原生错误可能包含外部文本；UI 不读取、记录或回显原始 error。
      this.callbacks.onError(shortVoiceError(error));
    }
  }

  async stop(): Promise<void> {
    const session = this.active;
    if (!session || this.disposed || this.state === 'transcribing') return;
    if (this.state !== 'listening') { this.cancel('语音已取消'); return; }
    this.update('transcribing');
    try { await this.bridge.stop({ sessionId: session.id }); }
    catch { if (this.active === session) this.cancel('语音未完成，请重试或手动输入'); }
  }

  cancel(message?: string): void {
    const session = this.active;
    if (!session) return;
    this.finish(session);
    void this.bridge.cancel({ sessionId: session.id }).catch(() => {});
    if (!this.disposed && message) this.callbacks.onError(message);
  }

  dispose(): void { this.disposed = true; this.cancel(); }

  private update(state: ShortVoiceState): void { this.state = state; if (!this.disposed) this.callbacks.onState(state); }
  private finish(session: ActiveSession): void {
    if (this.active !== session) return;
    this.active = undefined;
    clearTimeout(session.timer);
    void session.listener?.remove().catch(() => {});
    this.update('idle');
  }
}
