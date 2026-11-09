import type { LifeChatMessage } from './types';

export const LIFE_SUMMARY_REQUEST_CHARS = 24_000;
const MAX_SUMMARY_CHARS = 200_000;
const MAX_SUMMARY_MESSAGES = 2_000;
const MAX_SUMMARY_SEGMENTS = 20;
const tooLong = () => new Error('当前对话过长，暂不能整理；完整对话仍保留在本机。');
type TextMessage = Pick<LifeChatMessage, 'role' | 'content'>;

export interface LifeSummaryPlan {
  sources: string[];
  sourceMessageCount: number;
  characters: number;
}

/** 完整切分出站文字，不借用聊天的近期上下文裁剪，也不修改本机历史。 */
export function prepareLifeSummary(body: string, messages: LifeChatMessage[]): LifeSummaryPlan {
  if (typeof body !== 'string' || !Array.isArray(messages)) throw new Error('对话内容无效');
  if (messages.length > MAX_SUMMARY_MESSAGES) throw tooLong();
  let characters = body.length;
  for (const message of messages) {
    if (!message || !['user', 'assistant'].includes(message.role) || typeof message.content !== 'string') throw new Error('对话内容无效');
    characters += message.content.length;
    if (characters > MAX_SUMMARY_CHARS) throw tooLong();
  }
  if (characters > MAX_SUMMARY_CHARS) throw tooLong();
  const text = messages.map(({ role, content }) => ({ role, content }));
  const sourceMessageCount = messages.length;
  const encode = (original: string, conversation: TextMessage[]) => JSON.stringify({ 原话: original, 对话: conversation, sourceMessageCount });
  const complete = encode(body, text);
  if (complete.length <= LIFE_SUMMARY_REQUEST_CHARS) return { sources: [complete], sourceMessageCount, characters };
  const sources: string[] = [];
  let batch: TextMessage[] = [];
  const flush = () => {
    if (!batch.length) return;
    sources.push(encode('', batch)); batch = [];
    if (sources.length > MAX_SUMMARY_SEGMENTS) throw tooLong();
  };
  for (const message of [...(body ? [{ role: 'user' as const, content: body }] : []), ...text]) {
    if (encode('', [...batch, message]).length <= LIFE_SUMMARY_REQUEST_CHARS) { batch.push(message); continue; }
    flush();
    if (encode('', [message]).length <= LIFE_SUMMARY_REQUEST_CHARS) { batch.push(message); continue; }
    let remaining = message.content;
    while (remaining) {
      // JSON 转义和代理对均计入实际请求体大小，单条长语音也能完整切分。
      let low = 1, high = remaining.length, fit = 0;
      while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        if (encode('', [{ role: message.role, content: remaining.slice(0, mid) }]).length <= LIFE_SUMMARY_REQUEST_CHARS) { fit = mid; low = mid + 1; }
        else high = mid - 1;
      }
      if (fit < remaining.length && /[\uD800-\uDBFF]/.test(remaining[fit - 1]) && /[\uDC00-\uDFFF]/.test(remaining[fit])) fit--;
      if (!fit) throw tooLong();
      batch.push({ role: message.role, content: remaining.slice(0, fit) }); remaining = remaining.slice(fit);
      if (remaining) flush();
    }
  }
  flush();
  return { sources, sourceMessageCount, characters };
}

export const summaryNotesSource = (notes: string[], sourceMessageCount: number): string => JSON.stringify({ 分段素材: notes, sourceMessageCount });

/** 中间素材受限为 4k 转义字符；每组合并至少收缩，最多20段不会无限追加请求。 */
export function groupSummaryNotes(notes: string[], sourceMessageCount: number): string[][] {
  const batches: string[][] = [];
  let batch: string[] = [];
  for (const note of notes) {
    if (summaryNotesSource([...batch, note], sourceMessageCount).length > LIFE_SUMMARY_REQUEST_CHARS) { batches.push(batch); batch = []; }
    batch.push(note);
  }
  if (batch.length) batches.push(batch);
  return batches;
}
