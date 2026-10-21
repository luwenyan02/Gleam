import type { VoiceTranscriptMessage, VoiceTextDestination, VoiceTranscriptMode } from '../../core/voiceTranscript';
import { getLifeAiDestination } from '../../core/repo/lifeAiRepo';
import { iconHtml } from '../../assets/icons';
import { RealtimeVoice, type VoiceState } from '../../core/realtimeVoice';
import { NativeLiveVoice, liveVoicePlugin, nativeLiveVoiceSupported } from '../../core/nativeLiveVoice';
import { getSetting, setSetting } from '../../core/repo/settingsRepo';
import { manageOverlay } from '../../shared/overlay';
import { openAiSettings } from '../settings/settings';
import { voiceIcons } from './voiceIcons';

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
  options.container.classList.add('voice-dock-open');
  const previous = { inert: fields.inert, hidden: fields.getAttribute('aria-hidden') };
  let releaseOverlay = () => {};
  const close = () => {
    if (closed) return;
    finalRevision = startRevision; closed = true; configController.abort();
    const done = stop(); releaseOverlay(); el.remove();
    options.container.classList.remove('voice-dock-open');
    fields.inert = previous.inert;
    if (previous.hidden == null) fields.removeAttribute('aria-hidden'); else fields.setAttribute('aria-hidden', previous.hidden);
    if (fields.isConnected && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      fields.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: 'ease-out' });
    }
    // Keep the parent composer blocked until the final native transcript is settled.
    void done.then(options.onClose, options.onClose);
  };
  options.container.append(el);
  releaseOverlay = manageOverlay(el, close, { modal: false, opener: options.container.querySelector<HTMLElement>('[data-chat-voice]')! });
  fields.inert = true; fields.setAttribute('aria-hidden', 'true');
  // Reuse the home short-voice bars as a decorative state indicator, not a volume meter.
  const wave = `<span class="voice-wave" aria-hidden="true">${'<i></i>'.repeat(11)}</span>`;
  el.innerHTML = `<p class="voice-state" data-voice-status role="status">正在准备…</p>
    <div class="voice-inline-actions">
      <button class="voice-control voice-main" data-voice-start disabled><span class="voice-control-face">${wave}</span><span>开始语音</span></button>
      <button class="voice-control" data-voice-mute aria-label="麦克风静音" aria-pressed="false" hidden><span class="voice-control-face"><span data-voice-mic-on>${iconHtml('ic-mic')}</span><span data-voice-mic-off hidden>${voiceIcons.micOff}</span></span><span data-voice-mute-label>静音</span></button>
      <button class="voice-control voice-main" data-voice-interrupt aria-label="打断回复" hidden><span class="voice-control-face">${wave}</span><span>轻点打断</span></button>
      <div class="voice-control voice-main voice-connecting" hidden aria-hidden="true"><span class="voice-control-face">${wave}</span><span>连接中</span></div>
      <button class="voice-control voice-end" data-voice-end aria-label="结束语音" hidden><span class="voice-control-face">${voiceIcons.hangup}</span><span data-voice-end-label>结束</span></button>
      <button class="voice-control voice-close" data-voice-close aria-label="关闭语音聊"><span class="voice-control-face">${iconHtml('ic-close')}</span><span>关闭</span></button>
    </div>
    <p class="voice-consent">声音发送至百炼</p>
    <button class="btn ghost voice-extra" data-voice-settings hidden>前往 AI 设置</button>
    <button class="btn ghost voice-extra" data-voice-play hidden>播放声音</button>`;
  const start = el.querySelector<HTMLButtonElement>('[data-voice-start]')!;
  const end = el.querySelector<HTMLButtonElement>('[data-voice-end]')!;
  const mute = el.querySelector<HTMLButtonElement>('[data-voice-mute]')!;
  const settings = el.querySelector<HTMLButtonElement>('[data-voice-settings]')!;
  const play = el.querySelector<HTMLButtonElement>('[data-voice-play]')!;
  const showMuted = (muted: boolean) => {
    mute.setAttribute('aria-pressed', String(muted));
    mute.setAttribute('aria-label', muted ? '开启麦克风' : '麦克风静音');
    el.querySelector('[data-voice-mute-label]')!.textContent = muted ? '取消静音' : '静音';
    el.querySelector<HTMLElement>('[data-voice-mic-on]')!.hidden = muted;
    el.querySelector<HTMLElement>('[data-voice-mic-off]')!.hidden = !muted;
    el.dataset.micMuted = String(muted);
  };
  const state = (value: VoiceState) => { if (!closed) el.dataset.voiceState = value; };
  const status = (text: string) => {
    if (closed) return;
    el.querySelector('[data-voice-status]')!.textContent = text;
    play.hidden = native || !text.includes('播放声音');
  };
  const busy = (phase: 'connecting' | 'connected' | false) => {
    if (closed) return;
    const focused = document.activeElement;
    el.dataset.voicePhase = phase || 'idle';
    start.hidden = !!phase || !ready; start.disabled = !!phase || !ready || settling;
    end.hidden = !phase;
    end.setAttribute('aria-label', phase === 'connecting' ? '取消连接' : '结束语音');
    el.querySelector('[data-voice-end-label]')!.textContent = phase === 'connecting' ? '取消连接' : '结束';
    el.querySelector<HTMLElement>('[data-voice-close]')!.hidden = !!phase;
    el.querySelector<HTMLElement>('.voice-connecting')!.hidden = phase !== 'connecting';
    mute.hidden = phase !== 'connected';
    el.querySelector<HTMLElement>('[data-voice-interrupt]')!.hidden = phase !== 'connected';
    el.querySelector<HTMLElement>('.voice-consent')!.hidden = !!phase;
    settings.hidden = !native || !!phase || ready;
    // Keep keyboard focus usable when the action that had focus disappears.
    if (focused instanceof HTMLElement && el.contains(focused) && focused.closest('[hidden]')) {
      (phase ? end : ready && !settling ? start : el.querySelector<HTMLButtonElement>('[data-voice-close]')!).focus({ preventScroll: true });
    }
  };
  reset = () => busy(false);
  el.querySelector('[data-voice-close]')!.addEventListener('click', close);
  settings.onclick = () => { close(); openAiSettings(); };
  start.onclick = () => {
    if (voice || starting || settling || !ready || closed) return;
    const revision = ++startRevision;
    starting = true; busy('connecting'); status('正在连接…');
    state('connecting');
    showMuted(false);
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
      if (!closed && current === voice) showMuted(!!muted);
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
