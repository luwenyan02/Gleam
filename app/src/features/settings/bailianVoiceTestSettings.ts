import { BailianVoiceCandidateTest } from '../../core/bailianVoiceCandidateTest';
import { esc } from '../../core/esc';
import { isAiKeyWritePending } from './aiKeySettings';
import { validateBailianVoiceConfig, type BailianVoiceConfig } from '../../core/bailianVoiceConfig';
import { shortVoiceError } from '../../core/bailianVoiceErrors';
import { nativeSpeech, type NativeSpeechConfiguration } from '../../core/nativeSpeech';
import { on } from '../../core/store';
import { showToast } from '../shell/toast';

interface TestView {
  container: HTMLElement; test: BailianVoiceCandidateTest; configurationId: string; nativeInvalidation: Promise<void>;
  sequence: number; pending: boolean; error?: string; announced?: string;
  pendingTimer?: ReturnType<typeof setTimeout>; disposed: boolean; dispose(): void;
}
let view: TestView | undefined;
let epoch = 0;
let credentialWritePending = false;
let nativeAuthorityQueue: Promise<void> = Promise.resolve();
/** Async full-page renders must retry when a draft, credential or test state changes. */
export function getVoiceSettingsEpoch(): number { return epoch; }
export function setVoiceTestCredentialWritePending(pending: boolean): void {
  credentialWritePending = pending;
  invalidateVoiceConnectionTest();
}

export function voiceConnectionTestHtml(supported: boolean, hasKey: boolean, readiness?: NativeSpeechConfiguration): string {
  return `<div class="ai-actions"><button class="chip" data-voice-test data-state="idle" data-supported="${supported}" data-has-key="${hasKey}" data-key-source="${readiness?.keySource ?? 'separate'}" data-has-main-key="${!!readiness?.hasMainKey}" data-masked-key="${esc(readiness?.maskedKey ?? '')}" data-masked-main-key="${esc(readiness?.maskedMainKey ?? '')}"${supported ? '' : ' disabled'}>测试语音连接</button></div>`;
}

