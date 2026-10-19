import type { BailianVoiceConfig } from './bailianVoiceConfig';
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

export interface NativeSpeechConfiguration {
  supported: boolean;
  hasKey: boolean;
  /** Opaque isolation token only. This is neither a credential nor an authorization grant. */
  credentialRevision: string;
  keySource?: 'separate' | 'shared';
  maskedKey?: string;
  maskedMainKey?: string;
  hasMainKey?: boolean;
  mainCredentialRevision?: string;
  activeConfig?: BailianVoiceConfig;
}
export interface NativeSpeechStartOptions {
  sessionId: string;
  expectedCredentialRevision: string;
  region: 'beijing' | 'singapore';
  workspace: string;
  model: 'qwen3.8-omni-flash-realtime';
  consent: true;
  userInitiated: true;
}
export interface NativeSpeechCandidateOptions extends NativeSpeechStartOptions {
  keySource: 'separate' | 'shared';
  value?: string;
  configurationId: string;
  expectedMainCredentialRevision: string;
}
export interface NativeSpeechCandidateResult { sessionId: string; connected: true; candidateToken: string }
export interface NativeSpeechCommitOptions {
  sessionId: string;
  candidateToken: string;
  expectedCredentialRevision: string;
  expectedMainCredentialRevision: string;
  configurationId: string;
}
export interface NativeSpeechConnectionResult { sessionId: string; connected: true }
export interface NativeSpeechResult { sessionId: string; text: string }
export interface NativeSpeechStateEvent {
  sessionId: string;
  state: 'connecting' | 'listening' | 'transcribing';
  /** 当前会话的中间转写，仅用于预览；不能作为最终账单输入。 */
  text?: string;
}
export interface NativeSpeechPlugin {
  configuration(): Promise<NativeSpeechConfiguration>;
  invalidateConfiguration(options: { configurationId: string }): Promise<void>;
  testCandidate(options: NativeSpeechCandidateOptions): Promise<NativeSpeechCandidateResult>;
  commitTestedKey(options: NativeSpeechCommitOptions): Promise<NativeSpeechConfiguration>;
  testConnection(options: NativeSpeechStartOptions): Promise<NativeSpeechConnectionResult>;
  start(options: NativeSpeechStartOptions): Promise<NativeSpeechResult>;
  stop(options: { sessionId: string }): Promise<void>;
  cancel(options: { sessionId: string }): Promise<void>;
  addListener(eventName: 'state', listener: (event: NativeSpeechStateEvent) => void): Promise<PluginListenerHandle>;
}

export function isNativeSpeechSupported(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
}
const nativePlugin = registerPlugin<NativeSpeechPlugin>('GleamSpeech');
function unsupported(): never {
  throw Object.assign(new Error('百炼短语音仅支持 Android 应用，请使用文字输入'), { code: 'SPEECH_UNSUPPORTED' });
}
/** Key entry is write-only. No frontend credential storage/readback or browser microphone fallback. */
export const nativeSpeech: NativeSpeechPlugin = {
  configuration: () => isNativeSpeechSupported()
    ? nativePlugin.configuration()
    : Promise.resolve({ supported: false, hasKey: false, credentialRevision: '' }),
  invalidateConfiguration: async options => { if (!isNativeSpeechSupported()) unsupported(); return nativePlugin.invalidateConfiguration(options); },
  testCandidate: async options => { if (!isNativeSpeechSupported()) unsupported(); return nativePlugin.testCandidate(options); },
  commitTestedKey: async options => { if (!isNativeSpeechSupported()) unsupported(); return nativePlugin.commitTestedKey(options); },
  testConnection: async options => { if (!isNativeSpeechSupported()) unsupported(); return nativePlugin.testConnection(options); },
  start: async options => { if (!isNativeSpeechSupported()) unsupported(); return nativePlugin.start(options); },
  stop: async options => { if (!isNativeSpeechSupported()) unsupported(); return nativePlugin.stop(options); },
  cancel: async options => { if (!isNativeSpeechSupported()) unsupported(); return nativePlugin.cancel(options); },
  addListener: async (eventName, listener) => {
    if (!isNativeSpeechSupported()) unsupported();
    return nativePlugin.addListener(eventName, listener);
  },
};

