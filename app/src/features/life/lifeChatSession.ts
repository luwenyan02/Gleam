import type { LifeDraft } from '../../core/types';
import { continueLifeChat, type LifeAiInput } from '../../core/repo/lifeAiRepo';
import { putLifeDraft } from '../../core/repo/lifeDraftRepo';
import { getSetting } from '../../core/repo/settingsRepo';
import { on } from '../../core/store';
import type { LifeLedgerReview } from '../../core/repo/lifeLedgerContextRepo';

export const unsavedChatDrafts = new Map<string, LifeDraft>();
const writes = new Map<string, Promise<void>>();
const active = new Map<string, ChatReply>();

export function stageChatDraft(draft: LifeDraft): LifeDraft {
  draft.chatUpdatedAt = Date.now();
  const copy = structuredClone(draft);
  unsavedChatDrafts.set(draft.key, copy);
  return copy;
}

/** 页面和离页请求共用一条写队列，较早的进度不能覆盖完成后的消息。 */
export function persistChatDraft(draft: LifeDraft): Promise<void> {
  const copy = stageChatDraft(draft);
  const current = (writes.get(draft.key) ?? Promise.resolve()).catch(() => {}).then(async () => {
    await putLifeDraft(copy);
    if (unsavedChatDrafts.get(draft.key) === copy) unsavedChatDrafts.delete(draft.key);
  });
  writes.set(draft.key, current);
  void current.finally(() => { if (writes.get(draft.key) === current) writes.delete(draft.key); }).catch(() => {});
  return current;
}

export interface ChatReply {
  draft: LifeDraft;
  running: boolean;
  error?: unknown;
  saveFailed: boolean;
  ledgerReview?: LifeLedgerReview;
  done: Promise<void>;
  stop(): void;
  subscribe(listener: () => void): () => void;
}

export function getActiveChatReply(key: string): ChatReply | undefined { return active.get(key); }

/** 仅在本次素材/目的地已获确认后启动。持有请求的是会话，而非聊天页面。 */
export function startChatReply(
  draft: LifeDraft, messageIndex: number, regenerate: boolean,
  options: Pick<LifeAiInput, 'photos' | 'ledgerGrant' | 'expectedDestination'> & { ledgerAnalysis?: boolean; ledgerReview?: LifeLedgerReview },
): ChatReply {
  const running = active.get(draft.key);
  if (running) return running;
  const controller = new AbortController();
  const signal = controller.signal;
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reply: ChatReply = {
    draft, running: true, saveFailed: false, ledgerReview: options.ledgerReview, done: Promise.resolve(),
    stop: () => controller.abort(),
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  const notify = () => { for (const listener of listeners) listener(); };
  const persist = async () => {
    try { await persistChatDraft(draft); reply.saveFailed = false; }
    catch { reply.saveFailed = true; }
  };
  const flush = () => { clearTimeout(timer); timer = undefined; void persist(); };
  const onHidden = () => { if (document.visibilityState === 'hidden') flush(); };
  // 浏览器/系统可能终止进程；尽量提前落盘，重启只恢复检查点，不自动调用付费接口。
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onHidden);
  if (typeof window !== 'undefined') window.addEventListener('pagehide', flush);
  const off = on('settings-changed', () => {
    void getSetting('life.aiEnabled').then(enabled => { if (!enabled) controller.abort(); });
  });
  active.set(draft.key, reply);
  const previous = draft.chatReply;
  draft.chatReply = { messageIndex, regenerate, status: 'waiting',
    content: previous?.messageIndex === messageIndex && previous.regenerate === regenerate ? previous.content : '',
    ...(options.ledgerAnalysis ? { ledgerAnalysis: true } : {}) };
  reply.done = (async () => {
    // 先保存用户消息和请求状态，再发送；保存失败时仍在内存中保留完整草稿。
    await persist();
    try {
      if (signal.aborted) throw new Error('已停止');
      const turn = await continueLifeChat({
        body: '', messages: structuredClone(draft.messages.slice(0, messageIndex + 1)),
        photos: options.photos, ledgerGrant: options.ledgerGrant, expectedDestination: options.expectedDestination,
        signal, noteId: draft.noteId, sourceUpdatedAt: draft.sourceUpdatedAt,
        onDelta: content => {
          if (signal.aborted || !reply.running || content.length > 12_000) return;
          draft.chatReply!.content = content;
          draft.chatReply!.status = 'streaming';
          // 固定间隔而非防抖，连续长回复也会定期保存。
          if (timer == null) timer = setTimeout(flush, 350);
          notify();
        },
      });
      if (signal.aborted) throw new Error('已停止');
      if (regenerate) draft.messages.splice(messageIndex + 1);
      if (options.ledgerAnalysis) draft.messages[messageIndex].ledgerAnalysis = true;
      draft.messages.push({ role: 'assistant', content: turn.reply, repliedAt: Date.now(),
        ...(options.ledgerAnalysis ? { ledgerAnalysis: true } : {}) });
      draft.chatReply = undefined;
    } catch (error) {
      reply.error = error;
      draft.chatReply!.status = signal.aborted ? 'stopped' : 'failed';
    } finally {
      clearTimeout(timer);
      off();
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onHidden);
      if (typeof window !== 'undefined') window.removeEventListener('pagehide', flush);
      await persist();
      reply.running = false;
      active.delete(draft.key);
      notify();
      listeners.clear();
    }
  })();
  return reply;
}
