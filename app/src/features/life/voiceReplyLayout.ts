import type { LifeChatMessage } from '../../core/types';
import type { VoiceTextDestination } from '../../core/voiceTranscript';

/** Avoid another request for short speech or text that is already laid out. */
export function needsVoiceLayout(text: string): boolean {
  return text.trim().length >= 120 && text.length <= 12_000
    && !/^(?:#{1,6}\s|\s*[-*+]\s|\s*\d+[.)]\s|>\s|```|\s*\|?\s*:?-{3,}:?\s*\|)/m.test(text);
}
interface Input { transcript: string; expectedDestination: VoiceTextDestination; signal: AbortSignal; }
interface Job extends Input { message: LifeChatMessage; controller: AbortController; }

/** One formatting request at a time; the original speech remains the message's source. */
export class VoiceReplyLayouts {
  private attempted = new WeakMap<LifeChatMessage, string>();
  private jobs = new Set<Job>();
  private queue: Job[] = [];
  private running = false;
  private errorShown = false;
  constructor(private options: {
    format: (input: Input) => Promise<string>;
    isCurrent: (message: LifeChatMessage) => boolean;
    onChange: () => void;
    onError: () => void;
  }) {}
  add(message: LifeChatMessage, expectedDestination: VoiceTextDestination): void {
    if (message.role !== 'assistant' || message.voiceDisplay || !needsVoiceLayout(message.content)
      || this.attempted.get(message) === message.content || !this.options.isCurrent(message)) return;
    this.attempted.set(message, message.content);
    const controller = new AbortController();
    const job = { message, transcript: message.content, expectedDestination, controller, signal: controller.signal };
    this.jobs.add(job); this.queue.push(job); void this.run();
  }
  cancel(): void {
    for (const job of this.jobs) job.controller.abort();
    this.queue = []; this.jobs.clear();
  }
  private valid(job: Job): boolean {
    return !job.signal.aborted && job.message.content === job.transcript && this.options.isCurrent(job.message);
  }
  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      let job: Job | undefined;
      while ((job = this.queue.shift())) {
        try {
          if (!this.valid(job)) continue;
          const display = (await this.options.format({ transcript: job.transcript, expectedDestination: job.expectedDestination, signal: job.signal })).trim();
          if (!this.valid(job)) continue;
          if (!display || display.length > 12_000) throw new Error('语音排版无效');
          if (display !== job.transcript.trim()) { job.message.voiceDisplay = display; this.options.onChange(); }
        } catch {
          if (this.valid(job) && !this.errorShown) { this.errorShown = true; this.options.onError(); }
        } finally { this.jobs.delete(job); }
      }
    } finally { this.running = false; }
  }
}
