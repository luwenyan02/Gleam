import { Capacitor, registerPlugin } from '@capacitor/core';

interface NativeHeaders { status: number; contentType?: string; }
interface NativeChunk { done: boolean; dataBase64?: string; }
interface NativeAiStream {
  start(options: { id: string; url: string; authorization: string; body: string }): Promise<NativeHeaders>;
  read(options: { id: string }): Promise<NativeChunk>;
  cancel(options: { id: string }): Promise<void>;
}
const native = registerPlugin<NativeAiStream>('GleamAiStream');
const MAX_CHUNK_BYTES = 8192;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
// Existing chat permits nine photos with up to 15M data-URL characters each.
const MAX_REQUEST_CHARS = 140_000_000;
const aborted = () => new DOMException('AI 请求已取消', 'AbortError');
const failed = () => new Error('AI 流式请求失败，请重试');

/** Android uses a bounded native pull stream; all other requests retain browser fetch. */
export async function fetchAiStream(url: string, init: RequestInit): Promise<Response> {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') return fetch(url, init);
  if (init.signal?.aborted) throw aborted();
  const destination = new URL(url), headers = new Headers(init.headers);
  if (destination.protocol !== 'https:' || destination.username || destination.password || destination.hash
    || init.method?.toUpperCase() !== 'POST' || typeof init.body !== 'string' || init.body.length > MAX_REQUEST_CHARS
    || !headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw failed();
  const id = crypto.randomUUID(), signal = init.signal;
  let closed = false, controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let rejectAbort!: (error: Error) => void;
  const cancellation = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const cancelNative = () => { void native.cancel({ id }).catch(() => {}); };
  const clean = () => { closed = true; signal?.removeEventListener('abort', abort); };
  const abort = () => {
    if (closed) return;
    clean(); cancelNative(); rejectAbort(aborted()); controller?.error(aborted());
  };
  signal?.addEventListener('abort', abort, { once: true });
  const pending = native.start({ id, url, authorization: headers.get('authorization') ?? '', body: init.body });
  // A cancellation can beat native's start dispatch; close the late-created session too.
  void pending.then(() => { if (closed) cancelNative(); }, () => {});
  let response: NativeHeaders;
  try {
    response = await Promise.race([pending, cancellation]);
    if (closed || signal?.aborted) throw aborted();
    if (!Number.isInteger(response.status) || response.status < 200 || response.status > 599
      || (response.contentType != null && (typeof response.contentType !== 'string' || response.contentType.length > 256 || /[\r\n]/.test(response.contentType)))) throw failed();
  } catch {
    if (!closed) { clean(); cancelNative(); }
    throw signal?.aborted ? aborted() : failed();
  }
  const responseHeaders: HeadersInit = response.contentType ? { 'Content-Type': response.contentType } : {};
  if (response.status < 200 || response.status >= 300 || response.status === 204 || response.status === 205) {
    clean(); cancelNative();
    return new Response(null, { status: response.status, headers: responseHeaders });
  }
  let total = 0;
  const body = new ReadableStream<Uint8Array>({
    start(value) { controller = value; },
    async pull(value) {
      if (closed) return;
      try {
        const chunk = await native.read({ id });
        if (closed) return;
        if (chunk.done === true) { clean(); value.close(); return; }
        if (chunk.done !== false || typeof chunk.dataBase64 !== 'string' || !chunk.dataBase64.length
          || chunk.dataBase64.length > Math.ceil(MAX_CHUNK_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(chunk.dataBase64)) throw failed();
        const decoded = atob(chunk.dataBase64);
        total += decoded.length;
        if (!decoded.length || decoded.length > MAX_CHUNK_BYTES || total > MAX_RESPONSE_BYTES) throw failed();
        value.enqueue(Uint8Array.from(decoded, character => character.charCodeAt(0)));
      } catch {
        if (closed) return;
        clean(); cancelNative(); value.error(signal?.aborted ? aborted() : failed());
      }
    },
    cancel() { if (!closed) { clean(); cancelNative(); } },
  });
  return new Response(body, { status: response.status, headers: responseHeaders });
}
