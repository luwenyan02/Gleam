import type { LifeChatMessage } from '../../core/types';
import { iconHtml } from '../../assets/icons';
import { RealtimeVoice } from '../../core/realtimeVoice';
import { NativeLiveVoice, liveVoicePlugin, nativeLiveVoiceSupported } from '../../core/nativeLiveVoice';
import { getSetting, setSetting } from '../../core/repo/settingsRepo';
import { closeSheet, openSheet } from '../shell/sheet';
import { openAiSettings } from '../settings/settings';
import { chatIcon } from './chatIcons';

/** Both transports share the small call UI; Android reads only the native tested configuration. */
export function openLifeVoice(options: { onTranscript: (messages: LifeChatMessage[]) => void }): () => void {
  const native = nativeLiveVoiceSupported();
  let voice: NativeLiveVoice | RealtimeVoice | undefined;
  let closed = false, starting = false, ready = false;
  let startRevision = 0;
  let reset = () => {};
  let workspace = '', region = 'beijing';
  let conversation: LifeChatMessage[] = [];
  const configController = new AbortController();
  const stop = () => { startRevision++; starting = false; const current = voice; voice = undefined; current?.close(); reset(); };
  openSheet({ ariaLabel: '实时语音', onClose() { closed = true; configController.abort(); stop(); }, render(el) {
    el.innerHTML = `<div class="sheet-head"><h3>和拾光说说话</h3><button class="icon-btn" data-voice-close aria-label="关闭实时语音">${iconHtml('ic-close')}</button></div>
      <div class="sheet-scroll voice-panel voice-simple">
        <div class="voice-stage"><div class="voice-identity" aria-hidden="true">${chatIcon('voice')}</div>
          <p class="voice-state" data-voice-status role="status">正在准备…</p><div class="voice-transcript" data-voice-transcript aria-live="polite"></div></div>
        <p class="voice-consent">声音将发送给百炼，可能产生费用。仅保留本次文字。</p>
        <div class="voice-controls" hidden><button class="btn ghost" data-voice-mute aria-pressed="false">麦克风静音</button><button class="btn ghost" data-voice-interrupt>打断回复</button></div>
        <button class="btn primary" data-voice-start disabled>开始语音</button>
        <button class="btn primary" data-voice-end hidden>结束语音</button>
        <button class="btn ghost" data-voice-settings hidden>前往 AI 设置</button>
        <button class="btn ghost" data-voice-play hidden>播放声音</button>
      </div>`;
    const start = el.querySelector<HTMLButtonElement>('[data-voice-start]')!;
    const end = el.querySelector<HTMLButtonElement>('[data-voice-end]')!;
    const mute = el.querySelector<HTMLButtonElement>('[data-voice-mute]')!;
    const settings = el.querySelector<HTMLButtonElement>('[data-voice-settings]')!;
    const play = el.querySelector<HTMLButtonElement>('[data-voice-play]')!;
    const status = (text: string) => {
      if (closed) return;
      el.querySelector('[data-voice-status]')!.textContent = text;
      play.hidden = native || !text.includes('播放声音');
    };
    const busy = (phase: 'connecting' | 'connected' | false) => {
      if (closed) return;
      el.dataset.voicePhase = phase || 'idle';
      start.hidden = !!phase || !ready; start.disabled = !!phase || !ready;
      end.hidden = !phase; end.textContent = phase === 'connecting' ? '取消连接' : '结束语音';
      el.querySelector<HTMLElement>('.voice-controls')!.hidden = phase !== 'connected';
      el.querySelector<HTMLElement>('.voice-consent')!.hidden = !!phase;
      settings.hidden = !native || !!phase || ready;
    };
    reset = () => busy(false);
    el.querySelector('[data-voice-close]')!.addEventListener('click', closeSheet);
    settings.onclick = () => { closeSheet(); openAiSettings(); };
    start.onclick = () => {
      if (voice || starting || !ready || closed) return;
      const revision = ++startRevision;
      starting = true; busy('connecting'); status('正在连接…');
      el.querySelector('[data-voice-transcript]')!.textContent = '';
      mute.textContent = '麦克风静音'; mute.setAttribute('aria-pressed', 'false');
      const previous = [...conversation];
      void (async () => {
        try {
          if (!await getSetting('life.aiEnabled')) await setSetting('life.aiEnabled', true);
          if (closed || revision !== startRevision) return;
          const callbacks = { onStatus: (text: string) => { if (revision === startRevision) status(text); },
            onTranscript(messages: LifeChatMessage[]) {
              if (closed || revision !== startRevision) return;
              conversation = [...previous, ...messages]; options.onTranscript(conversation);
              el.querySelector('[data-voice-transcript]')!.textContent = messages.slice(-2).map(message => `${message.role === 'user' ? '你' : '拾光'}：${message.content}`).join('\n\n');
            },
            onEnd() { if (revision === startRevision) { voice = undefined; busy(false); } },
          };
          const session = native ? new NativeLiveVoice(callbacks) : new RealtimeVoice({ ...callbacks, model: 'qwen3.8-omni-flash-realtime', region, workspace });
          voice = session;
          await session.start();
          if (!closed && voice === session) busy('connected');
        } catch { if (revision === startRevision) { status('语音未连接，请重试'); stop(); } }
        finally { if (revision === startRevision) starting = false; }
      })();
    };
    end.onclick = () => { stop(); status('语音已结束'); busy(false); };
    mute.onclick = async () => {
      const current = voice; mute.disabled = true;
      try {
        const muted = await current?.mute();
        if (!closed && current === voice) { mute.setAttribute('aria-pressed', String(!!muted)); mute.textContent = muted ? '开启麦克风' : '麦克风静音'; }
      } catch { status('操作未完成，请重试'); }
      finally { mute.disabled = false; }
    };
    el.querySelector<HTMLButtonElement>('[data-voice-interrupt]')!.onclick = () => voice?.interrupt();
    play.onclick = () => { if (voice instanceof RealtimeVoice) void voice.resumeAudio().then(() => { play.hidden = true; }).catch(() => status('点击「播放声音」继续')); };
    void (async () => {
      try {
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
  } });
  return stop;
}
