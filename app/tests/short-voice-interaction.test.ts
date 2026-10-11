import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ configuration: vi.fn(), config: vi.fn(), prepare: vi.fn(), approve: vi.fn(), recognize: vi.fn(), revoke: vi.fn(), apply: vi.fn(), callbacks: undefined as any, start: vi.fn(), stop: vi.fn(), cancel: vi.fn(), dispose: vi.fn(), events: new Map<string, () => void>() }));
vi.mock('../src/core/nativeSpeech', () => ({ nativeSpeech: { configuration: mocks.configuration } }));
vi.mock('../src/core/bailianVoiceConfig', () => ({ getBailianVoiceConfig: mocks.config, bailianVoiceDestination: () => 'synthetic.cn-beijing.maas.aliyuncs.com' }));
vi.mock('../src/core/bailianVoiceSession', () => ({ BailianVoiceSession: class {
  busy = false;
  constructor(_bridge: unknown, callbacks: unknown) { mocks.callbacks = callbacks; }
  start(...args: unknown[]) { mocks.start(...args); this.busy = true; mocks.callbacks.onState('connecting'); }
  stop() { mocks.stop(); mocks.callbacks.onState('transcribing'); }
  cancel(message?: string) { mocks.cancel(); this.busy = false; mocks.callbacks.onState('idle'); if (message) mocks.callbacks.onError(message); }
  dispose() { mocks.dispose(); }
} }));
vi.mock('../src/core/repo/aiRepo', () => ({ prepareVoiceRecognition: mocks.prepare, approveVoiceRecognition: mocks.approve, recognizeVoiceDraft: mocks.recognize, revokeVoicePreview: mocks.revoke }));
vi.mock('../src/core/store', () => ({ on: (event: string, callback: () => void) => { mocks.events.set(event, callback); return () => {}; } }));
vi.mock('../src/shared/overlay', () => ({ manageOverlay: (_root: unknown, close: () => void) => { mocks.events.set('back', close); return () => {}; } }));
import { openShortVoice } from '../src/features/entry/shortVoice';

