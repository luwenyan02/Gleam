import { iconHtml } from '../../assets/icons';
import { on } from '../../core/store';
import { BailianVoiceSession, type ShortVoiceState } from '../../core/bailianVoiceSession';
import { getBailianVoiceConfig, validateBailianVoiceConfig } from '../../core/bailianVoiceConfig';
import { nativeSpeech } from '../../core/nativeSpeech';
import { prepareVoiceRecognition, approveVoiceRecognition, recognizeVoiceDraft, revokeVoicePreview,
  type AiParsedBill } from '../../core/repo/aiRepo';
import { manageOverlay } from '../../shared/overlay';
import { entryKeyFeedback } from './entryKeyFeedback';
import './holdVoice.css';

type Zone = 'send' | 'cancel' | 'edit';
type Options = { container: HTMLElement; onBill(bill: AiParsedBill, beforeOpen: () => boolean): Promise<void> };
type Pointer = { pointerId: number; clientX: number; clientY: number };

/** 普通点击仍交给现有记账入口；仅有效长按消费其后合成的 click。 */
export function bindHomeVoice(button: HTMLElement, options: Options): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let down: Pointer | undefined;
  let consumed = false;
  const clear = () => { clearTimeout(timer); timer = undefined; down = undefined; };
  button.style.touchAction = 'none';
  button.addEventListener('contextmenu', event => event.preventDefault());
  button.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0) return;
    clear(); consumed = false; down = event;
    timer = setTimeout(() => {
      if (!down || !button.isConnected || button.hidden || button.closest('[inert]')) return;
      consumed = true;
      const pointer = down; clear();
      openHoldVoice(options, pointer);
    }, 450);
  });
  window.addEventListener('pointermove', event => {
    if (down && event.pointerId === down.pointerId
      && Math.hypot(event.clientX - down.clientX, event.clientY - down.clientY) > 12) clear();
  });
  window.addEventListener('pointerup', clear);
  window.addEventListener('pointercancel', clear);
  window.addEventListener('pagehide', clear);
  document.addEventListener('visibilitychange', () => { if (document.hidden) clear(); });
  on('route-changed', clear);
  button.addEventListener('click', event => {
    if (consumed) { consumed = false; event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
}

/** 同一蒙层承载录音、文字修正和重录；发送区松手即本次文字识别授权。 */
function openHoldVoice(options: Options, initial: Pointer): void {
  const root = document.createElement('div');
  root.className = 'hold-voice-mask'; root.setAttribute('aria-label', '语音记账');
  const arc = '<svg class="hold-voice-arc" viewBox="0 0 200 92" preserveAspectRatio="none" aria-hidden="true"><path d="M29 21 Q89 4 161 4 C185 4 198 20 198 42 C198 64 184 75 162 76 Q96 76 37 90 C14 95 2 80 2 58 C2 39 9 27 29 21Z"/></svg>';
  root.innerHTML = `<div class="hold-voice-stage">
    <section class="hold-voice-capture" data-hv-capture>
      <div class="hold-voice-bubble"><div class="hold-voice-wave" data-hv-wave aria-hidden="true">${'<i></i>'.repeat(17)}</div><p data-hv-transcript></p></div>
      <p class="hold-voice-status" data-hv-status role="status" aria-live="polite"></p>
      <div class="hold-voice-bottom"><div class="hold-voice-choices">
        <button data-hv-zone="cancel">${arc}<span>${iconHtml('ic-close', 22)}取消</span></button>
        <button data-hv-zone="edit">${arc}<span>${iconHtml('ic-pen', 22)}编辑文字</span></button>
      </div><div class="hold-voice-send-area"><button class="hold-voice-send" data-hv-hold aria-label="按住说话">${iconHtml('ic-mic', 24)}<span data-hv-cue>松开发送</span></button>
      <p class="hold-voice-tip" data-hv-tip>上滑取消或编辑，移回下方继续说话</p></div></div>
    </section>
    <section class="hold-voice-editor" data-hv-editor hidden>
      <header class="hold-voice-editor-heading"><h3>短语音记账</h3><button class="hold-voice-exit" data-hv-close aria-label="退出短语音记账">退出</button></header>
      <p data-hv-message role="status"></p>
      <textarea data-hv-text rows="4" maxlength="500" aria-label="编辑语音文字" placeholder="说了什么、花了多少钱？"></textarea>
      <div><button class="btn ghost" data-hv-rerecord>重新录音</button><button class="btn primary" data-hv-send>发送并生成草稿</button></div>
    </section>
  </div>`;
  document.body.appendChild(root);
  const q = <T extends HTMLElement>(s: string) => root.querySelector<T>(`[data-hv-${s}]`)!;
  const input = q<HTMLTextAreaElement>('text');
  let closed = false, revision = 0, phase: 'capture' | 'ready' | 'editor' | 'processing' = 'capture';
  let state: ShortVoiceState = 'idle', pointer: number | undefined = initial.pointerId;
  let zone: Zone = 'send', intent: Zone | undefined;
  let partial = '', finalText = '', startedAt = 0, recordingRevision = 0;
  let controller: AbortController | undefined;
  const status = (s: string) => { q('status').textContent = s; };
  const drawText = () => {
    q('transcript').textContent = finalText || partial;
    q('wave').hidden = !!(finalText || partial);
    const bubble = q('transcript').parentElement!;
    bubble.scrollTop = bubble.scrollHeight;
  };
  function editor(text: string, message = ''): void {
    if (closed) return;
    phase = 'editor'; pointer = undefined; intent = undefined;
    q('capture').hidden = true; q('editor').hidden = false;
    input.value = text; q('message').textContent = message;
    input.disabled = false; q<HTMLButtonElement>('send').disabled = !text.trim();
    q<HTMLButtonElement>('rerecord').disabled = false;
    input.focus({ preventScroll: true });
  }
  const session = new BailianVoiceSession(nativeSpeech, {
    onState(value) {
      state = value; root.dataset.state = value;
      if (value === 'listening') startedAt = Date.now();
      if (value === 'connecting') status('正在连接语音…');
      if (value === 'listening') status('正在听 · 最长30秒');
      if (value === 'transcribing') status('正在确认文字…');
    },
    onPartial(text) { if (!closed) { partial = text; drawText(); } },
    onText(text) {
      if (closed) return;
      finalText = text; drawText();
      if (pointer === undefined) settle();
    },
    onError(message) {
      if (closed) return;
      if (message.includes('SPEECH_AUDIO_EMPTY') && !partial.trim() && intent === 'send') { close(); return; }
      editor(partial, message.includes('SPEECH_LIMIT') ? '录音已达30秒，请重新录音或编辑文字' :
        message.includes('SPEECH_PERMISSION') ? '请允许麦克风权限后重新录音' : '语音未完成，请重新录音或输入文字');
    },
  });
  function close(): void {
    if (closed) return;
    closed = true; revision++; recordingRevision++; pointer = undefined;
    controller?.abort(); session.dispose(); clearInterval(ticker); offSettings(); offRoute();
    document.removeEventListener('visibilitychange', visibility); window.removeEventListener('pagehide', close);
    window.removeEventListener('pointermove', move, true); window.removeEventListener('pointerup', up, true);
    window.removeEventListener('pointercancel', cancelPointer, true);
    release(); root.remove();
  }
  const release = manageOverlay(root, close);
  const visibility = () => { if (document.hidden) close(); };
  document.addEventListener('visibilitychange', visibility); window.addEventListener('pagehide', close);
  const offSettings = on('settings-changed', close);
  const offRoute = on('route-changed', close);
  const ticker = setInterval(() => {
    if (!closed && state === 'listening' && phase === 'capture') status(`${Math.min(30, Math.floor((Date.now() - startedAt) / 1000))}秒 · 正在听`);
    if (!options.container.isConnected) close();
  }, 500);

  function pickZone(event: Pointer): Zone {
    for (const value of ['cancel', 'edit'] as const) {
      const b = root.querySelector<HTMLElement>(`[data-hv-zone="${value}"]`)!.getBoundingClientRect();
      if (event.clientX >= b.left && event.clientX <= b.right && event.clientY >= b.top && event.clientY <= b.bottom) return value;
    }
    const bounds = q('capture').getBoundingClientRect();
    return event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < 0 || event.clientY > innerHeight ? 'cancel' : 'send';
  }
  function select(value: Zone): void {
    if (zone !== value) void entryKeyFeedback();
    zone = value; root.dataset.zone = zone;
    for (const button of root.querySelectorAll<HTMLElement>('[data-hv-zone]')) {
      const selected = button.dataset.hvZone === value;
      button.classList.toggle('selected', selected); button.setAttribute('aria-pressed', String(selected));
    }
    q('cue').textContent = value === 'cancel' ? '松开取消' : value === 'edit' ? '松开编辑文字' : '松开发送';
  }
  function move(event: PointerEvent): void {
    if (event.pointerId !== pointer) return;
    event.preventDefault(); select(pickZone(event));
  }
  function up(event: PointerEvent): void {
    if (event.pointerId !== pointer) return;
    event.preventDefault(); intent = pickZone(event); pointer = undefined;
    if (intent === 'cancel') { close(); return; }
    if (intent === 'edit') {
      // 编辑只接管此刻可见文字；取消原生会话，避免迟到结果覆盖用户输入。
      editCurrent(); return;
    }
    if (finalText) { settle(); return; }
    if (state === 'listening') void session.stop();
    else if (state !== 'transcribing') { session.cancel(); close(); }
  }
  function cancelPointer(event: PointerEvent): void { if (event.pointerId === pointer) close(); }
  window.addEventListener('pointermove', move, { capture: true, passive: false });
  window.addEventListener('pointerup', up, true); window.addEventListener('pointercancel', cancelPointer, true);
  function settle(): void {
    if (!finalText.trim()) { close(); return; }
    if (intent === 'send') void send(finalText);
  }
  async function begin(): Promise<void> {
    const token = ++recordingRevision;
    void entryKeyFeedback();
    root.dataset.state = 'preparing'; status('正在准备语音…');
    try {
      const readiness = await nativeSpeech.configuration();
      if (closed || token !== recordingRevision || pointer === undefined) return;
      if (!readiness.supported || !readiness.hasKey) {
        editor('', readiness.supported ? '请先在设置中完成百炼短语音配置' : '语音仅支持 Android 安装包，也可以输入文字'); return;
      }
      const config = readiness.activeConfig ? validateBailianVoiceConfig(readiness.activeConfig) : await getBailianVoiceConfig();
      if (closed || token !== recordingRevision || pointer === undefined) return;
      void session.start(config, readiness);
    } catch { if (!closed && token === recordingRevision) editor('', '请先在设置中完成百炼短语音配置'); }
  }
  async function send(text: string): Promise<void> {
    if (closed || phase === 'processing' || !text.trim()) return;
    const token = ++revision; phase = 'processing'; input.disabled = true;
    q<HTMLButtonElement>('hold').disabled = true; q('cue').textContent = '正在识别…';
    q<HTMLButtonElement>('send').disabled = true; q<HTMLButtonElement>('rerecord').disabled = true;
    status('正在识别这笔账单…'); q('message').textContent = '正在识别这笔账单…';
    controller = new AbortController();
    let openingDraft = false;
    try {
      const preview = await prepareVoiceRecognition(text);
      if (closed || token !== revision) { revokeVoicePreview(preview); return; }
      const bill = await recognizeVoiceDraft(approveVoiceRecognition(preview), controller.signal);
      if (closed || token !== revision) return;
      openingDraft = true; status('正在打开草稿…'); q('message').textContent = '正在打开草稿…';
      q('cue').textContent = '正在打开草稿…';
      await options.onBill(bill, () => {
        if (closed || token !== revision) return false;
        close(); return true;
      });
    } catch (error) {
      if (closed || token !== revision) return;
      const message = error instanceof Error ? error.message : '';
      editor(text, openingDraft ? '草稿未打开，文字已保留，请重试' : /单笔|一笔|金额|修改文字|支出或收入/.test(message) ? '未识别到明确的收支，请补充用途和金额' :
        /转账|借贷|退款|报销|还款/.test(message) ? '这类账务请使用手动记账' : '识别未完成，请检查 AI 设置或网络后重试');
    } finally { if (!closed && token === revision) controller = undefined; }
  }
  function editCurrent(): void {
    revision++; recordingRevision++; controller?.abort(); session.cancel();
    editor(finalText || partial);
  }
  q('close').addEventListener('click', close);
  root.addEventListener('contextmenu', event => { if (phase !== 'editor') event.preventDefault(); });
  root.querySelector('[data-hv-zone="cancel"]')!.addEventListener('click', () => { if (pointer === undefined) close(); });
  root.querySelector('[data-hv-zone="edit"]')!.addEventListener('click', () => {
    if (pointer === undefined && phase !== 'editor') editCurrent();
  });
  q('rerecord').addEventListener('click', () => {
    if (phase !== 'editor') return;
    revision++; recordingRevision++; controller?.abort(); session.cancel();
    input.value = ''; finalText = ''; partial = ''; intent = undefined; startedAt = 0;
    phase = 'ready'; q('editor').hidden = true; q('capture').hidden = false;
    q<HTMLButtonElement>('hold').disabled = false; select('send');
    drawText(); status('按住下方按钮说话'); q('cue').textContent = '按住说话';
    q('hold').focus({ preventScroll: true });
  });
  q('hold').addEventListener('pointerdown', event => {
    if (phase !== 'ready' || !event.isPrimary || event.button !== 0) return;
    pointer = event.pointerId; phase = 'capture'; select('send'); void begin();
  });
  // 键盘用户可在重录待机状态打开文字编辑，避免必须使用拖动。
  q('hold').addEventListener('click', event => { if (event.detail === 0 && phase === 'ready') editor(''); });
  input.addEventListener('input', () => { q<HTMLButtonElement>('send').disabled = !input.value.trim(); q('message').textContent = ''; });
  q('send').addEventListener('click', () => { if (phase === 'editor') void send(input.value); });
  select('send'); void begin();
}
