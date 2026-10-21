import type { ChatWebSearch } from './types';
import { fetchAiStream } from './aiStreamTransport';

const STATES = ['enabled', 'searching', 'searched', 'not-used', 'unsupported', 'failed', 'unknown'];
const SEARCH_TIMEOUT = 120_000;
const MAX_REPLY = 12_000;

/** 仅适配官方已明确支持 Responses 搜索的百炼模型，不猜测自定义代理的能力。 */
export function webSearchEndpoint(baseUrl: string, model: string): string | undefined {
  try {
    const url = new URL(baseUrl.trim());
    const official = /^(?:dashscope(?:-intl|-us)?\.aliyuncs\.com|[a-z0-9-]+\.[a-z0-9-]+\.maas\.aliyuncs\.com)$/.test(url.hostname);
    const supported = /^(?:qwen3\.(?:8|7|5)-(?:max|plus|flash)(?:[-\w.]*)?|qwen3\.6-(?:plus|flash|35b-a3b)(?:[-\w.]*)?|deepseek-v4(?:\.1)?-(?:pro|flash)(?:[-\w.]*)?|kimi-k3|glm-5\.2)$/i.test(model);
    const path = url.pathname.replace(/\/+$/, '').replace(/\/(?:chat\/completions|responses)$/, '');
    if (!official || !supported || url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash || path !== '/compatible-mode/v1') return;
    return url.origin + path + '/responses';
  } catch { return; }
}

export function safeSearchSource(value: unknown): ChatWebSearch['sources'][number] | undefined {
  const source = value as { url?: unknown; title?: unknown } | null;
  if (!source || typeof source.url !== 'string' || source.url.length > 2048 || /[\u0000-\u0020]/.test(source.url)) return;
  try {
    const url = new URL(source.url);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || !url.hostname) return;
    return { url: url.href, title: typeof source.title === 'string' && source.title.trim() ? source.title.trim().slice(0, 180) : url.hostname };
  } catch { return; }
}

/** 同时用于草稿校验和展示；备份/旧记录中的字段也不能绕过链接边界。 */
export function validChatWebSearch(value: unknown): value is ChatWebSearch {
  const data = value as ChatWebSearch | null;
  return !!data && STATES.includes(data.status) && Array.isArray(data.sources) && data.sources.length <= 12
    && (data.status === 'searched' || data.sources.length === 0)
    && data.sources.every(source => typeof source?.title === 'string' && source.title.length <= 180 && !!safeSearchSource(source));
}

export function searchInstructions(messages: unknown[], enabled: boolean): unknown[] {
  const date = new Date().toLocaleDateString('sv-SE');
  const instruction = `当前设备日期：${date}。${enabled
    ? '本次已提供 web_search 联网搜索工具，按问题需要调用；不要沿用历史对话中的“不能联网”声明。只有工具实际执行并返回结果后，才可说已搜索或核实。未执行搜索、失败或来源不足时，明确说明，不能编造实时结论。不编造来源编号。'
    : '本次配置未接入联网搜索，不能核实实时信息；只说明本次请求的限制，不宣称模型本身没有搜索能力。'}`;
  const first = messages[0] as { role?: string; content?: unknown } | undefined;
  return first?.role === 'system' && typeof first.content === 'string'
    ? [{ ...first, content: first.content + '\n' + instruction }, ...messages.slice(1)]
    : [{ role: 'system', content: instruction }, ...messages];
}

interface SearchRequest {
  endpoint: string;
  model: string;
  apiKey: string;
  messages: unknown[];
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
  onSearch: (state: ChatWebSearch) => void;
}
interface ResponseItem {
  id?: string;
  type?: string;
  status?: string;
  action?: { sources?: unknown[] };
  content?: Array<{ type?: string; text?: string }>;
}
interface SearchResponse {
  status?: string;
  error?: unknown;
  output?: ResponseItem[];
  usage?: { x_tools?: { web_search?: { count?: number } } };
}

