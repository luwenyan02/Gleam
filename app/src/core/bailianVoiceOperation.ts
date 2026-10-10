import type { NativeSpeechPlugin } from './nativeSpeech';
/** UI guard only; the native session arbiter remains authoritative. */
const owners = new WeakMap<NativeSpeechPlugin, object>();
export function claimVoiceOperation(bridge: NativeSpeechPlugin, owner: object): boolean {
  if (owners.has(bridge)) return false;
  owners.set(bridge, owner); return true;
}
export function releaseVoiceOperation(bridge: NativeSpeechPlugin, owner: object): void {
  if (owners.get(bridge) === owner) owners.delete(bridge);
}
