import { Capacitor } from '@capacitor/core';
import { fetchAiStream } from '../../core/aiStreamTransport';
import { getSetting } from '../../core/repo/settingsRepo';
import { secretStore } from '../../core/secretStore';
import { on } from '../../core/store';
import { buildNoteDecision, parseNoteDecision, type NoteDecisionInput, type NoteDecisionResult } from './noteDecision';

const MAX_RESPONSE_BYTES = 1024 * 1024;
const failed = () => new Error('备注推荐暂不可用，请稍后重试');
const RELEVANT_SETTINGS = new Set(['ai.noteDecision.enabled', 'ai.noteDecision.workspace', 'ai.noteDecision.region', 'ai.baseUrl', 'ai.apiKey']);

export function noteDecisionSupported(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
}

/** Only explicit official hosts can share the main AI credential with Bailian. */
export function isBailianAiBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash && !url.search
      && (['dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com', 'dashscope-us.aliyuncs.com'].includes(url.hostname)
        || /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.(?:cn-beijing|ap-southeast-1)\.maas\.aliyuncs\.com$/.test(url.hostname));
  } catch { return false; }
}

export function validNoteDecisionWorkspace(value: string): boolean {
  return /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(value);
}

async function configuration() {
  if (!noteDecisionSupported() || await getSetting('ai.noteDecision.enabled') !== true) return null;
  const [baseUrl, workspace, region] = await Promise.all([
    getSetting('ai.baseUrl'), getSetting('ai.noteDecision.workspace'), getSetting('ai.noteDecision.region'),
  ]);
  if (typeof baseUrl !== 'string' || !isBailianAiBaseUrl(baseUrl) || typeof workspace !== 'string'
    || !validNoteDecisionWorkspace(workspace) || !['beijing', 'singapore'].includes(region)) return null;
  const key = await secretStore.get('ai.apiKey');
  if (!key?.trim()) return null;
  return { baseUrl, workspace, region, key };
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.ok || !response.body || Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => {}); throw failed();
  }
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let total = 0, text = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) { void reader.cancel().catch(() => {}); throw failed(); }
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally { reader.releaseLock(); }
}

/** Opt-in Android request. Cancellation, consent revocation and stale configuration produce no suggestion. */
export async function requestNoteDecision(input: NoteDecisionInput, signal?: AbortSignal): Promise<NoteDecisionResult> {
  if (signal?.aborted || !noteDecisionSupported()) return {};
  const controller = new AbortController();
  let stop!: (result: NoteDecisionResult) => void;
  const cancelled = new Promise<NoteDecisionResult>(resolve => { stop = resolve; });
  const cancel = () => { controller.abort(); stop({}); };
  signal?.addEventListener('abort', cancel, { once: true });
  const unsubscribe = on('settings-changed', payload => {
    const key = (payload as { key?: string } | undefined)?.key;
    if (!key || RELEVANT_SETTINGS.has(key)) cancel();
  });
  const timeout = setTimeout(cancel, 12_000);
  try {
    return await Promise.race([cancelled, (async () => {
      const config = await configuration();
      if (!config || controller.signal.aborted) return {};
      const built = buildNoteDecision(input);
      if (!built || controller.signal.aborted) return {};
      const region = config.region === 'beijing' ? 'cn-beijing' : 'ap-southeast-1';
      const response = await fetchAiStream(`https://${config.workspace}.${region}.maas.aliyuncs.com/compatible-mode/v1/systemone`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.key}` },
        body: JSON.stringify(built.request), signal: controller.signal,
      });
      if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); return {}; }
      const parsed = parseNoteDecision(await readJson(response), built.context);
      const current = await configuration();
      if (controller.signal.aborted || !current || current.baseUrl !== config.baseUrl || current.key !== config.key
        || current.workspace !== config.workspace || current.region !== config.region) return {};
      return parsed;
    })()]);
  } catch { if (controller.signal.aborted) return {}; throw failed(); }
  finally { clearTimeout(timeout); signal?.removeEventListener('abort', cancel); unsubscribe(); }
}
