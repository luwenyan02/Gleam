import { validateBailianVoiceConfig, type BailianVoiceConfig } from './bailianVoiceConfig';
import { shortVoiceError } from './bailianVoiceErrors';
import { claimVoiceOperation, releaseVoiceOperation } from './bailianVoiceOperation';
import type { NativeSpeechConfiguration, NativeSpeechPlugin } from './nativeSpeech';

type ActiveTest = { id: string; timer?: ReturnType<typeof setTimeout> };
export type VoiceConnectionTestState = 'idle' | 'testing' | 'success' | 'error';
const UNTESTED = '尚未测试连接；保存 Key 不会调用服务';
/** Explicitly consented configuration probe. It never calls start, stop, or microphone APIs. */
export class BailianVoiceConnectionTest {
  private active?: ActiveTest;
  private disposed = false;
  state: VoiceConnectionTestState = 'idle';
  message = UNTESTED;
  constructor(private bridge: NativeSpeechPlugin, private changed: () => void) {}
  get busy(): boolean { return !!this.active; }
  async start(config: BailianVoiceConfig, readiness: NativeSpeechConfiguration): Promise<void> {
    if (this.disposed || this.active) return;
    if (!readiness.supported) { this.fail('SPEECH_UNSUPPORTED'); return; }
    if (!readiness.hasKey) { this.fail('SPEECH_KEY_REQUIRED'); return; }
    try { validateBailianVoiceConfig(config); } catch { this.fail('SPEECH_CONFIG_INVALID'); return; }
    const run: ActiveTest = { id: crypto.randomUUID() };
    if (!claimVoiceOperation(this.bridge, run)) { this.fail('SPEECH_BUSY'); return; }
    this.active = run;
    this.update('testing', '正在验证连接与会话配置，不使用麦克风…');
    run.timer = setTimeout(() => {
      if (this.active !== run) return;
      this.cancelActive(); this.fail('SPEECH_TIMEOUT', 'connecting');
    }, 35_000);
    try {
      const result = await this.bridge.testConnection({ ...config, sessionId: run.id,
        expectedCredentialRevision: readiness.credentialRevision, consent: true, userInitiated: true });
      if (this.active !== run || this.disposed) return;
      if (result?.sessionId !== run.id) throw { code: 'SPEECH_SESSION_INVALID', data: { phase: 'configuring' } };
      if (result.connected !== true) throw { code: 'SPEECH_PROTOCOL', data: { phase: 'configuring' } };
      this.finish(run);
      this.update('success', '连接与会话配置验证通过；未测试麦克风或转写，也未发送音频');
    } catch (error) {
      if (this.active !== run || this.disposed) return;
      // Cancel is idempotent; also clean up malformed bridge results.
      this.cancelActive(); this.update('error', shortVoiceError(error));
    }
  }
  invalidate(message = UNTESTED): void { this.cancelActive(); if (!this.disposed) this.update('idle', message); }
  dispose(): void { this.disposed = true; this.cancelActive(); }
  private fail(code: string, phase = 'validation'): void { this.update('error', shortVoiceError({ code, data: { phase } })); }
  private update(state: VoiceConnectionTestState, message: string): void {
    if (this.disposed) return;
    this.state = state; this.message = message; this.changed();
  }
  private cancelActive(): void {
    const run = this.active; if (!run) return;
    this.finish(run); void this.bridge.cancel({ sessionId: run.id }).catch(() => {});
  }
  private finish(run: ActiveTest): void {
    if (this.active !== run) return;
    clearTimeout(run.timer); this.active = undefined; releaseVoiceOperation(this.bridge, run);
  }
}
