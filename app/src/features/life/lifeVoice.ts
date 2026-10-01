import { esc } from '../../core/esc';
import type { LifeChatMessage } from '../../core/types';
import { RealtimeVoice } from '../../core/realtimeVoice';
import { getSetting, setSetting } from '../../core/repo/settingsRepo';
import { openPickList } from '../../shared/pickList';
import { closeSheet, openSheet } from '../shell/sheet';

const models = ['qwen3.8-omni-flash-realtime', 'qwen-audio-3.1-realtime-plus', 'qwen3.5-omni-plus-realtime'];
let preferredModel = models[0];
let preferredRegion = 'beijing';
let workspace = '';

export function openLifeVoice(options: { onTranscript: (messages: LifeChatMessage[]) => void }): () => void {
  let voice: RealtimeVoice | undefined;
  let closed = false;
  let starting = false;
  let configReady = false;
  let conversation: LifeChatMessage[] = [];
  const configController = new AbortController();
  const stop = () => { voice?.close(); voice = undefined; };
  openSheet({ ariaLabel: '实时语音', onClose() { closed = true; configController.abort(); stop(); }, render(el) {
    el.innerHTML = `<div class="sheet-head"><h3>和拾光说说话</h3><button class="icon-btn" data-voice-close aria-label="关闭实时语音">×</button></div>
      <div class="sheet-scroll voice-panel">
        <div class="voice-identity" aria-hidden="true">✦</div><p class="voice-lead">不用打字，随时开口</p>
        <div class="voice-settings"><label>语音模型<button class="pick-trigger" data-voice-model>${esc(preferredModel)}</button></label><label>服务地域<button class="pick-trigger" data-voice-region>${preferredRegion === 'beijing' ? '北京' : '新加坡'}</button></label><label>业务空间 ID <small>与 Key 属于同一空间</small><input class="note" id="voice-workspace" value="${esc(workspace)}" placeholder="填写百炼控制台中的业务空间 ID" maxlength="80" autocomplete="off"></label></div>
        <p class="voice-consent">语音使用阿里云百炼（独立于文字模型），Key 来自本机环境变量。开始后，麦克风声音将实时发送给百炼，可能产生模型费用；不发送已有聊天、照片或账本，不在本机保存录音，只保留返回的文字转录。</p>
        <p class="voice-state" data-voice-status role="status">正在检查本地连接服务…</p><div class="voice-transcript" data-voice-transcript aria-live="polite"></div>
        <button class="btn primary" data-voice-start disabled>同意并开始语音</button>
        <div class="voice-controls" hidden><button class="btn ghost" data-voice-mute aria-pressed="false">麦克风静音</button><button class="btn ghost" data-voice-interrupt>打断回复</button><button class="btn ghost" data-voice-play>播放声音</button><button class="btn primary" data-voice-end>结束语音</button></div>
      </div>`;
    const status = (text: string) => { if (!closed) el.querySelector('[data-voice-status]')!.textContent = text; };
    const busy = (value: boolean) => {
      if (closed) return;
      el.querySelector<HTMLButtonElement>('[data-voice-start]')!.hidden = value;
      el.querySelector<HTMLElement>('.voice-controls')!.hidden = !value;
      el.querySelectorAll<HTMLInputElement | HTMLButtonElement>('.voice-settings input,.voice-settings button').forEach(control => { control.disabled = value; });
    };
    el.querySelector('[data-voice-close]')!.addEventListener('click', closeSheet);
    el.querySelector('[data-voice-model]')!.addEventListener('click', () => openPickList({ container: el, title: '实时语音模型', items: models.map(value => ({ value, label: value })), selected: preferredModel, onPick(value) { preferredModel = String(value); el.querySelector('[data-voice-model]')!.textContent = preferredModel; } }));
    el.querySelector('[data-voice-region]')!.addEventListener('click', () => openPickList({ container: el, title: 'Key 所属地域', items: [{ value: 'beijing', label: '北京' }, { value: 'singapore', label: '新加坡' }], selected: preferredRegion, onPick(value, label) { preferredRegion = String(value); el.querySelector('[data-voice-region]')!.textContent = label; } }));
    el.querySelector('[data-voice-start]')!.addEventListener('click', () => {
      if (voice || starting || !configReady || closed) return;
      starting = true;
      void (async () => {
        try {
          workspace = el.querySelector<HTMLInputElement>('#voice-workspace')!.value.trim();
          if (!/^[a-zA-Z0-9-]{1,80}$/.test(workspace)) { status('请填写业务空间 ID，只能包含字母、数字和连字符'); return; }
          if (!await getSetting('life.aiEnabled')) await setSetting('life.aiEnabled', true);
          if (closed) return;
          busy(true);
          const previous = [...conversation];
          const muteButton = el.querySelector<HTMLButtonElement>('[data-voice-mute]')!;
          muteButton.textContent = '麦克风静音'; muteButton.setAttribute('aria-pressed', 'false');
          const session = new RealtimeVoice({ model: preferredModel, region: preferredRegion, workspace, onStatus: status,
            onTranscript(messages) { if (!closed) { conversation = [...previous, ...messages]; options.onTranscript(conversation); el.querySelector('[data-voice-transcript]')!.textContent = messages.at(-1)?.content ?? ''; } },
            onEnd() { voice = undefined; busy(false); },
          });
          voice = session;
          await session.start();
        } catch { status('语音暂时无法启动，请重试'); stop(); busy(false); }
        finally { starting = false; }
      })();
    });
    el.querySelector('[data-voice-end]')!.addEventListener('click', () => { stop(); status('语音已结束，文字留在本次聊天'); });
    el.querySelector<HTMLButtonElement>('[data-voice-mute]')!.onclick = event => {
      const muted = voice?.mute() ?? false;
      const button = event.currentTarget as HTMLButtonElement;
      button.setAttribute('aria-pressed', String(muted)); button.textContent = muted ? '开启麦克风' : '麦克风静音';
      status(muted ? '麦克风已静音' : '麦克风已开启');
    };
    el.querySelector('[data-voice-interrupt]')!.addEventListener('click', () => voice?.interrupt());
    el.querySelector('[data-voice-play]')!.addEventListener('click', () => { void voice?.resumeAudio().catch(() => status('声音播放失败，请检查浏览器权限')); });
    void fetch('/__gleam/voice/config', { method: 'POST', headers: { 'X-Gleam-Voice': '1' }, signal: configController.signal }).then(async response => {
      if (!response.ok) throw new Error('unavailable');
      const config = await response.json();
      if (closed) return;
      if (!workspace && typeof config.workspace === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(config.workspace)) {
        workspace = config.workspace; el.querySelector<HTMLInputElement>('#voice-workspace')!.value = workspace;
      }
      configReady = config.configured === true;
      el.querySelector<HTMLButtonElement>('[data-voice-start]')!.disabled = !configReady;
      status(configReady ? '已找到本机 Key，开始后才会使用麦克风' : '未找到 DASHSCOPE_API_KEY，请设置后重启本地网页服务');
    }).catch(() => status('本地语音服务未启动；请通过本机开发服务器打开拾光。离线 PWA 暂不支持语音。'));
  } });
  return stop;
}
