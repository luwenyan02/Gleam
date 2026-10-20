import type { LifeChatMessage } from './types';

/** Transport-local identity/completion; never persisted as a chat message or sent to AI. */
export interface VoiceTranscriptMessage extends Pick<LifeChatMessage, 'role' | 'content' | 'search'> {
  id?: string;
  complete?: boolean;
}
export type VoiceTextDestination = { baseUrl: string; model: string };