export function mountVoiceConnectionTest(container: HTMLElement): () => void {
  view?.dispose();
  const current: TestView = { container, sequence: 0, pending: false, disposed: false, configurationId: crypto.randomUUID(), nativeInvalidation: Promise.resolve(),
    test: new BailianVoiceCandidateTest(nativeSpeech, () => {
      epoch++; syncVoiceConnectionTest(container);
      if (isCurrent(current, current.sequence)
        && (current.test.state === 'success' || current.test.state === 'error')) announce(current, current.test.message);
    }, readiness => applyCommittedConfiguration(container, readiness)),
    dispose: () => {},
  };
  view = current; epoch++; rotateNativeAuthority(current);
  const invalidate = () => invalidateVoiceConnectionTest();
  const visibility = () => { if (document.hidden) invalidate(); };
  const offRoute = on('route-changed', invalidate);
  const offSettings = on('settings-changed', payload => {
    const key = payload && typeof payload === 'object' && 'key' in payload ? (payload as { key?: unknown }).key : undefined;
    if (key === undefined || (typeof key === 'string' && (key.startsWith('voice.bailian.') || key === 'ai.apiKey'))) invalidateVoiceConnectionTest();
  });
  document.addEventListener('visibilitychange', visibility); window.addEventListener('pagehide', invalidate);
  const page = container.closest<HTMLElement>('.subpage');
  const observer = new MutationObserver(() => {
    if (!container.isConnected) { current.dispose(); return; }
    if ((page?.inert || page?.getAttribute('aria-hidden') === 'true') && (current.pending || current.test.state !== 'idle')) invalidate();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  if (page) observer.observe(page, { attributes: true, attributeFilter: ['inert', 'aria-hidden'] });
  current.dispose = () => {
    if (current.disposed) return;
    rotateNativeAuthority(current); current.disposed = true; current.sequence++; clearTimeout(current.pendingTimer); current.test.dispose(); epoch++;
    observer.disconnect(); offRoute(); offSettings();
    document.removeEventListener('visibilitychange', visibility); window.removeEventListener('pagehide', invalidate);
    if (view === current) view = undefined;
  };
  return current.dispose;
}

export function invalidateVoiceConnectionTest(message?: string): void {
  epoch++;
  if (!view || view.disposed) return;
  rotateNativeAuthority(view); view.sequence++; clearTimeout(view.pendingTimer); view.pending = false; view.error = undefined; view.announced = undefined;
  view.test.invalidate(message);
}
export function syncVoiceConnectionTest(container: HTMLElement): void {
  const current = view; if (!current || current.container !== container || current.disposed) return;
  const q = <T extends HTMLElement>(selector: string) => container.querySelector<T>(selector);
  const button = q<HTMLButtonElement>('[data-voice-test]');
  if (!button) return;
  const busy = current.pending || current.test.busy;
  const shared = !!q<HTMLInputElement>('#voice-key-shared')?.checked;
  const typed = !!q<HTMLInputElement>('#voice-bailian-key')?.value.trim();
  const hasCandidate = shared ? button.dataset.hasMainKey === 'true' : typed || (button.dataset.hasKey === 'true' && button.dataset.keySource !== 'shared');
  button.disabled = !busy && (button.dataset.supported !== 'true' || !hasCandidate || isAiKeyWritePending() || credentialWritePending);
  button.textContent = busy ? '取消测试' : '测试语音连接';
  button.dataset.state = current.error ? 'error' : current.pending ? 'preparing' : current.test.state;
  // Keep the fixed sanitized diagnostic available to accessibility/hover without adding a new panel.
  button.title = current.error ?? (current.test.state === 'error' ? current.test.message : '');
}
function announce(current: TestView, message: string): void {
  const identity = `${current.sequence}:${message}`;
  if (current.announced === identity) return;
  current.announced = identity;
  const reasonStart = message.indexOf('；原因：');
  const summary = reasonStart < 0 ? message : `${message.slice(0, reasonStart)}）`;
  showToast(summary, current.error || current.test.state === 'error' ? 5000 : 2200);
}
function readDraft(current: TestView): { config: BailianVoiceConfig; keySource: 'shared' | 'separate'; value: string } {
  const q = <T extends HTMLElement>(selector: string) => current.container.querySelector<T>(selector);
  const config = validateBailianVoiceConfig({
    region: (q('#voice-bailian-region')?.dataset.region ?? 'beijing') as 'beijing' | 'singapore',
    workspace: q<HTMLInputElement>('#voice-bailian-workspace')?.value.trim() ?? '',
    model: q<HTMLInputElement>('#voice-bailian-model')?.value as BailianVoiceConfig['model'],
  });
  const keySource = q<HTMLInputElement>('#voice-key-shared')?.checked ? 'shared' : 'separate';
  return { config, keySource, value: keySource === 'shared' ? '' : q<HTMLInputElement>('#voice-bailian-key')?.value.trim() ?? '' };
}
function rotateNativeAuthority(current: TestView): void {
  const configurationId = crypto.randomUUID(); current.configurationId = configurationId;
  nativeAuthorityQueue = nativeAuthorityQueue.catch(() => {}).then(() => nativeSpeech.invalidateConfiguration({ configurationId }));
  current.nativeInvalidation = nativeAuthorityQueue;
  void current.nativeInvalidation.catch(() => {});
}
function applyCommittedConfiguration(container: HTMLElement, readiness: NativeSpeechConfiguration): void {
  const key = container.querySelector<HTMLInputElement>('#voice-bailian-key');
  const source = container.querySelector<HTMLInputElement>('#voice-key-shared');
  const test = container.querySelector<HTMLButtonElement>('[data-voice-test]');
  if (key) { key.value = ''; key.placeholder = readiness.maskedKey ?? ''; delete key.dataset.voiceDirty; }
  if (source) { source.checked = readiness.keySource === 'shared'; delete source.dataset.voiceDirty; }
  if (test) {
    test.dataset.hasKey = String(readiness.hasKey); test.dataset.keySource = readiness.keySource ?? 'separate';
    test.dataset.hasMainKey = String(!!readiness.hasMainKey); test.dataset.maskedKey = readiness.maskedKey ?? ''; test.dataset.maskedMainKey = readiness.maskedMainKey ?? '';
  }
  for (const selector of ['#voice-bailian-workspace', '#voice-bailian-region']) {
    const input = container.querySelector<HTMLElement>(selector); if (input) delete input.dataset.voiceDirty;
  }
}
function isCurrent(current: TestView, sequence: number): boolean {
  const page = current.container.closest<HTMLElement>('.subpage');
  return view === current && !current.disposed && current.sequence === sequence && current.container.isConnected && !document.hidden
    && !credentialWritePending && !isAiKeyWritePending() && !page?.inert && page?.getAttribute('aria-hidden') !== 'true';
}
function failure(current: TestView, code: string): void {
  clearTimeout(current.pendingTimer); current.pending = false;
  current.error = shortVoiceError({ code, data: { phase: 'validation' } });
  epoch++; syncVoiceConnectionTest(current.container); announce(current, current.error);
}
async function prepare(current: TestView): Promise<void> {
  const sequence = ++current.sequence;
  current.announced = undefined; current.test.invalidate(); current.pending = true; current.error = undefined;
  epoch++; syncVoiceConnectionTest(current.container);
  clearTimeout(current.pendingTimer);
  current.pendingTimer = setTimeout(() => {
    if (!isCurrent(current, sequence)) return;
    current.sequence++; failure(current, 'SPEECH_TIMEOUT');
  }, 10_000);
  let snapshot: ReturnType<typeof readDraft> | undefined;
  let draft: ReturnType<typeof readDraft> | undefined;
  try {
    await current.nativeInvalidation;
    const first = await nativeSpeech.configuration();
    if (!isCurrent(current, sequence)) return;
    if (!first.supported) { failure(current, 'SPEECH_UNSUPPORTED'); return; }
    snapshot = readDraft(current); const configurationId = current.configurationId;
    if (snapshot.keySource === 'shared' ? !first.hasMainKey : !snapshot.value && (!first.hasKey || first.keySource === 'shared')) { failure(current, 'SPEECH_KEY_REQUIRED'); return; }
    const readiness = await nativeSpeech.configuration();
    if (!isCurrent(current, sequence)) return;
    if (readiness.credentialRevision !== first.credentialRevision || readiness.mainCredentialRevision !== first.mainCredentialRevision) { failure(current, 'SPEECH_KEY_CHANGED'); return; }
    draft = readDraft(current);
    if (current.configurationId !== configurationId || draft.keySource !== snapshot.keySource || draft.value !== snapshot.value || draft.config.region !== snapshot.config.region
      || draft.config.workspace !== snapshot.config.workspace || draft.config.model !== snapshot.config.model) { failure(current, 'SPEECH_CONFIG_INVALID'); return; }
    clearTimeout(current.pendingTimer); current.pending = false; epoch++;
    // The single test-button click is the explicit authority. Local checks never create a request on their own.
    void current.test.start(draft.config, readiness, { keySource: draft.keySource, value: draft.value || undefined, configurationId });
  } catch { if (isCurrent(current, sequence)) failure(current, 'SPEECH_CONFIG_INVALID'); }
  finally { if (snapshot) snapshot.value = ''; if (draft) draft.value = ''; }
}
export function handleVoiceConnectionTestClick(target: HTMLElement, container: HTMLElement): boolean {
  const button = target.closest<HTMLButtonElement>('[data-voice-test]');
  if (!button) return false;
  const current = view;
  if (!current || current.container !== container || current.disposed || button.disabled) return true;
  if (current.pending || current.test.busy) {
    invalidateVoiceConnectionTest(); showToast('测试已取消');
  } else if (!credentialWritePending && !isAiKeyWritePending()) void prepare(current);
  return true;
}
