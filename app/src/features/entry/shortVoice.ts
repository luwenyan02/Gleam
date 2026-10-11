import { esc } from '../../core/esc';
import { formatFen } from '../../core/money';
import { on } from '../../core/store';
import { BailianVoiceSession, type ShortVoiceState } from '../../core/bailianVoiceSession';
import { iconHtml } from '../../assets/icons';
import { getBailianVoiceConfig, bailianVoiceDestination, type BailianVoiceConfig } from '../../core/bailianVoiceConfig';
import { nativeSpeech, type NativeSpeechConfiguration } from '../../core/nativeSpeech';
import {
  prepareVoiceRecognition, approveVoiceRecognition, recognizeVoiceDraft, revokeVoicePreview,
  type AiParsedBill, type VoiceRecognitionPreview,
} from '../../core/repo/aiRepo';
import { manageOverlay } from '../../shared/overlay';
import './shortVoice.css';

interface ShortVoiceOptions {
  container: HTMLElement;
  applyLabel: string;
  applyNote: string;
  onApply(bill: AiParsedBill, text: string): Promise<void> | void;
}

/** 独立浮层保留下层账单；转写和文字 AI 各有明确同意，不自动写账本。 */
export function openShortVoice(options: ShortVoiceOptions): () => void {
  const root = document.createElement('div'); root.className = 'short-voice-mask';
  root.setAttribute('aria-label', '短语音记账');
  root.innerHTML = `<section class="short-voice-panel">
    <header class="sheet-head"><h3>短语音记账</h3><button class="icon-btn" data-sv-close aria-label="关闭短语音">×</button></header>
    <div class="short-voice-content">
      <div data-sv-voice-prompt>
        <div class="short-voice-consent" data-sv-consent>正在核对语音设置…</div>
        <button class="btn primary short-voice-start" data-sv-start disabled>${iconHtml('ic-mic', 20)} 同意并开始说话</button>
      </div>
      <div class="short-voice-activity" data-sv-activity data-state="idle" aria-hidden="true" hidden>
        <div class="short-voice-orb">${iconHtml('ic-mic', 32)}<span class="short-voice-ring"></span></div>
        <div class="short-voice-bars"><i></i><i></i><i></i><i></i><i></i></div>
      </div>
      <p class="short-voice-status" data-sv-status role="status" aria-live="polite"></p>
      <div class="short-voice-actions"><button class="btn primary" data-sv-stop hidden>说完了</button><button class="btn ghost" data-sv-cancel hidden>取消</button></div>
      <div data-sv-editor tabindex="-1">
        <div class="short-voice-editor-head"><label for="short-voice-text">核对文字</label><button class="btn ghost" data-sv-rerecord hidden>重新录音</button></div>
        <textarea id="short-voice-text" data-sv-text rows="2" maxlength="500" aria-label="核对语音文字" placeholder="或直接输入：午餐28元，现金"></textarea>
      </div>
      <button class="btn ghost" data-sv-preview hidden>重新准备识别</button>
      <section class="short-voice-send" data-sv-send-panel hidden>
        <p class="short-voice-ai-consent">将以上文字与候选名称交给文字 AI，可能产生费用。</p><p data-sv-destination></p>
        <details><summary tabindex="0">发送内容详情</summary><p data-sv-candidates></p><p>仅包含以上文字、候选分类与账户名称及识别规则。</p></details>
        <button class="btn primary" data-sv-send>同意发送并生成草稿</button>
      </section>
      <section class="short-voice-result" data-sv-result hidden><h4>核对这笔草稿</h4><dl data-sv-fields></dl><p class="tiny">${esc(options.applyNote)}</p><button class="btn primary" data-sv-apply>${esc(options.applyLabel)}</button></section>
      <details class="short-voice-help"><summary tabindex="0">使用说明</summary><p>每次说一笔支出或收入，最长30秒。转账、借贷、还款、退款和报销请手动记账。拾光不保存录音；生成草稿后仍需核对并保存。</p></details>
    </div></section>`;
  document.body.appendChild(root);
  const q = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  const input = q<HTMLTextAreaElement>('[data-sv-text]');
  const start = q<HTMLButtonElement>('[data-sv-start]');
  let closed = false, revision = 0, configRevision = 0, aiBusy = false, applying = false;
  let config: BailianVoiceConfig | undefined;
  let readiness: NativeSpeechConfiguration | undefined;
  let preview: VoiceRecognitionPreview | undefined;
  let bill: AiParsedBill | undefined;
  let billText = '';
  let controller: AbortController | undefined;
  let recording = false, voiceState: ShortVoiceState = 'idle', voicePrompt = true;
  let previewTimer: ReturnType<typeof setTimeout> | undefined, preparing = false, previewError = false, composing = false;
  const status = (message: string) => { if (!closed) q('[data-sv-status]').textContent = message; };
  const invalidateDraft = () => {
    clearTimeout(previewTimer); previewTimer = undefined; preparing = false; previewError = false;
    revision++;
    if (preview) revokeVoicePreview(preview);
    preview = undefined; bill = undefined; controller?.abort(); controller = undefined; aiBusy = false;
    q('[data-sv-send-panel]').hidden = true; q('[data-sv-result]').hidden = true;
  };
  const controls = () => {
    if (closed) return;
    q('[data-sv-voice-prompt]').hidden = recording || (!voicePrompt && !!input.value.trim());
    start.disabled = aiBusy || applying || !readiness?.supported || !readiness.hasKey || !config;
    const activity = q('[data-sv-activity]'); activity.hidden = !recording; activity.dataset.state = voiceState;
    q<HTMLButtonElement>('[data-sv-stop]').hidden = voiceState !== 'listening';
    q<HTMLButtonElement>('[data-sv-cancel]').hidden = !recording && !aiBusy;
    q<HTMLButtonElement>('[data-sv-cancel]').textContent = recording ? '取消' : '取消识别';
    q('[data-sv-editor]').hidden = recording;
    q<HTMLButtonElement>('[data-sv-rerecord]').hidden = !input.value.trim() || voicePrompt;
    q<HTMLButtonElement>('[data-sv-rerecord]').disabled = aiBusy || applying;
    input.disabled = recording || aiBusy || applying;
    q<HTMLButtonElement>('[data-sv-preview]').hidden = !previewError || recording;
    q<HTMLButtonElement>('[data-sv-preview]').disabled = recording || aiBusy || applying || preparing;
    q<HTMLButtonElement>('[data-sv-send]').disabled = recording || aiBusy || applying || preparing || !preview;
    q<HTMLButtonElement>('[data-sv-apply]').disabled = recording || aiBusy || applying || !bill;
  };
  const session = new BailianVoiceSession(nativeSpeech, {
    onState(state) {
      voiceState = state; recording = state !== 'idle'; controls();
      const labels = { connecting: '正在准备语音，请稍候…', listening: '正在听 · 最长30秒', transcribing: '录音已停止，正在转写…', idle: '' };
      if (labels[state]) status(labels[state]);
      if (state === 'connecting' || state === 'transcribing') q('[data-sv-cancel]').focus({ preventScroll: true });
    },
    onText(text) { if (closed) return; input.value = text; voicePrompt = false; preparePreview(); q('[data-sv-editor]').focus({ preventScroll: true }); },
    onError(message) {
      if (closed) return;
      previewError = !!input.value.trim(); controls(); status(message);
      (previewError ? q('[data-sv-preview]') : start).focus({ preventScroll: true });
    },
  });
  const interrupt = () => {
    if (session.busy) session.cancel('已停止语音；回到页面后可重新开始');
    if (aiBusy || preparing || previewTimer !== undefined) { invalidateDraft(); previewError = !!input.value.trim(); controls(); status('已取消，文字已保留'); }
  };
  const visibility = () => { if (document.hidden) interrupt(); };
  const pagehide = () => interrupt();
  document.addEventListener('visibilitychange', visibility); window.addEventListener('pagehide', pagehide);
  const off = on('settings-changed', () => {
    if (closed) return;
    if (session.busy) session.cancel('设置已变化，请重新核对后开始');
    // Revoke even an idle, displayed consent snapshot before configuration can change.
    invalidateDraft(); readiness = undefined; config = undefined; previewError = !!input.value.trim(); controls();
    if (input.value.trim()) status('设置已变化，请重新准备识别');
    void loadConfiguration();
  });
  function close(): void {
    if (closed || applying) return;
    closed = true; revision++; configRevision++; clearTimeout(previewTimer); controller?.abort();
    if (preview) revokeVoicePreview(preview);
    session.dispose(); observer.disconnect(); off(); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('pagehide', pagehide);
    release(); root.remove();
  }
  const release = manageOverlay(root, close);
  const observer = new MutationObserver(() => { if (!options.container.isConnected) { applying = false; close(); } });
  observer.observe(document.body, { childList: true, subtree: true });
  root.addEventListener('click', event => { if (event.target === root) close(); });
  q('[data-sv-close]').addEventListener('click', close);
  const edited = () => {
    invalidateDraft(); voicePrompt = !input.value.trim(); controls(); status('');
    if (!composing && input.value.trim()) previewTimer = setTimeout(preparePreview, 250);
  };
  input.addEventListener('input', edited);
  input.addEventListener('compositionstart', () => { composing = true; invalidateDraft(); controls(); });
  input.addEventListener('compositionend', () => { composing = false; edited(); });
  q('[data-sv-rerecord]').addEventListener('click', () => {
    if (closed || recording || aiBusy || applying) return;
    voicePrompt = true; controls(); start.focus({ preventScroll: true });
  });
  start.addEventListener('click', () => {
    if (closed || start.disabled || session.busy || !config || !readiness) return;
    invalidateDraft(); controls(); void session.start(config, readiness);
  });
  q('[data-sv-stop]').addEventListener('click', () => { void session.stop(); });
  q('[data-sv-cancel]').addEventListener('click', () => {
    if (session.busy) session.cancel('录音已取消，可重试或手动填写文字');
    else if (aiBusy) { invalidateDraft(); previewError = true; controls(); status('已取消，文字已保留'); }
  });
  function preparePreview(): void {
    if (closed || aiBusy || recording || applying || composing) return;
    invalidateDraft();
    if (!input.value.trim()) { controls(); return; }
    const token = revision; preparing = true; controls(); status('正在准备识别…');
    void prepareVoiceRecognition(input.value).then(result => {
      if (closed || token !== revision) { revokeVoicePreview(result); return; }
      preview = result;
      q('[data-sv-destination]').textContent = `${result.destination.baseUrl} · ${result.destination.model}`;
      q('[data-sv-candidates]').textContent = `分类：${result.categoryNames.join('、') || '无'}\n账户：${result.accountNames.join('、') || '无'}`;
      q('[data-sv-send-panel]').hidden = false; status('核对文字后生成草稿');
    }).catch(error => { if (!closed && token === revision) { previewError = true; status(error instanceof Error ? error.message : '准备失败，请重试'); } })
      .finally(() => { if (!closed && token === revision) { preparing = false; controls(); } });
  }
  q('[data-sv-preview]').addEventListener('click', preparePreview);
  q('[data-sv-send]').addEventListener('click', () => {
    if (closed || aiBusy || recording || applying || !preview) return;
    if (input.value.trim() !== preview.text) { preparePreview(); return; }
    const token = revision, text = preview.text;
    const grant = approveVoiceRecognition(preview); preview = undefined; aiBusy = true;
    controller = new AbortController(); controls(); status('正在生成单笔草稿…');
    void recognizeVoiceDraft(grant, controller.signal).then(result => {
      if (closed || token !== revision) return;
      bill = result; billText = text;
      q('[data-sv-send-panel]').hidden = true;
      const date = new Date(result.occurredAt);
      const fields = [['类型', result.type === 'income' ? '收入' : '支出'], ['金额', `¥${formatFen(result.amount)}`],
        ['分类', result.categoryName || '未识别，请手选'], ['账户', result.accountName || '未识别，请手选'],
        ['时间', date.toLocaleString('zh-CN', { hour12: false })], ['备注', result.note || '无']];
      q('[data-sv-fields]').innerHTML = fields.map(([label, value]) => `<div><dt>${label}</dt><dd>${esc(value)}</dd></div>`).join('');
      q('[data-sv-result]').hidden = false; status('识别完成，尚未入账');
    }).catch(error => { if (!closed && token === revision) { previewError = true; q('[data-sv-send-panel]').hidden = true; status(error instanceof Error ? error.message : '识别失败，请重试'); } })
      .finally(() => { if (!closed && token === revision) { aiBusy = false; controller = undefined; controls(); } });
  });
  q('[data-sv-apply]').addEventListener('click', () => {
    if (closed || applying || aiBusy || recording || !bill) return;
    const selectedBill = bill, selectedText = billText;
    applying = true; controls();
    void Promise.resolve().then(() => options.onApply(selectedBill, selectedText)).then(() => { applying = false; close(); })
      .catch(() => { applying = false; controls(); status('草稿未应用，请重试'); });
  });

  async function loadConfiguration(): Promise<void> {
    const token = ++configRevision;
    try {
      const native = await nativeSpeech.configuration();
      if (closed || token !== configRevision) return;
      let loadedConfig: BailianVoiceConfig | undefined;
      try { loadedConfig = await getBailianVoiceConfig(); } catch { loadedConfig = undefined; }
      if (closed || token !== configRevision) return;
      readiness = native; config = loadedConfig;
      const recipient = config ? `阿里云百炼（${config.region === 'beijing' ? '北京' : '新加坡'}）` : '阿里云百炼';
      q('[data-sv-consent]').innerHTML = `<p>本次声音将发送给${recipient}，可能产生费用。</p><details><summary tabindex="0">语音服务详情</summary><p>${config ? `${esc(config.model)}<br>${esc(bailianVoiceDestination(config))}<br>` : ''}最长30秒；拾光不保存录音。</p></details>`;
      if (!native.supported) status('百炼短语音仅支持 Android 安装包；这里可手动输入文字');
      else if (!native.hasKey || !config) status('请先在「我的 → 设置 → 百炼短语音」保存独立 Key、地域与业务空间');
      controls();
    } catch {
      if (!closed && token === configRevision) { readiness = undefined; config = undefined; controls(); status('语音设置暂不可用，可手动输入文字'); }
    }
  }
  void loadConfiguration(); controls();
  return () => { applying = false; close(); };
}