/** Responses 的思考参数不能直接套用 Chat Completions；其余模型保留已有行为。 */
function searchModelOptions(model: string): Record<string, unknown> {
  // 官方 Responses 参数表：Qwen3.8 Max/Flash 默认 xhigh，支持 none。
  if (/^qwen3\.8-(?:max|flash)(?:[-\w.]*)?$/i.test(model)) return { reasoning: { effort: 'none' } };
  // Qwen3.7 仍支持此开关；这两个 Max 版本只支持思考，不能强行关闭。
  if (/^qwen3\.7-(?:max|plus|flash)(?:[-\w.]*)?$/i.test(model)
    && !/^qwen3\.7-max-(?:preview|2026-05-17)$/i.test(model)) return { enable_thinking: false };
  return {};
}

/** 独立请求边界：只有普通文字聊天调用；不自动回退重发，也不读取错误响应正文。 */
export async function requestWebSearchChat(request: SearchRequest): Promise<string> {
  const { endpoint, model, apiKey, signal, onDelta, onSearch } = request;
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, SEARCH_TIMEOUT);
  signal?.addEventListener('abort', abort, { once: true });
  let state: ChatWebSearch = { status: 'enabled', sources: [] };
  let searched = false, searchFailed = false, content = '';
  const sources = new Map<string, ChatWebSearch['sources'][number]>();
  const update = (status: ChatWebSearch['status']) => {
    state = { status, sources: status === 'searched' ? [...sources.values()] : [] };
    if (!signal?.aborted) onSearch(structuredClone(state));
  };
  const item = (entry: ResponseItem) => {
    if (entry.type !== 'web_search_call') return;
    if (entry.status === 'completed') {
      searched = true;
      for (const value of entry.action?.sources ?? []) {
        const source = safeSearchSource(value);
        if (source && sources.size < 12) sources.set(source.url, source);
      }
      update('searched');
    } else if (['failed', 'incomplete'].includes(entry.status ?? '')) { searchFailed = true; }
    else update('searching');
  };
  const completed = (response: SearchResponse): string => {
    if (response.status !== 'completed' || response.error) throw new Error('回复中断，请重试');
    for (const entry of response.output ?? []) item(entry);
    const count = response.usage?.x_tools?.web_search?.count;
    if (Number.isSafeInteger(count) && count! > 0) searched = true;
    update(searched ? 'searched' : searchFailed || state.status === 'searching' ? 'failed' : 'not-used');
    const final = (response.output ?? []).filter(entry => entry.type === 'message')
      .flatMap(entry => entry.content ?? []).filter(part => part.type === 'output_text' && typeof part.text === 'string').map(part => part.text).join('');
    if (final) content = final;
    if (!content.trim() || content.length > MAX_REPLY) throw new Error('回复为空或过长，请重试');
    return content;
  };
  try {
    if (signal?.aborted) throw new Error('已取消');
    update('enabled');
    const input = request.messages.map(value => {
      const message = value as { role: string; content: unknown };
      return { ...message, content: Array.isArray(message.content) ? message.content.map(part => part.type === 'image_url'
        ? { type: 'input_image', image_url: part.image_url.url }
        : { type: 'input_text', text: part.text }) : message.content };
    });
    const response = await (onDelta ? fetchAiStream : fetch)(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, ...searchModelOptions(model), input, tools: [{ type: 'web_search' }], store: false, ...(onDelta ? { stream: true } : {}) }),
      signal: controller.signal,
    });
    if (signal?.aborted || controller.signal.aborted) throw new Error('已取消');
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403
      ? '联网搜索配置不可用，请检查 AI 设置' : '本次联网请求失败，请重试');
    if (!onDelta || !response.headers.get('content-type')?.includes('text/event-stream')) {
      const data: SearchResponse = await response.json();
      if (signal?.aborted || controller.signal.aborted) throw new Error('已取消');
      return completed(data);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('回复中断，请重试');
    const decoder = new TextDecoder();
    let buffer = '', finished = false;
    const parts = new Map<number, Map<number, string>>();
    const refreshContent = () => {
      content = [...parts.entries()].sort(([a], [b]) => a - b)
        .flatMap(([, values]) => [...values.entries()].sort(([a], [b]) => a - b).map(([, text]) => text)).join('');
      if (content.length > MAX_REPLY) throw new Error('AI 返回内容过长');
    };
    const partIndex = (value: unknown): number => {
      if (value === undefined) return 0;
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('联网回复内容索引无效');
      return value;
    };
    const textPart = (outputIndex: unknown, contentIndex: unknown, text: string, append = false) => {
      const output = partIndex(outputIndex), index = partIndex(contentIndex);
      const values = parts.get(output) ?? new Map<number, string>();
      const value = (append ? values.get(index) ?? '' : '') + text;
      if (value) values.set(index, value); else values.delete(index);
      // 仅保留非空块，块数量受 MAX_REPLY 限制；稀疏索引也不扩张数组。
      if (values.size) parts.set(output, values); else parts.delete(output);
      refreshContent();
    };
    try {
      while (!finished) {
        const chunk = await reader.read();
        if (signal?.aborted || controller.signal.aborted) throw new Error('已取消');
        buffer += decoder.decode(chunk.value, { stream: !chunk.done });
        if (buffer.length > 1_000_000) throw new Error('联网返回内容过长');
        // CapacitorHttp 会丢掉最后一个换行；EOF 只补分帧，成功仍须明确的 completed。
        if (chunk.done && buffer.trim()) buffer += '\n\n';
        let match: RegExpExecArray | null;
        while ((match = /\r?\n\r?\n/.exec(buffer))) {
          const event = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length);
          const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
          if (!data) continue;
          if (data === '[DONE]') throw new Error('回复中断，请重试');
          const parsed = JSON.parse(data);
          const type = typeof parsed.type === 'string' ? parsed.type
            : event.split(/\r?\n/).find(line => line.startsWith('event:'))?.slice(6).trim();
          if (type === 'error' || type === 'response.failed' || type === 'response.incomplete') throw new Error('联网回复未完成，请重试');
          if (/^response\.web_search_call\.(?:in_progress|searching)$/.test(type)) update('searching');
          if (type === 'response.output_item.done' && parsed.item) {
            item(parsed.item);
            if (parsed.item.type === 'message' && Array.isArray(parsed.item.content)) {
              const values = new Map<number, string>();
              parsed.item.content.forEach((part: { type?: string; text?: string }, index: number) => {
                if (part.type === 'output_text' && typeof part.text === 'string' && part.text) values.set(index, part.text);
              });
              const output = partIndex(parsed.output_index);
              if (values.size) parts.set(output, values); else parts.delete(output);
              refreshContent();
            }
          }
          if (type === 'response.output_text.done' && typeof parsed.text === 'string') {
            textPart(parsed.output_index, parsed.content_index, parsed.text);
          }
          if (type === 'response.content_part.done' && parsed.part?.type === 'output_text' && typeof parsed.part.text === 'string') {
            textPart(parsed.output_index, parsed.content_index, parsed.part.text);
          }
          if (type === 'response.output_text.delta' && typeof parsed.delta === 'string') {
            textPart(parsed.output_index, parsed.content_index, parsed.delta, true);
            onDelta(content);
          }
          if (type === 'response.completed') { completed(parsed.response); finished = true; break; }
        }
        if (chunk.done) break;
      }
      if (!finished) throw new Error('回复中断，请重试');
      return content;
    } finally {
      // 清理网络流不应阻塞已经确认的完成、失败或取消结果。
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  } catch (error) {
    if (state.status === 'enabled' || state.status === 'searching') update('failed');
    if (signal?.aborted) throw new Error('AI 请求已取消');
    if (controller.signal.aborted) throw new Error('联网请求超时（120 秒），请重试');
    if (error instanceof TypeError || error instanceof SyntaxError) throw new Error('本次联网请求失败，请重试');
    throw error;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
