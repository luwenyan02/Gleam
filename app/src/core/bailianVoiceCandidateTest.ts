import { validateBailianVoiceConfig, type BailianVoiceConfig } from './bailianVoiceConfig';
import { shortVoiceError } from './bailianVoiceErrors';
import { claimVoiceOperation, releaseVoiceOperation } from './bailianVoiceOperation';
import type { NativeSpeechConfiguration, NativeSpeechPlugin } from './nativeSpeech';

export interface BailianVoiceKeyCandidate {
  keySource: 'separate' | 'shared';
  value?: string;
  configurationId: string;
}
export type VoiceCandidateTestState = 'idle' | 'testing' | 'success' | 'error';
type ActiveTest = {
  id: string;
  configurationId: string;
  keySource: BailianVoiceKeyCandidate['keySource'];
  credentialRevision: string;
  mainCredentialRevision: string;
  hasMainKey: boolean;
  config: BailianVoiceConfig;
  finished: Promise<void>;
  settle: () => void;
  timer?: ReturnType<typeof setTimeout>;
};
const UNTESTED = '未测试';
function opaque(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
function masked(value: unknown): value is string {
  // Match only the native display mask: never accept a purported mask that is a full key.
  if (typeof value !== 'string' || value.length > 26) return false;
  if (value === '••••••') return true;
  const points = Array.from(value);
  return points.length === 16 && points.slice(5, 11).join('') === '••••••'
    && !/[\s•\p{Cc}\p{Cf}]/u.test([...points.slice(0, 5), ...points.slice(11)].join(''));
}
function failure(code: string, reason?: string): never {
  throw { code, data: { phase: 'configuring', ...(reason ? { reason } : {}) } };
}
function fields(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) failure('SPEECH_PROTOCOL', 'BRIDGE_RESULT_TYPE');
  return value as Record<string, unknown>;
}
function owns(value: Record<string, unknown>, names: string[]): boolean {
  return names.every(name => Object.hasOwn(value, name));
}

/** A no-audio, two-phase test. Native code alone authorizes and atomically persists the tested key. */
export class BailianVoiceCandidateTest {
  private active?: ActiveTest;
  private disposed = false;
  state: VoiceCandidateTestState = 'idle';
  message = UNTESTED;
  constructor(
    private bridge: NativeSpeechPlugin,
    private changed: () => void,
    private committed?: (configuration: NativeSpeechConfiguration) => void,
  ) {}
  get busy(): boolean { return !!this.active; }

  // Deliberately not async: the caller's raw candidate is not captured by the pending transaction.
  start(config: BailianVoiceConfig, readiness: NativeSpeechConfiguration, candidate: BailianVoiceKeyCandidate): Promise<void> {
    if (this.disposed || this.active) return Promise.resolve();
    if (readiness.supported !== true) return this.fail('SPEECH_UNSUPPORTED');
    let checked: BailianVoiceConfig;
    try {
      if (typeof config.workspace !== 'string') return this.fail('SPEECH_CONFIG_INVALID');
      checked = validateBailianVoiceConfig({ region: config.region, workspace: config.workspace, model: config.model });
    } catch { return this.fail('SPEECH_CONFIG_INVALID'); }
    if (!opaque(candidate.configurationId) || !['separate', 'shared'].includes(candidate.keySource)
      || (candidate.value !== undefined && typeof candidate.value !== 'string')) return this.fail('SPEECH_CONFIG_INVALID');
    if (candidate.value?.includes('••••••')) return this.fail('SPEECH_KEY_REQUIRED');
    if (!opaque(readiness.credentialRevision) || !opaque(readiness.mainCredentialRevision)
      || typeof readiness.hasMainKey !== 'boolean') return this.fail('SPEECH_KEY_CHANGED');
    if (candidate.keySource === 'shared' ? !readiness.hasMainKey
      : !candidate.value?.trim() && !(readiness.hasKey === true && readiness.keySource === 'separate')) {
      return this.fail('SPEECH_KEY_REQUIRED');
    }
    let settle!: () => void;
    const finished = new Promise<void>(resolve => { settle = resolve; });
    const run: ActiveTest = {
      id: crypto.randomUUID(), configurationId: candidate.configurationId, keySource: candidate.keySource,
      credentialRevision: readiness.credentialRevision, mainCredentialRevision: readiness.mainCredentialRevision,
      hasMainKey: readiness.hasMainKey, config: checked, finished, settle,
    };
    if (!claimVoiceOperation(this.bridge, run)) return this.fail('SPEECH_BUSY');
    this.active = run;
    // One deadline covers transport and durable storage; the commit does not reset it.
    run.timer = setTimeout(() => {
      if (!this.current(run)) return;
      this.cancelActive();
      void this.fail('SPEECH_TIMEOUT', 'connecting');
    }, 35_000);
    this.update('testing', '正在测试连接…');
    if (!this.current(run)) return Promise.resolve();
    try {
      const pending = this.bridge.testCandidate({
        ...checked, sessionId: run.id, keySource: run.keySource, configurationId: run.configurationId,
        expectedCredentialRevision: run.credentialRevision, expectedMainCredentialRevision: run.mainCredentialRevision,
        consent: true, userInitiated: true,
        ...(candidate.keySource === 'separate' && candidate.value?.trim() ? { value: candidate.value.trim() } : {}),
      });
      return this.complete(run, pending);
    } catch (error) {
      this.reject(run, error);
      return Promise.resolve();
    }
  }

