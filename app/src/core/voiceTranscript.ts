import type { LifeChatMessage } from './types';

/** Transport-local identity/completion; never persisted as a chat message or sent to AI. */
export interface VoiceTranscriptMessage extends Pick<LifeChatMessage, 'role' | 'content' | 'search'> {
  id?: string;
  order?: number;
  complete?: boolean;
}
export type VoiceTextDestination = { baseUrl: string; model: string };

export type VoiceTranscriptMode = 'upsert';
export const MAX_VOICE_TURN_CHARS = 128 * 1024;

/** A fixed checkpoint: continuous speech cannot postpone the next local write. */
export class VoiceDraftCheckpoint {
  private timer?: ReturnType<typeof setTimeout>;
  private dirty = false;
  constructor(private save: () => void | Promise<void>) {}
  changed(): void {
    this.dirty = true;
    if (this.timer == null) this.timer = setTimeout(() => this.flush(), 1000);
  }
  flush(): void {
    clearTimeout(this.timer); this.timer = undefined;
    if (!this.dirty) return;
    this.dirty = false; void this.save();
  }
}
