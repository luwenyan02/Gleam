import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fetchAiStream } from '../src/core/aiStreamTransport';

const state = vi.hoisted(() => ({ native: true, start: vi.fn(), read: vi.fn(), cancel: vi.fn() }));
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => state.native, getPlatform: () => 'android' },
  registerPlugin: () => state,
}));
const options = (signal?: AbortSignal): RequestInit => ({ method: 'POST', headers: { Authorization: 'Bearer synthetic-key', 'Content-Type': 'application/json' }, body: '{"stream":true}', signal });
const url = 'https://custom-model.example.invalid/v1/chat/completions';
const chunk = (text: string) => ({ dataBase64: btoa(String.fromCharCode(...new TextEncoder().encode(text))), done: false });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

beforeEach(() => {
  vi.resetAllMocks(); state.native = true;
  state.start.mockResolvedValue({ status: 200, contentType: 'text/event-stream' });
  state.read.mockResolvedValue({ done: true }); state.cancel.mockResolvedValue({});
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('buffered fetch forbidden'))));
});
afterEach(() => vi.unstubAllGlobals());

it('原生请求先取得headers，首块不等待整轮完成，保留末尾双换行', async () => {
  const tail = deferred<{ dataBase64: string; done: boolean }>();
  state.read.mockResolvedValueOnce(chunk('data: 首字\n\n')).mockReturnValueOnce(tail.promise);
  const response = await fetchAiStream(url, options());
  const reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: 首字\n\n');
  expect(fetch).not.toHaveBeenCalled();
  tail.resolve(chunk('data: [DONE]\n\n'));
  expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: [DONE]\n\n');
  expect((await reader.read()).done).toBe(true);
  expect(state.start).toHaveBeenCalledExactlyOnceWith({ id: expect.any(String), url, authorization: 'Bearer synthetic-key', body: '{"stream":true}' });
});

it('每个原生pull只请求一块，慢消费者不会无上限预取', async () => {
  state.read.mockResolvedValue(chunk('x'));
  const response = await fetchAiStream(url, options());
  await vi.waitFor(() => expect(state.read).toHaveBeenCalledOnce());
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(state.read).toHaveBeenCalledOnce();
  await response.body!.cancel(); expect(state.cancel).toHaveBeenCalledOnce();
});

it('Web仍走当前global fetch，原有模拟和浏览器流保持有效', async () => {
  state.native = false; const response = new Response('web'); vi.mocked(fetch).mockResolvedValue(response);
  expect(await fetchAiStream(url, options())).toBe(response);
  expect(fetch).toHaveBeenCalledExactlyOnceWith(url, options()); expect(state.start).not.toHaveBeenCalled();
});

it('开始前已取消不创建原生请求', async () => {
  const abort = new AbortController(); abort.abort();
  await expect(fetchAiStream(url, options(abort.signal))).rejects.toThrow();
  expect(state.start).not.toHaveBeenCalled();
});

it('headers未到时取消立即拒绝，迟到start仍再取消且不恢复读流', async () => {
  const start = deferred<{ status: number; contentType: string }>(); state.start.mockReturnValue(start.promise);
  const abort = new AbortController(), pending = fetchAiStream(url, options(abort.signal));
  await vi.waitFor(() => expect(state.start).toHaveBeenCalledOnce()); abort.abort();
  await expect(pending).rejects.toThrow(); expect(state.cancel).toHaveBeenCalledOnce();
  start.resolve({ status: 200, contentType: 'text/event-stream' });
  await vi.waitFor(() => expect(state.cancel).toHaveBeenCalledTimes(2)); expect(state.read).not.toHaveBeenCalled();
});

it('read悬挂时取消会终止ReadableStream；迟到片段不能复活', async () => {
  const read = deferred<{ dataBase64: string; done: boolean }>(); state.read.mockReturnValue(read.promise);
  const abort = new AbortController(), response = await fetchAiStream(url, options(abort.signal));
  const reader = response.body!.getReader(), pending = reader.read(); abort.abort();
  await expect(pending).rejects.toThrow();
  read.resolve(chunk('迟到')); expect(state.cancel).toHaveBeenCalledOnce();
});

it('非成功状态仅透传状态，不读取远端错误正文', async () => {
  state.start.mockResolvedValue({ status: 401, contentType: 'text/plain' });
  const response = await fetchAiStream(url, options());
  expect(response.status).toBe(401); expect(await response.text()).toBe(''); expect(state.read).not.toHaveBeenCalled();
  expect(state.cancel).toHaveBeenCalledOnce();
});

it.each([204, 205])('无正文状态%s立即释放原生会话', async status => {
  state.start.mockResolvedValue({ status });
  const response = await fetchAiStream(url, options());
  expect(response.status).toBe(status); expect(response.body).toBeNull();
  expect(state.cancel).toHaveBeenCalledOnce(); expect(state.read).not.toHaveBeenCalled();
});

it.each([{ dataBase64: 'bad !', done: false }, { dataBase64: btoa('x'.repeat(8193)), done: false }, { done: false }, { status: 'unknown' }])('非法原生块终止并取消，不泄漏native异常详情', async value => {
  state.read.mockResolvedValue(value);
  const response = await fetchAiStream(url, options());
  await expect(response.text()).rejects.toThrow('流式'); expect(state.cancel).toHaveBeenCalledOnce();
});

it('原生异常使用安全消息，不传出URL或凭据', async () => {
  state.start.mockRejectedValue(new Error('https://private.invalid Bearer synthetic-key'));
  await expect(fetchAiStream(url, options())).rejects.toThrow('流式请求失败');
});

it('跨块UTF8原样保留，EOF后取消信号不再产生原生控制', async () => {
  const bytes = new TextEncoder().encode('分块中文\n\n');
  for (const byte of bytes) state.read.mockResolvedValueOnce({ done: false, dataBase64: btoa(String.fromCharCode(byte)) });
  const abort = new AbortController(), response = await fetchAiStream(url, options(abort.signal));
  expect(await response.text()).toBe('分块中文\n\n'); abort.abort(); expect(state.cancel).not.toHaveBeenCalled();
});

it('累计正文超过有界响应上限时停止读取并取消', async () => {
  state.read.mockResolvedValue({ done: false, dataBase64: btoa('x'.repeat(8192)) });
  const response = await fetchAiStream(url, options());
  await expect(response.text()).rejects.toThrow('流式'); expect(state.read).toHaveBeenCalledTimes(257); expect(state.cancel).toHaveBeenCalledOnce();
});

it('并行请求按独立id读取，取消其中一个不影响另一个', async () => {
  const reads = deferred<{ done: boolean }>(); state.read.mockReturnValue(reads.promise);
  const a = await fetchAiStream(url, options()), b = await fetchAiStream(url, options());
  const [first, second] = state.start.mock.calls.map(call => call[0].id);
  expect(first).not.toBe(second); await a.body!.cancel();
  expect(state.cancel).toHaveBeenCalledExactlyOnceWith({ id: first });
  reads.resolve({ done: true });
  expect(await b.text()).toBe(''); expect(state.cancel).toHaveBeenCalledTimes(1);
});

it.each(['http://model.example.invalid/v1/chat/completions', 'https://user:secret@example.invalid/v1/chat/completions'])('拒绝非TLS或含URL凭据的native地址 %s', async destination => {
  await expect(fetchAiStream(destination, options())).rejects.toThrow(); expect(state.start).not.toHaveBeenCalled();
});
