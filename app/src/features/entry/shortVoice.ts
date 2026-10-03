import { esc } from '../../core/esc';
import { formatFen } from '../../core/money';
import { on } from '../../core/store';
import { BailianVoiceSession } from '../../core/bailianVoiceSession';
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
      <p class="short-voice-consent" data-sv-consent>正在核对百炼语音设置…</p>
      <div class="short-voice-actions"><button class="btn primary" data-sv-start disabled>同意并开始说话</button><button class="btn ghost" data-sv-stop hidden>说完了</button><button class="btn ghost" data-sv-cancel hidden>取消录音</button></div>
      <p class="short-voice-status" data-sv-status role="status" aria-live="polite">可录一句，也可直接填写文字</p>
      <label class="short-voice-label">核对文字<textarea data-sv-text rows="3" maxlength="500" aria-label="核对语音文字" placeholder="如：今天午餐28元，现金"></textarea></label>
      <button class="btn ghost" data-sv-preview>预览 AI 识别</button>
      <section class="short-voice-send" data-sv-send-panel hidden>
        <h4>本次发送给文字 AI</h4><p data-sv-destination></p><p class="short-voice-quote" data-sv-send-text></p>
        <details><summary>候选分类与账户名称</summary><p data-sv-candidates></p></details>
        <p class="tiny">只发送以上文字、候选名称及识别规则；不发送声音、旧账单、余额、照片或生活记录。可能产生模型费用。</p>
        <button class="btn primary" data-sv-send>同意发送并生成草稿</button>
      </section>
      <section class="short-voice-result" data-sv-result hidden><h4>核对这笔草稿</h4><dl data-sv-fields></dl><p class="tiny">${esc(options.applyNote)}</p><button class="btn primary" data-sv-apply>${esc(options.applyLabel)}</button></section>
      <p class="tiny">先支持一笔普通支出或收入。转账、借贷、还款、退款和报销请用手动记账。</p>
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
  let recording = false;
  const status = (message: string) => { if (!closed) q('[data-sv-status]').textContent = message; };
  const invalidateDraft = () => {
    revision++;
    if (preview) revokeVoicePreview(preview);
    preview = undefined; bill = undefined; controller?.abort(); controller = undefined; aiBusy = false;
    q('[data-sv-send-panel]').hidden = true; q('[data-sv-result]').hidden = true;
  };
  const controls = () => {
    if (closed) return;
    start.hidden = recording;
    start.disabled = aiBusy || applying || !readiness?.supported || !readiness.hasKey || !config;
    q<HTMLButtonElement>('[data-sv-stop]').hidden = !recording;
    q<HTMLButtonElement>('[data-sv-cancel]').hidden = !recording && !aiBusy;
    q<HTMLButtonElement>('[data-sv-cancel]').textContent = recording ? '取消录音' : '取消识别';
    input.disabled = recording || aiBusy || applying;
    q<HTMLButtonElement>('[data-sv-preview]').disabled = recording || aiBusy || applying;
    q<HTMLButtonElement>('[data-sv-send]').disabled = recording || aiBusy || applying || !preview;
    q<HTMLButtonElement>('[data-sv-apply]').disabled = recording || aiBusy || applying || !bill;
  };
  const session = new BailianVoiceSession(nativeSpeech, {
    onState(state) {
      recording = state !== 'idle'; controls();
      const labels = { connecting: '正在连接百炼，请等待麦克风授权', listening: '正在听，最长30秒；说完后点「说完了」', transcribing: '麦克风已停止，正在转写…', idle: '' };
      if (labels[state]) status(labels[state]);
    },
    onText(text) { if (closed) return; invalidateDraft(); input.value = text; controls(); status('请先核对文字，再预览 AI 识别'); },
    onError: status,
  });
  const interrupt = () => {
    if (session.busy) session.cancel('已停止语音；回到页面后可重新开始');
    if (aiBusy) { invalidateDraft(); controls(); status('本次识别已取消，文字保留，可重新预览'); }
  };
  const visibility = () => { if (document.hidden) interrupt(); };
  const pagehide = () => interrupt();
  document.addEventListener('visibilitychange', visibility); window.addEventListener('pagehide', pagehide);
  const off = on('settings-changed', () => {
    if (!closed && (session.busy || aiBusy)) {
      session.cancel('设置已变化，请重新核对后开始'); invalidateDraft(); controls();
    }
    void loadConfiguration();
  });
  function close(): void {
    if (closed || applying) return;
    closed = true; revision++; configRevision++; controller?.abort();
    if (preview) revokeVoicePreview(preview);
    session.dispose(); observer.disconnect(); off(); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('pagehide', pagehide);
    release(); root.remove();
  }
  const release = manageOverlay(root, close);
  const observer = new MutationObserver(() => { if (!options.container.isConnected) { applying = false; close(); } });
  observer.observe(document.body, { childList: true, subtree: true });
  root.addEventListener('click', event => { if (event.target === root) close(); });
  q('[data-sv-close]').addEventListener('click', close);
  input.addEventListener('input', () => { invalidateDraft(); controls(); });
  start.addEventListener('click', () => {
    if (closed || start.disabled || session.busy || !config || !readiness) return;
    invalidateDraft(); controls(); void session.start(config, readiness);
  });
  q('[data-sv-stop]').addEventListener('click', () => { void session.stop(); });
  q('[data-sv-cancel]').addEventListener('click', () => {
    if (session.busy) session.cancel('录音已取消，可重试或手动填写文字');
    else if (aiBusy) { invalidateDraft(); controls(); status('本次识别已取消，文字保留，可重新预览'); }
  });
  q('[data-sv-preview]').addEventListener('click', () => {
    if (closed || aiBusy || recording || applying) return;
    invalidateDraft(); const token = revision; aiBusy = true; controls(); status('正在准备本机发送预览…');
    void prepareVoiceRecognition(input.value).then(result => {
      if (closed || token !== revision) { revokeVoicePreview(result); return; }
      preview = result;
      q('[data-sv-destination]').textContent = `${result.destination.baseUrl} · ${result.destination.model}`;
      q('[data-sv-send-text]').textContent = result.text;
      q('[data-sv-candidates]').textContent = `分类：${result.categoryNames.join('、') || '无'}\n账户：${result.accountNames.join('、') || '无'}`;
      q('[data-sv-send-panel]').hidden = false; status('核对接收方与文字，同意后才发送');
    }).catch(error => { if (!closed && token === revision) status(error instanceof Error ? error.message : '预览失败，请重试'); })
      .finally(() => { if (!closed && token === revision) { aiBusy = false; controls(); } });
  });
  q('[data-sv-send]').addEventListener('click', () => {
    if (closed || aiBusy || recording || applying || !preview) return;
    if (input.value.trim() !== preview.text) { invalidateDraft(); controls(); status('文字已变化，请重新预览'); return; }
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
    }).catch(error => { if (!closed && token === revision) { q('[data-sv-send-panel]').hidden = true; status(error instanceof Error ? error.message : '识别失败，请重新预览'); } })
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
      readiness = native;
      try { config = await getBailianVoiceConfig(); } catch { config = undefined; }
      if (closed || token !== configRevision) return;
      const recipient = config ? `阿里云百炼（${config.region === 'beijing' ? '北京' : '新加坡'}，${config.model}，${bailianVoiceDestination(config)}）` : '阿里云百炼';
      q('[data-sv-consent]').textContent = `开始后本次麦克风声音将发送给${recipient}，可能产生模型费用；最长30秒，不在拾光保存录音，不发送旧账单、照片或历史聊天。`;
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
