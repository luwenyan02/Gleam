import { BailianVoiceConnectionTest } from '../../core/bailianVoiceConnectionTest';
import { bailianVoiceDestination, getBailianVoiceConfig, type BailianVoiceConfig } from '../../core/bailianVoiceConfig';
import { shortVoiceError } from '../../core/bailianVoiceErrors';
import { nativeSpeech, type NativeSpeechConfiguration } from '../../core/nativeSpeech';
import { on } from '../../core/store';

interface ConsentSnapshot { config: BailianVoiceConfig; readiness: NativeSpeechConfiguration }
interface TestView {
  container: HTMLElement; test: BailianVoiceConnectionTest; sequence: number; pending: boolean;
  consent?: ConsentSnapshot; error?: string; copyMessage?: string; copying?: boolean; pendingTimer?: ReturnType<typeof setTimeout>; disposed: boolean; dispose(): void;
}
let view: TestView | undefined;
let epoch = 0;
let credentialWritePending = false;
/** Async full-page renders must retry when a draft, credential or test state changes. */
export function getVoiceSettingsEpoch(): number { return epoch; }
export function setVoiceTestCredentialWritePending(pending: boolean): void {
  credentialWritePending = pending;
  invalidateVoiceConnectionTest(pending ? '语音 Key 正在更新，更新后请重新测试' : undefined);
}

export function voiceConnectionTestHtml(supported: boolean, hasKey: boolean): string {
  return `<div class="ai-actions"><button class="chip" data-voice-test data-supported="${supported}" data-has-key="${hasKey}"${supported && hasKey ? '' : ' disabled'}>测试语音连接</button><button class="chip" data-voice-test-cancel hidden>取消测试</button></div>
    <section data-voice-test-consent hidden aria-label="确认语音连接测试">
      <p class="tiny" data-voice-test-recipient></p>
      <p class="tiny">同意后将使用已安全保存的语音 Key，向以上阿里云百炼地址发送鉴权与会话配置请求，可能产生服务商费用。本次不请求麦克风权限、不录音、不发送音频、文字或账本数据。</p>
      <button class="chip" data-voice-test-confirm>同意并测试连接</button>
    </section>
    <p class="tiny" data-voice-test-status data-state="idle" role="status" aria-live="polite">尚未测试连接；保存 Key 不会调用服务</p>
    <div class="ai-actions"><button class="chip" data-voice-test-copy hidden>复制诊断结果</button></div>
    <p class="tiny" data-voice-test-copy-status role="status" aria-live="polite" hidden></p>`;
}