  invalidate(message = UNTESTED): void {
    this.cancelActive();
    if (!this.disposed) this.update('idle', message);
  }
  dispose(): void { this.disposed = true; this.cancelActive(); }

  private async complete(run: ActiveTest, pending: Promise<unknown>): Promise<void> {
    try {
      const result = await Promise.race([pending, run.finished]);
      if (!this.current(run)) return;
      const value = fields(result);
      if (!Object.hasOwn(value, 'sessionId')) failure('SPEECH_SESSION_INVALID', 'BRIDGE_RESULT_SESSION_ID_MISSING');
      if (typeof value.sessionId !== 'string') failure('SPEECH_SESSION_INVALID', 'BRIDGE_RESULT_SESSION_ID_TYPE');
      if (value.sessionId !== run.id) failure('SPEECH_SESSION_INVALID', 'BRIDGE_RESULT_SESSION_ID_MISMATCH');
      if (!Object.hasOwn(value, 'connected')) failure('SPEECH_PROTOCOL', 'BRIDGE_RESULT_CONNECTED_MISSING');
      if (typeof value.connected !== 'boolean') failure('SPEECH_PROTOCOL', 'BRIDGE_RESULT_CONNECTED_TYPE');
      if (value.connected !== true) failure('SPEECH_PROTOCOL', 'BRIDGE_RESULT_CONNECTED_FALSE');
      if (!Object.hasOwn(value, 'candidateToken') || !opaque(value.candidateToken)) failure('SPEECH_SESSION_INVALID');
      // Recheck before any storage call; cancellation never initiates a late commit.
      if (!this.current(run)) return;
      const commit = this.bridge.commitTestedKey({
        sessionId: run.id, candidateToken: value.candidateToken, configurationId: run.configurationId,
        expectedCredentialRevision: run.credentialRevision, expectedMainCredentialRevision: run.mainCredentialRevision,
      });
      const resultConfiguration: unknown = await Promise.race([commit, run.finished]);
      if (!this.current(run)) return;
      const configuration = this.committedConfiguration(resultConfiguration, run);
      this.committed?.(configuration);
      if (!this.current(run)) return;
      this.finish(run);
      this.update('success', '连接通过 · 录音未测试');
    } catch (error) { this.reject(run, error); }
  }

  private committedConfiguration(result: unknown, run: ActiveTest): NativeSpeechConfiguration {
    const value = fields(result);
    if (!owns(value, ['supported', 'hasKey', 'credentialRevision', 'mainCredentialRevision', 'hasMainKey', 'keySource', 'maskedKey', 'activeConfig'])
      || value.supported !== true || value.hasKey !== true || !masked(value.maskedKey)) failure('SPEECH_KEY_STORAGE');
    if (!opaque(value.credentialRevision) || value.credentialRevision === run.credentialRevision
      || value.mainCredentialRevision !== run.mainCredentialRevision || value.hasMainKey !== run.hasMainKey) failure('SPEECH_KEY_CHANGED');
    if (value.keySource !== run.keySource) failure('SPEECH_CONFIG_INVALID');
    const config = fields(value.activeConfig);
    if (!owns(config, ['region', 'workspace', 'model']) || config.region !== run.config.region
      || config.workspace !== run.config.workspace || config.model !== run.config.model) failure('SPEECH_CONFIG_INVALID');
    // Never propagate unknown bridge fields, raw credentials, or unsanitized provider metadata to UI.
    return {
      supported: true, hasKey: true, credentialRevision: value.credentialRevision,
      mainCredentialRevision: run.mainCredentialRevision, hasMainKey: run.hasMainKey,
      keySource: run.keySource, maskedKey: value.maskedKey, activeConfig: { ...run.config },
      ...(Object.hasOwn(value, 'maskedMainKey') && (masked(value.maskedMainKey) || (!run.hasMainKey && value.maskedMainKey === ''))
        ? { maskedMainKey: value.maskedMainKey as string } : {}),
    };
  }
  private current(run: ActiveTest): boolean { return !this.disposed && this.active === run; }
  private reject(run: ActiveTest, error: unknown): void {
    if (!this.current(run)) return;
    this.cancelActive();
    this.update('error', shortVoiceError(error));
  }
  private fail(code: string, phase = 'validation'): Promise<void> {
    this.update('error', shortVoiceError({ code, data: { phase } }));
    return Promise.resolve();
  }
  private update(state: VoiceCandidateTestState, message: string): void {
    if (this.disposed) return;
    this.state = state;
    this.message = message;
    this.changed();
  }
  private cancelActive(): void {
    const run = this.active;
    if (!run) return;
    this.finish(run);
    // Cancellation is best effort here. Native revisions/configuration IDs remain authoritative.
    try { void this.bridge.cancel({ sessionId: run.id }).catch(() => {}); } catch { /* Do not expose bridge errors. */ }
  }
  private finish(run: ActiveTest): void {
    if (this.active !== run) return;
    clearTimeout(run.timer);
    this.active = undefined;
    run.settle();
    releaseVoiceOperation(this.bridge, run);
  }
}
