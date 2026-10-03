import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

export interface NativeSpeechConfiguration {
  supported: boolean;
  hasKey: boolean;
  /** Opaque isolation token only. This is neither a credential nor an authorization grant. */
  credentialRevision: string;
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
export interface NativeSpeechResult { sessionId: string; text: string }
export interface NativeSpeechStateEvent {
  sessionId: string;
  state: 'connecting' | 'listening' | 'transcribing';
}
export interface NativeSpeechPlugin {
  configuration(): Promise<NativeSpeechConfiguration>;
  setKey(options: { value: string }): Promise<NativeSpeechConfiguration>;
  clearKey(): Promise<NativeSpeechConfiguration>;
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
  setKey: async options => { if (!isNativeSpeechSupported()) unsupported(); return nativePlugin.setKey(options); },
  clearKey: async () => { if (!isNativeSpeechSupported()) unsupported(); return nativePlugin.clearKey(); },
  start: async options => { if (!isNativeSpeechSupported()) unsupported(); return nativePlugin.start(options); },
  stop: async options => { if (!isNativeSpeechSupported()) unsupported(); return nativePlugin.stop(options); },
  cancel: async options => { if (!isNativeSpeechSupported()) unsupported(); return nativePlugin.cancel(options); },
  addListener: async (eventName, listener) => {
    if (!isNativeSpeechSupported()) unsupported();
    return nativePlugin.addListener(eventName, listener);
  },
};