class ElementStub {
  value = ''; hidden = false; disabled = false; isConnected = true; textContent = ''; innerHTML = ''; className = '';
  dataset: Record<string, string> = {}; nodes = new Map<string, ElementStub>(); listeners = new Map<string, () => void>();
  parentElement: ElementStub | null = null; children: ElementStub[] = [];
  setAttribute() {} removeAttribute() {} remove() { this.isConnected = false; }
  focus() { (document as any).activeElement = this; }
  prepend(child: ElementStub) {
    if (child.parentElement) child.parentElement.children = child.parentElement.children.filter(node => node !== child);
    if ((document.activeElement as unknown) === child) (document as any).activeElement = null;
    child.parentElement = this; this.children.unshift(child);
  }
  querySelector(selector: string): ElementStub { if (!this.nodes.has(selector)) this.nodes.set(selector, new ElementStub()); return this.nodes.get(selector)!; }
  addEventListener(event: string, callback: () => void) { this.listeners.set(event, callback); }
  fire(event = 'click') { this.listeners.get(event)?.(); }
}
let root: ElementStub, close: () => void;
const q = (selector: string) => root.querySelector(`[data-sv-${selector}]`);
const snapshot = (text: string) => ({ text, destination: { baseUrl: 'https://synthetic.invalid/v1', model: 'synthetic' }, categoryNames: ['午餐'], accountNames: ['现金'] });
const parsedBill = { type: 'expense', amount: 2800, occurredAt: 1, note: '虚构午餐' };
async function flush() { for (let i = 0; i < 15; i++) await Promise.resolve(); }
async function recognizeResult() {
  mocks.recognize.mockResolvedValueOnce(parsedBill);
  mocks.callbacks.onText('午餐28元'); await flush(); q('send').fire(); await flush();
}
beforeEach(async () => {
  vi.clearAllMocks(); mocks.events.clear(); root = new ElementStub();
  mocks.configuration.mockResolvedValue({ supported: true, hasKey: true });
  mocks.config.mockResolvedValue({ region: 'beijing', workspace: 'synthetic', model: 'synthetic' });
  mocks.prepare.mockImplementation(async (text: string) => snapshot(text.trim()));
  mocks.approve.mockReturnValue({ voiceRecognition: true }); mocks.recognize.mockImplementation(() => new Promise(() => {}));
  mocks.apply.mockResolvedValue(undefined);
  vi.stubGlobal('document', { activeElement: null, hidden: false, body: { appendChild() {} }, createElement: () => root, addEventListener: (e: string, f: () => void) => mocks.events.set(e, f), removeEventListener() {} });
  vi.stubGlobal('window', { addEventListener: (e: string, f: () => void) => mocks.events.set(e, f), removeEventListener() {} });
  vi.stubGlobal('MutationObserver', class { observe() {} disconnect() {} });
  q('review-actions').prepend(q('rerecord')); q('result-actions').prepend(q('apply'));
  close = openShortVoice({ container: new ElementStub() as unknown as HTMLElement, applyLabel: '应用草稿', applyNote: '尚未保存', onApply: mocks.apply });
  await flush();
});
afterEach(() => { close(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('opening is local; explicit start shows connecting, never a false listening indication', () => {
  expect(mocks.start).not.toHaveBeenCalled(); expect(mocks.recognize).not.toHaveBeenCalled();
  q('start').fire(); expect(mocks.start).toHaveBeenCalledOnce();
  expect(q('activity').dataset.state).toBe('connecting'); expect(q('activity').hidden).toBe(false);
  expect(q('stop').hidden).toBe(true); expect(q('editor').hidden).toBe(true);
  q('start').fire(); expect(mocks.start).toHaveBeenCalledOnce();
});
it('listening and transcribing have distinct state visuals and only listening offers stop', () => {
  q('start').fire(); mocks.callbacks.onState('listening');
  expect(q('activity').dataset.state).toBe('listening'); expect(q('stop').hidden).toBe(false);
  q('stop').fire(); expect(q('activity').dataset.state).toBe('transcribing'); expect(q('stop').hidden).toBe(true);
  expect(q('cancel').hidden).toBe(false);
});
it('transcript automatically prepares a LOCAL preview; no AI until consent click', async () => {
  mocks.callbacks.onText('午餐28元'); await flush();
  expect(mocks.prepare).toHaveBeenCalledWith('午餐28元'); expect(mocks.recognize).not.toHaveBeenCalled();
  expect(q('send-panel').hidden).toBe(false); expect(q('send').disabled).toBe(false);
  expect(q('voice-prompt').hidden).toBe(true);
  q('send').fire(); expect(mocks.approve).toHaveBeenCalledOnce(); expect(mocks.recognize).toHaveBeenCalledOnce();
  q('send').fire(); expect(mocks.recognize).toHaveBeenCalledOnce();
});
it('editing immediately invalidates consent and debounces a fresh local preview', async () => {
  mocks.callbacks.onText('午餐28元'); await flush(); vi.useFakeTimers();
  q('text').value = '晚餐20元'; q('text').fire('input');
  expect(q('send-panel').hidden).toBe(true); expect(q('send').disabled).toBe(true);
  q('send').fire(); expect(mocks.recognize).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(300); expect(mocks.prepare).toHaveBeenLastCalledWith('晚餐20元');
  expect(q('send-panel').hidden).toBe(false);
});
it('a late older local preview never replaces the edited text destination snapshot', async () => {
  let resolve!: (value: unknown) => void;
  mocks.prepare.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  mocks.callbacks.onText('午餐28元'); vi.useFakeTimers(); q('text').value = '晚餐20元'; q('text').fire('input');
  await vi.advanceTimersByTimeAsync(300); resolve(snapshot('午餐28元')); await flush();
  expect(mocks.revoke).toHaveBeenCalledWith(snapshot('午餐28元'));
  q('send').fire(); expect(mocks.approve).toHaveBeenCalledWith(snapshot('晚餐20元'));
});
it('re-record returns to an explicit start without starting automatically', async () => {
  mocks.callbacks.onText('午餐28元'); await flush(); q('rerecord').fire();
  expect(q('voice-prompt').hidden).toBe(false); expect(mocks.start).not.toHaveBeenCalled();
  expect(q('text').value).toBe('午餐28元'); q('start').fire(); expect(mocks.start).toHaveBeenCalledOnce();
});
it('cancel hides all active animation and preserves the earlier editable transcript', async () => {
  mocks.callbacks.onText('午餐28元'); await flush(); q('rerecord').fire(); q('start').fire(); q('cancel').fire();
  expect(mocks.cancel).toHaveBeenCalledOnce(); expect(q('activity').hidden).toBe(true);
  expect(q('text').value).toBe('午餐28元'); expect(q('text').disabled).toBe(false);
  expect(q('preview').hidden).toBe(false); q('preview').fire(); await flush(); expect(q('send').disabled).toBe(false);
});
it('permission failure restores idle controls and never displays a success state', () => {
  q('start').fire(); mocks.callbacks.onState('idle'); mocks.callbacks.onError('麦克风未获授权');
  expect(q('activity').hidden).toBe(true); expect(q('start').disabled).toBe(false);
  expect(q('status').textContent).toBe('麦克风未获授权');
});
it('settings changes invalidate an already displayed consent before it can send', async () => {
  mocks.callbacks.onText('午餐28元'); await flush(); mocks.events.get('settings-changed')!();
  q('send').fire(); expect(mocks.recognize).not.toHaveBeenCalled();
});
it('back/close revokes pending local previews and ignores their late completion', async () => {
  let resolve!: (value: unknown) => void; mocks.prepare.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  mocks.callbacks.onText('午餐28元'); mocks.events.get('back')!(); resolve(snapshot('午餐28元')); await flush();
  expect(mocks.dispose).toHaveBeenCalledOnce(); expect(root.isConnected).toBe(false);
  expect(mocks.revoke).toHaveBeenCalledWith(snapshot('午餐28元')); expect(mocks.recognize).not.toHaveBeenCalled();
});

it('Chinese composition never prepares a partial sentence or allows stale consent', async () => {
  mocks.callbacks.onText('午餐28元'); await flush(); vi.useFakeTimers();
  q('text').fire('compositionstart'); q('text').value = 'wan'; q('text').fire('input');
  await vi.advanceTimersByTimeAsync(500); expect(mocks.prepare).toHaveBeenCalledTimes(1);
  expect(q('send').disabled).toBe(true);
  q('text').value = '晚餐20元'; q('text').fire('compositionend');
  await vi.advanceTimersByTimeAsync(300); expect(mocks.prepare).toHaveBeenLastCalledWith('晚餐20元');
});

it('a local preparation failure exposes a retry, never sends or marks a draft successful', async () => {
  mocks.prepare.mockRejectedValueOnce(new Error('请先配置文字 AI'));
  mocks.callbacks.onText('午餐28元'); await flush();
  expect(q('preview').hidden).toBe(false); expect(q('send-panel').hidden).toBe(true);
  expect(q('status').textContent).toBe('请先配置文字 AI');
  q('preview').fire(); await flush(); expect(q('send-panel').hidden).toBe(false);
  expect(mocks.recognize).not.toHaveBeenCalled();
});

it('cancelled AI results cannot overwrite the text or restore the apply button', async () => {
  let resolve!: (value: unknown) => void; mocks.recognize.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  mocks.callbacks.onText('午餐28元'); await flush(); q('send').fire(); q('cancel').fire();
  resolve({ type: 'expense', amount: 2800 }); await flush();
  expect(q('text').value).toBe('午餐28元'); expect(q('apply').disabled).toBe(true); expect(q('result').hidden).toBe(true);
  expect(q('rerecord').parentElement).toBe(q('review-actions'));
});

it('out-of-order configuration reads cannot replace the latest configured destination', async () => {
  let resolveA!: (value: unknown) => void;
  const configA = { region: 'beijing', workspace: 'older-space', model: 'older-model' };
  const configB = { region: 'singapore', workspace: 'current-space', model: 'current-model' };
  const readinessB = { supported: true, hasKey: true, credentialRevision: 'B' };
  mocks.configuration.mockResolvedValueOnce({ ...readinessB, credentialRevision: 'A' }).mockResolvedValueOnce(readinessB);
  mocks.config.mockImplementationOnce(() => new Promise(done => { resolveA = done; })).mockResolvedValueOnce(configB);
  mocks.events.get('settings-changed')!(); await flush(); expect(q('start').disabled).toBe(true);
  mocks.events.get('settings-changed')!(); await flush();
  expect(q('start').disabled).toBe(false);
  resolveA(configA); await flush(); q('start').fire();
  expect(mocks.start).toHaveBeenCalledWith(configB, readinessB);
  expect(mocks.start).toHaveBeenCalledOnce();
});

it('background during the edit debounce cancels pending local preparation', async () => {
  vi.useFakeTimers(); q('text').value = '午餐28元'; q('text').fire('input');
  mocks.events.get('pagehide')!(); await vi.advanceTimersByTimeAsync(500);
  expect(mocks.prepare).not.toHaveBeenCalled(); expect(q('send-panel').hidden).toBe(true);
  expect(q('preview').hidden).toBe(false); expect(q('text').value).toBe('午餐28元');
});

it('routine voice UI contains only operations, status and review fields, with no explanatory sections', async () => {
  for (const copy of ['可能产生费用', '语音服务详情', '使用说明', '发送内容详情', '候选分类与账户名称']) expect(root.innerHTML).not.toContain(copy);
  expect(root.innerHTML).toContain('>发送并生成草稿</button>');
  expect(root.innerHTML).not.toContain('同意并开始');
  expect(root.innerHTML).not.toContain('class="tiny"');
  expect(mocks.start).not.toHaveBeenCalled(); expect(mocks.recognize).not.toHaveBeenCalled();
  mocks.callbacks.onText('午餐28元'); await flush();
  expect(q('send-panel').hidden).toBe(false); expect(mocks.recognize).not.toHaveBeenCalled();
});

it('places re-record beside send below the transcript rather than in its heading', () => {
  const editor = root.innerHTML.slice(root.innerHTML.indexOf('short-voice-editor-head'), root.innerHTML.indexOf('</textarea>'));
  expect(editor).not.toContain('data-sv-rerecord');
  const actions = root.innerHTML.slice(root.innerHTML.indexOf('short-voice-review-actions'));
  expect(actions).toMatch(/data-sv-rerecord[\s\S]*data-sv-send/);
});

it('keeps re-record intrinsic width so the send flex item cannot collapse behind the global full-width button rule', () => {
  const css = readFileSync('src/features/entry/shortVoice.css', 'utf8');
  const declaration = css.match(/\.short-voice-review-actions>\[data-sv-rerecord\]\{([^}]+)\}/)?.[1];
  expect(declaration).toContain('width:auto');
  expect(declaration).toContain('min-height:48px');
});

it('moves the original re-record button beside Apply only after a recognized draft is ready', async () => {
  const rerecord = q('rerecord');
  expect(root.innerHTML.match(/data-sv-rerecord/g)).toHaveLength(1);
  expect(root.innerHTML).toContain('data-sv-review-actions');
  expect(root.innerHTML).toMatch(/data-sv-fields><\/dl><div class="short-voice-result-actions" data-sv-result-actions><button[^>]*data-sv-apply/);
  await recognizeResult();
  expect(q('rerecord')).toBe(rerecord);
  expect(q('result-actions').children).toEqual([rerecord, q('apply')]);
  expect(q('review-actions').children).not.toContain(rerecord);
  expect(q('result').hidden).toBe(false); expect(q('send-panel').hidden).toBe(true);
  expect(rerecord.hidden).toBe(false); expect(rerecord.disabled).toBe(false);
  expect(q('apply').disabled).toBe(false); expect(mocks.apply).not.toHaveBeenCalled();
  expect(mocks.start).not.toHaveBeenCalled(); expect(mocks.recognize).toHaveBeenCalledOnce();
});

it('the moved button keeps its handler and waits for explicit Start before clearing the result', async () => {
  await recognizeResult(); const rerecord = q('rerecord'); rerecord.fire(); rerecord.fire();
  expect(q('voice-prompt').hidden).toBe(false); expect(rerecord.hidden).toBe(true);
  expect(document.activeElement).toBe(q('start'));
  expect(q('text').value).toBe('午餐28元'); expect(q('result').hidden).toBe(false);
  expect(mocks.start).not.toHaveBeenCalled(); expect(mocks.recognize).toHaveBeenCalledOnce();
  q('start').fire();
  expect(mocks.start).toHaveBeenCalledOnce(); expect(q('result').hidden).toBe(true);
  expect(q('apply').disabled).toBe(true); expect(rerecord.parentElement).toBe(q('review-actions'));
});

it('editing a recognized draft returns the same button to the review row and requires fresh consent', async () => {
  await recognizeResult(); const rerecord = q('rerecord'); vi.useFakeTimers();
  q('text').value = '晚餐20元'; q('text').fire('input');
  expect(rerecord.parentElement).toBe(q('review-actions')); expect(q('result').hidden).toBe(true);
  expect(q('apply').disabled).toBe(true); expect(q('send-panel').hidden).toBe(true);
  q('apply').fire(); q('send').fire(); expect(mocks.apply).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(300);
  expect(q('send-panel').hidden).toBe(false); expect(mocks.recognize).toHaveBeenCalledOnce();
  expect(mocks.start).not.toHaveBeenCalled();
});

it('settings invalidation preserves focus while returning re-record to the review row', async () => {
  await recognizeResult(); const rerecord = q('rerecord'); rerecord.focus();
  mocks.events.get('settings-changed')!(); await flush();
  expect(rerecord.parentElement).toBe(q('review-actions')); expect(document.activeElement).toBe(rerecord);
  expect(q('result').hidden).toBe(true); expect(q('apply').disabled).toBe(true);
  expect(mocks.start).not.toHaveBeenCalled(); expect(mocks.recognize).toHaveBeenCalledOnce();
});

it('AI failure leaves re-record in the review row without a final result', async () => {
  mocks.recognize.mockRejectedValueOnce(new Error('模拟识别失败'));
  mocks.callbacks.onText('午餐28元'); await flush(); q('send').fire(); await flush();
  expect(q('rerecord').parentElement).toBe(q('review-actions'));
  expect(q('rerecord').disabled).toBe(false); expect(q('preview').hidden).toBe(false);
  expect(q('result').hidden).toBe(true); expect(q('apply').disabled).toBe(true);
});

it('Apply locks both result actions against duplicate input and restores them after failure', async () => {
  let reject!: (error: Error) => void;
  mocks.apply.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  await recognizeResult(); const rerecord = q('rerecord');
  const reparent = vi.spyOn(q('result-actions'), 'prepend');
  q('apply').fire(); q('apply').fire(); rerecord.fire();
  expect(rerecord.disabled).toBe(true); expect(q('apply').disabled).toBe(true);
  expect(q('voice-prompt').hidden).toBe(true); await flush(); expect(mocks.apply).toHaveBeenCalledOnce();
  expect(mocks.apply).toHaveBeenCalledWith(parsedBill, '午餐28元');
  reject(new Error('模拟应用失败')); await flush();
  expect(q('result-actions').children).toEqual([rerecord, q('apply')]);
  expect(q('result').hidden).toBe(false); expect(q('status').textContent).toBe('草稿未应用，请重试');
  expect(rerecord.disabled).toBe(false); expect(q('apply').disabled).toBe(false);
  expect(reparent).not.toHaveBeenCalled();
  q('apply').fire(); await flush(); expect(mocks.apply).toHaveBeenCalledTimes(2);
  expect(root.isConnected).toBe(false); expect(mocks.start).not.toHaveBeenCalled();
});

it('the result footer keeps intrinsic re-record width and lets long Apply labels wrap safely', () => {
  const css = readFileSync('src/features/entry/shortVoice.css', 'utf8');
  const rerecord = css.match(/\.short-voice-result-actions>\[data-sv-rerecord\]\{([^}]+)\}/)?.[1];
  const apply = css.match(/\.short-voice-result-actions>\[data-sv-apply\]\{([^}]+)\}/)?.[1];
  expect(rerecord).toContain('width:auto'); expect(rerecord).toContain('min-height:48px');
  expect(apply).toContain('flex:1'); expect(apply).toContain('min-width:0');
  expect(apply).toContain('overflow-wrap:anywhere');
});
