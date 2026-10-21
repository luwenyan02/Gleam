import type { VoiceTranscriptMessage, VoiceTextDestination, VoiceTranscriptMode } from '../../core/voiceTranscript';
import { getLifeAiDestination } from '../../core/repo/lifeAiRepo';
import { iconHtml } from '../../assets/icons';
import { RealtimeVoice, type VoiceState } from '../../core/realtimeVoice';
import { NativeLiveVoice, liveVoicePlugin, nativeLiveVoiceSupported } from '../../core/nativeLiveVoice';
import { getSetting, setSetting } from '../../core/repo/settingsRepo';
import { manageOverlay } from '../../shared/overlay';
import { openAiSettings } from '../settings/settings';
import { chatIcon } from './chatIcons';

/** Both transports share the small call UI; Android reads only the native tested configuration. */
export function openLifeVoice(options: { container: HTMLElement; onTranscript: (messages: VoiceTranscriptMessage[], destination?: VoiceTextDestination, mode?: VoiceTranscriptMode) => void; onClose: () => void }): () => void {
  const native = nativeLiveVoiceSupported();
  let voice: NativeLiveVoice | RealtimeVoice | undefined;
  let closed = false, starting = false, ready = false, settling = false;
  let transportDone = Promise.resolve();
  let startRevision = 0, finalRevision = -1;
  let reset = () => {};
  let workspace = '', region = 'beijing';
  let conversation: VoiceTranscriptMessage[] = [];
  let textDestination: VoiceTextDestination | undefined;
  const configController = new AbortController();
  const stop = () => {
    const revision = ++startRevision; starting = false;
    const current = voice; voice = undefined;
    if (current) transportDone = Promise.resolve(current.close());
    settling = true; reset();
    void transportDone.finally(() => { if (revision === startRevision) { settling = false; reset(); } });
    return transportDone;
  };
  const el = document.createElement('section');
  el.className = 'chat-voice-overlay'; el.setAttribute('role', 'group'); el.setAttribute('aria-label', '语音聊');
  el.dataset.voiceState = 'idle';
  const fields = options.container.querySelector<HTMLElement>('.chat-compose-fields')!;
  const previous = { inert: fields.inert, hidden: fields.getAttribute('aria-hidden') };
  let releaseOverlay = () => {};
  const close = () => {
    if (closed) return;
    finalRevision = startRevision; closed = true; configController.abort();
    const done = stop(); releaseOverlay(); el.remove();
    fields.inert = previous.inert;
    if (previous.hidden == null) fields.removeAttribute('aria-hidden'); else fields.setAttribute('aria-hidden', previous.hidden);
    // Keep the parent composer blocked until the final native transcript is settled.
    void done.then(options.onClose, options.onClose);
  };
  options.container.append(el);
  releaseOverlay = manageOverlay(el, close, { modal: false, opener: options.container.querySelector<HTMLElement>('[data-chat-voice]')! });
  fields.inert = true; fields.setAttribute('aria-hidden', 'true');
  el.innerHTML = `<div class="voice-inline-head"><div class="voice-identity" aria-hidden="true">${chatIcon('voice')}</div>
      <p class="voice-state" data-voice-status role="status">正在准备…</p>
      <button class="icon-btn" data-voice-close aria-label="关闭语音聊">${iconHtml('ic-close')}</button></div>
    <p class="voice-consent">声音发送至百炼</p>
    <div class="voice-inline-actions">
      <button class="btn primary" data-voice-start disabled>开始语音</button>
      <button class="btn ghost" data-voice-mute aria-label="麦克风静音" aria-pressed="false" hidden>静音</button>
      <button class="btn ghost" data-voice-interrupt aria-label="打断回复" hidden>打断</button>
      <button class="btn primary" data-voice-end hidden>结束语音</button>
      <button class="btn ghost" data-voice-settings hidden>前往 AI 设置</button>
      <button class="btn ghost" data-voice-play hidden>播放声音</button>
    </div>`;
  const start = el.querySelector<HTMLButtonElement>('[data-voice-start]')!;
  const end = el.querySelector<HTMLButtonElement>('[data-voice-end]')!;
  const mute = el.querySelector<HTMLButtonElement>('[data-voice-mute]')!;
  const settings = el.querySelector<HTMLButtonElement>('[data-voice-settings]')!;
  const play = el.querySelector<HTMLButtonElement>('[data-voice-play]')!;
  const state = (value: VoiceState) => { if (!closed) el.dataset.voiceState = value; };
  const status = (text: string) => {
    if (closed) return;
    el.querySelector('[data-voice-status]')!.textContent = text;
    play.hidden = native || !text.includes('播放声音');
  };
  const busy = (phase: 'connecting' | 'connected' | false) => {
    if (closed) return;
    el.dataset.voicePhase = phase || 'idle';
    start.hidden = !!phase || !ready; start.disabled = !!phase || !ready || settling;
    end.hidden = !phase; end.textContent = phase === 'connecting' ? '取消连接' : '结束语音';
    mute.hidden = phase !== 'connected';
    el.querySelector<HTMLElement>('[data-voice-interrupt]')!.hidden = phase !== 'connected';
    el.querySelector<HTMLElement>('.voice-consent')!.hidden = !!phase;
    settings.hidden = !native || !!phase || ready;
  };
  reset = () => busy(false);
  el.querySelector('[data-voice-close]')!.addEventListener('click', close);
  settings.onclick = () => { close(); openAiSettings(); };
  start.onclick = () => {
    if (voice || starting || settling || !ready || closed) return;
    const revision = ++startRevision;
    starting = true; busy('connecting'); status('正在连接…');
    state('connecting');
    mute.textContent = '静音'; mute.setAttribute('aria-label', '麦克风静音'); mute.setAttribute('aria-pressed', 'false');
    const previous = [...conversation];
    void (async () => {
      try {
        if (!await getSetting('life.aiEnabled')) await setSetting('life.aiEnabled', true);
        if (closed || revision !== startRevision) return;
        const callbacks = { onStatus: (text: string) => { if (revision === startRevision) status(text); },
          onState(value: VoiceState) {
            if (revision !== startRevision) return;
            state(value);
            if (value === 'listening' || value === 'speaking' || value === 'muted') busy('connected');
          },
          onTranscript(messages: VoiceTranscriptMessage[], mode?: VoiceTranscriptMode) {
            if (closed ? revision !== finalRevision : revision !== startRevision) return;
            const updates = messages.map(message => ({ ...message, ...(message.id ? { id: `${revision}:${message.id}` } : {}), ...(message.order != null ? { order: revision * 1_000_000 + message.order } : {}) }));
            if (mode === 'upsert') { options.onTranscript(updates, textDestination, mode); return; }
            conversation = [...previous, ...updates]; options.onTranscript(conversation, textDestination);
          },
          onEnd() {
            if (revision !== startRevision) return;
            const current = voice; voice = undefined;
            if (current) transportDone = Promise.resolve(current.close());
            settling = true; busy(false);
            void transportDone.finally(() => { if (revision === startRevision) { settling = false; busy(false); } });
          },
        };
        const session = native ? new NativeLiveVoice(callbacks) : new RealtimeVoice({ ...callbacks, model: 'qwen3.8-omni-flash-realtime', region, workspace });
        voice = session;
        await session.start();
      } catch { if (revision === startRevision) { status('语音未连接，请重试'); stop(); } }
      finally { if (revision === startRevision) starting = false; }
    })();
  };
  end.onclick = close;
  mute.onclick = async () => {
    const current = voice; mute.disabled = true;
    try {
      const muted = await current?.mute();
      if (!closed && current === voice) { mute.setAttribute('aria-pressed', String(!!muted)); mute.textContent = muted ? '取消静音' : '静音'; mute.setAttribute('aria-label', muted ? '开启麦克风' : '麦克风静音'); }
    } catch { status('操作未完成，请重试'); }
    finally { mute.disabled = false; }
  };
  el.querySelector<HTMLButtonElement>('[data-voice-interrupt]')!.onclick = () => voice?.interrupt();
  play.onclick = () => { if (voice instanceof RealtimeVoice) void voice.resumeAudio().then(() => { play.hidden = true; }).catch(() => status('点击「播放声音」继续')); };
  void (async () => {
    try {
      textDestination = await getLifeAiDestination().catch(() => undefined);
      if (closed) return;
      if (textDestination) el.querySelector('.voice-consent')!.textContent = '声音发送至百炼，长回复会通过模型加工排版';
      if (native) {
        const config = await liveVoicePlugin.configuration();
        if (closed) return;
        ready = config.ready === true;
        status(ready ? '点开始，直接说话' : '请先在 AI 设置中完成语音配置');
      } else {
        const response = await fetch('/__gleam/voice/config', { method: 'POST', headers: { 'X-Gleam-Voice': '1' }, signal: configController.signal });
        if (!response.ok) throw new Error();
        const config = await response.json();
        if (closed) return;
        workspace = config.workspace;
        region = await getSetting('voice.bailian.region');
        ready = config.configured === true && typeof workspace === 'string' && /^[a-zA-Z0-9-]{1,63}$/.test(workspace);
        status(ready ? '点开始，直接说话' : '当前网页暂不支持语音聊，请在 APP 使用');
      }
      busy(false);
      if (!native) settings.hidden = true;
    } catch { if (!closed) { ready = false; status(native ? '当前版本暂不支持语音聊，请更新应用' : '当前网页暂不支持语音聊，请在 APP 使用'); busy(false); settings.hidden = true; } }
  })();
  return close;
}
