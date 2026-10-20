import type { ChatWebSearch } from './types';
import { safeSearchSource, validChatWebSearch } from './chatWebSearch';
import { LIFE_CHAT_PROMPT } from './lifeChatPrompt';

export function supportsVoiceSearch(model: string): boolean {
  return /^qwen3\.(?:8-omni-flash|5-omni(?:-(?:flash|plus))?)-realtime(?:[-\w.]*)?$/i.test(model);
}

/** Structured service metadata only; prose and Markdown links are never search evidence. */
export function sanitizeVoiceSearch(value: unknown): ChatWebSearch | undefined {
  const data = value as ChatWebSearch | null;
  if (!data || !validChatWebSearch({ status: data.status, sources: [] }) || !Array.isArray(data.sources)) return;
  const sources = new Map<string, ChatWebSearch['sources'][number]>();
  if (data.status === 'searched') for (const entry of data.sources.slice(0, 120)) {
    const source = safeSearchSource(entry);
    if (source) sources.set(source.url, source);
    if (sources.size === 12) break;
  }
  return { status: data.status, sources: [...sources.values()] };
}

interface Response {
  status?: unknown;
  usage?: { plugins?: { search?: { count?: unknown } } };
  search_info?: { search_results?: unknown[] };
  search_results?: unknown[];
}
export function liveVoiceSearch(value: unknown): ChatWebSearch {
  const response = (value && typeof value === 'object' ? value : {}) as Response;
  if (response.status !== 'completed') return { status: 'failed', sources: [] };
  const count = response.usage?.plugins?.search?.count;
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) return { status: 'unknown', sources: [] };
  if (count === 0) return { status: 'not-used', sources: [] };
  const lists = [response.search_info?.search_results, response.search_results].filter(Array.isArray);
  return sanitizeVoiceSearch({ status: 'searched', sources: lists.flatMap(list => list.slice(0, 120)) })!;
}

export function voiceInstructions(search: boolean): string {
  return `${LIFE_CHAT_PROMPT}\n当前设备日期：${new Date().toLocaleDateString('sv-SE')}。使用自然中文口语，先讲最有用的内容，适合语音听取，不朗读 Markdown 标记。${search
    ? '本次已启用百炼内置联网搜索，天气、时事等实时问题可按需检索；不要沿用历史回复中不能联网的声明。只能根据本轮实际检索结果回答实时问题，未搜索、失败或证据不足时如实说明，不编造天气、来源、搜索状态或已经核实的结论。'
    : '本次语音模型未接入联网搜索，实时信息未核实；只说明当前会话的能力，不替其他模型作判断。'}`;
}