export function mountVoiceConnectionTest(container: HTMLElement): () => void {
  view?.dispose();
  const current: TestView = { container, sequence: 0, pending: false, disposed: false,
    test: new BailianVoiceConnectionTest(nativeSpeech, () => { epoch++; syncVoiceConnectionTest(container); }),
    dispose: () => {},
  };
  view = current; epoch++;
  const invalidate = () => invalidateVoiceConnectionTest('测试已取消，重新测试需要再次同意');
  const visibility = () => { if (document.hidden) invalidate(); };
  const offRoute = on('route-changed', invalidate);
  const offSettings = on('settings-changed', payload => {
    const key = payload && typeof payload === 'object' && 'key' in payload ? (payload as { key?: unknown }).key : undefined;
    if (key === undefined || (typeof key === 'string' && key.startsWith('voice.bailian.'))) invalidateVoiceConnectionTest();
  });
  document.addEventListener('visibilitychange', visibility); window.addEventListener('pagehide', invalidate);
  const page = container.closest<HTMLElement>('.subpage');
  const observer = new MutationObserver(() => {
    if (!container.isConnected) { current.dispose(); return; }
    if (page?.inert || page?.getAttribute('aria-hidden') === 'true') {
      if (current.pending || current.consent || current.test.state !== 'idle') invalidate();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  if (page) observer.observe(page, { attributes: true, attributeFilter: ['inert', 'aria-hidden'] });
  current.dispose = () => {
    if (current.disposed) return;
    current.disposed = true; current.sequence++; clearTimeout(current.pendingTimer); current.test.dispose(); epoch++;
    observer.disconnect(); offRoute(); offSettings();
    document.removeEventListener('visibilitychange', visibility); window.removeEventListener('pagehide', invalidate);
    if (view === current) view = undefined;
  };
  return current.dispose;
}

export function invalidateVoiceConnectionTest(message?: string): void {
  epoch++;
  if (!view || view.disposed) return;
  view.sequence++; clearTimeout(view.pendingTimer); view.pending = false; view.consent = undefined; view.error = undefined; view.copyMessage = undefined; view.copying = false;
  view.test.invalidate(message);
}

export function syncVoiceConnectionTest(container: HTMLElement): void {
  const current = view; if (!current || current.container !== container || current.disposed) return;
  const q = <T extends HTMLElement>(selector: string) => container.querySelector<T>(selector);
  const button = q<HTMLButtonElement>('[data-voice-test]');
  if (button) button.disabled = button.dataset.supported !== 'true' || button.dataset.hasKey !== 'true'
    || credentialWritePending || current.pending || !!current.consent || current.test.busy;
  const cancel = q<HTMLButtonElement>('[data-voice-test-cancel]');
  if (cancel) cancel.hidden = !current.pending && !current.consent && !current.test.busy;
  const panel = q('[data-voice-test-consent]'); if (panel) panel.hidden = !current.consent;
  const confirm = q<HTMLButtonElement>('[data-voice-test-confirm]'); if (confirm) confirm.disabled = !current.consent || current.pending;
  const recipient = q('[data-voice-test-recipient]');
  if (recipient) recipient.textContent = current.consent ? recipientText(current.consent.config) : '';
  const hasDiagnostic = !!current.error || current.test.state === 'error';
  const copy = q<HTMLButtonElement>('[data-voice-test-copy]');
  if (copy) { copy.hidden = !hasDiagnostic; copy.disabled = !!current.copying; }
  const copyStatus = q('[data-voice-test-copy-status]');
  if (copyStatus) { copyStatus.hidden = !hasDiagnostic || !current.copyMessage; copyStatus.textContent = current.copyMessage ?? ''; }
  const status = q('[data-voice-test-status]');
  if (status) {
    status.dataset.state = current.error ? 'error' : current.pending ? 'preparing' : current.consent ? 'consent' : current.test.state;
    status.textContent = current.error ?? (current.pending ? '正在核对本机设置…' : current.consent ? '核对接收方后，同意才会发起连接测试' : current.test.message);
  }
}

function recipientText(config: BailianVoiceConfig): string {
  return `接收方：阿里云百炼；地域：${config.region === 'beijing' ? '北京' : '新加坡'}；模型：${config.model}；域名：${bailianVoiceDestination(config)}`;
}
function currentDraftMatches(current: TestView, config: BailianVoiceConfig): boolean {
  const key = current.container.querySelector<HTMLInputElement>('#voice-bailian-key')?.value ?? '';
  const workspace = current.container.querySelector<HTMLInputElement>('#voice-bailian-workspace')?.value ?? '';
  const model = current.container.querySelector<HTMLInputElement>('#voice-bailian-model')?.value;
  return !key && workspace.trim() === config.workspace && model === config.model;
}
function isCurrent(current: TestView, sequence: number): boolean {
  const page = current.container.closest<HTMLElement>('.subpage');
  return view === current && !current.disposed && current.sequence === sequence && current.container.isConnected && !document.hidden
    && !credentialWritePending && !page?.inert && page?.getAttribute('aria-hidden') !== 'true';
}
function failure(current: TestView, code: string): void {
  clearTimeout(current.pendingTimer); current.pending = false; current.consent = undefined;
  current.error = shortVoiceError({ code, data: { phase: 'validation' } });
  epoch++; syncVoiceConnectionTest(current.container);
}
function boundPreflight(current: TestView, sequence: number): void {
  clearTimeout(current.pendingTimer);
  current.pendingTimer = setTimeout(() => {
    if (!isCurrent(current, sequence)) return;
    current.sequence++; failure(current, 'SPEECH_TIMEOUT');
  }, 10_000);
}
async function prepare(current: TestView): Promise<void> {
  const sequence = ++current.sequence;
  current.copyMessage = undefined; current.copying = false;
  current.test.invalidate(); current.pending = true; current.error = undefined; epoch++; syncVoiceConnectionTest(current.container);
  boundPreflight(current, sequence);
  try {
    const [config, readiness] = await Promise.all([getBailianVoiceConfig(), nativeSpeech.configuration()]);
    if (!isCurrent(current, sequence)) return;
    if (!readiness.supported) { failure(current, 'SPEECH_UNSUPPORTED'); return; }
    if (!readiness.hasKey) { failure(current, 'SPEECH_KEY_REQUIRED'); return; }
    if (!currentDraftMatches(current, config)) { failure(current, 'SPEECH_CONFIG_INVALID'); return; }
    clearTimeout(current.pendingTimer); current.pending = false; current.consent = { config, readiness }; epoch++; syncVoiceConnectionTest(current.container);
  } catch { if (isCurrent(current, sequence)) failure(current, 'SPEECH_CONFIG_INVALID'); }
}
async function confirm(current: TestView): Promise<void> {
  const snapshot = current.consent; if (!snapshot || current.pending) return;
  const sequence = ++current.sequence;
  current.pending = true; current.consent = undefined; epoch++; syncVoiceConnectionTest(current.container);
  boundPreflight(current, sequence);
  try {
    const [config, readiness] = await Promise.all([getBailianVoiceConfig(), nativeSpeech.configuration()]);
    if (!isCurrent(current, sequence)) return;
    if (readiness.credentialRevision !== snapshot.readiness.credentialRevision) { failure(current, 'SPEECH_KEY_CHANGED'); return; }
    if (!currentDraftMatches(current, config) || config.region !== snapshot.config.region
      || config.workspace !== snapshot.config.workspace || config.model !== snapshot.config.model) { failure(current, 'SPEECH_CONFIG_INVALID'); return; }
    clearTimeout(current.pendingTimer); current.pending = false; epoch++;
    // Consent is consumed once. Only this explicit confirm path may invoke the native probe.
    void current.test.start(config, readiness);
  } catch { if (isCurrent(current, sequence)) failure(current, 'SPEECH_CONFIG_INVALID'); }
}
async function copyDiagnostic(current: TestView): Promise<void> {
  // Copy only our fixed sanitized error, never DOM text or configuration/snapshot data.
  const diagnostic = current.error ?? (current.test.state === 'error' ? current.test.message : undefined);
  if (!diagnostic || current.copying || current.pending || current.consent || current.test.busy) return;
  const sequence = current.sequence;
  current.copying = true; current.copyMessage = undefined; epoch++; syncVoiceConnectionTest(current.container);
  let message = '诊断结果已复制';
  try { await navigator.clipboard.writeText(diagnostic); }
  catch { message = '复制失败，可截图保存诊断结果'; }
  if (!isCurrent(current, sequence)) return;
  current.copying = false; current.copyMessage = message; epoch++; syncVoiceConnectionTest(current.container);
}
export function handleVoiceConnectionTestClick(target: HTMLElement, container: HTMLElement): boolean {
  const test = target.closest<HTMLButtonElement>('[data-voice-test]');
  const agree = target.closest<HTMLButtonElement>('[data-voice-test-confirm]');
  const cancel = target.closest<HTMLButtonElement>('[data-voice-test-cancel]');
  const copy = target.closest<HTMLButtonElement>('[data-voice-test-copy]');
  if (!test && !agree && !cancel && !copy) return false;
  const current = view;
  if (!current || current.container !== container || current.disposed || credentialWritePending) return true;
  if (copy) { if (!copy.disabled) void copyDiagnostic(current); return true; }
  if (cancel) { invalidateVoiceConnectionTest('测试已取消，重新测试需要再次同意'); return true; }
  if (test && !test.disabled && !current.pending && !current.test.busy && !current.consent) void prepare(current);
  else if (agree && !agree.disabled && current.consent) void confirm(current);
  return true;
}
