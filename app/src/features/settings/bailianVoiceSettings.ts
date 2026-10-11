import { esc } from '../../core/esc';
import { BAILIAN_VOICE_MODEL } from '../../core/bailianVoiceConfig';
import { nativeSpeech } from '../../core/nativeSpeech';
import { getSetting, setSetting } from '../../core/repo/settingsRepo';
import { emit } from '../../core/store';
import { showToast } from '../shell/toast';
import { openPickList } from '../../shared/pickList';
import { shortVoiceError } from '../../core/bailianVoiceErrors';
import { handleVoiceConnectionTestClick, invalidateVoiceConnectionTest, setVoiceTestCredentialWritePending, voiceConnectionTestHtml } from './bailianVoiceTestSettings';

let keyWritePending = false;
export function isVoiceKeyWritePending(): boolean { return keyWritePending; }

/** Key只交原生专用安全存储，不读回、不进入设置表或浏览器存储。 */
export async function bailianVoiceSettingsHtml(): Promise<string> {
  const [region, workspace, readiness] = await Promise.all([
    getSetting('voice.bailian.region'), getSetting('voice.bailian.workspace'),
    nativeSpeech.configuration().catch(() => ({ supported: false, hasKey: false })),
  ]);
  return `<section class="card" aria-label="百炼短语音">
    <h3 class="card-title">百炼短语音</h3>
    <div class="ai-set">
      <label>服务地域<button class="ai-pick-btn" id="voice-bailian-region" type="button">${region === 'singapore' ? '新加坡' : '北京'}</button></label>
      <label>业务空间 ID<input id="voice-bailian-workspace" value="${esc(workspace)}" maxlength="63" placeholder="与语音 Key 属于同一业务空间" autocomplete="off" spellcheck="false"></label>
      <label>语音模型<input id="voice-bailian-model" value="${BAILIAN_VOICE_MODEL}" readonly aria-label="百炼语音模型"></label>
      <label>独立语音 API Key<input id="voice-bailian-key" type="password" value="" maxlength="512" placeholder="${readiness.hasKey ? '已安全保存，输入新 Key 可替换' : '在手机上填写百炼语音 Key'}" autocomplete="new-password"${readiness.supported && !keyWritePending ? '' : ' disabled'}></label>
    </div>
    <div class="ai-actions"><button class="chip" data-voice-save-key${readiness.supported && !keyWritePending ? '' : ' disabled'}>保存语音 Key</button><button class="chip" data-voice-clear-key${readiness.supported && readiness.hasKey && !keyWritePending ? '' : ' disabled'}>清除语音 Key</button></div>
    <p class="tiny" data-voice-key-status role="status">${readiness.supported ? readiness.hasKey ? '语音 Key 已保存到本机' : '语音 Key 只保存在本机，需单独填写' : '仅支持 Android；网页版不接收或保存 Key'}</p>
    ${voiceConnectionTestHtml(readiness.supported && !keyWritePending, readiness.hasKey)}
    <details class="voice-settings-help"><summary>使用与隐私说明</summary><p class="tiny">语音 Key 独立于文字 AI，通过 Android Keystore 加密保存，不写入安装包、普通备份或账本。保存 Key 不调用服务。</p><p class="tiny">录音前会确认将声音发送给百炼，可能产生费用；拾光不保存录音。每次30秒内说一笔支出或收入，核对文字后生成草稿。</p></details>
  </section>`;
}

export function handleVoiceSettingsInput(input: HTMLInputElement): boolean {
  if (!['voice-bailian-workspace', 'voice-bailian-key', 'voice-bailian-model'].includes(input.id)) return false;
  if (input.id === 'voice-bailian-workspace') input.dataset.voiceDirty = 'true';
  invalidateVoiceConnectionTest('配置输入已变化，请重新核对并测试');
  return true;
}

export function handleVoiceSettingsChange(input: HTMLInputElement): boolean {
  if (input.id !== 'voice-bailian-workspace') return false;
  handleVoiceSettingsInput(input);
  const value = input.value.trim();
  if (value && !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(value)) {
    showToast('业务空间 ID 只能使用字母、数字和连字符，不能以连字符开头或结尾'); return true;
  }
  void setSetting('voice.bailian.workspace', value).catch(() => showToast('业务空间未保存，请重试')); return true;
}

export function handleVoiceSettingsClick(target: HTMLElement, container: HTMLElement): boolean {
  if (handleVoiceConnectionTestClick(target, container)) return true;
  if (target.closest('#voice-bailian-region')) {
    invalidateVoiceConnectionTest('地域选择已打开，请选择后重新测试');
    void getSetting('voice.bailian.region').then(region => openPickList({ container, title: '百炼语音地域',
      items: [{ value: 'beijing', label: '北京' }, { value: 'singapore', label: '新加坡' }], selected: region,
      onPick(value) { invalidateVoiceConnectionTest(); void setSetting('voice.bailian.region', value as 'beijing' | 'singapore'); },
    }));
    return true;
  }
  const save = target.closest<HTMLButtonElement>('[data-voice-save-key]');
  const clear = target.closest<HTMLButtonElement>('[data-voice-clear-key]');
  const button = save ?? clear;
  if (!button) return false;
  if (button.disabled || keyWritePending) return true;
  const input = container.querySelector<HTMLInputElement>('#voice-bailian-key');
  const value = input?.value.trim() ?? '';
  if (save && !value) { showToast('请在手机上填写独立的百炼语音 API Key'); return true; }
  keyWritePending = true;
  setVoiceTestCredentialWritePending(true);
  if (input) { input.value = ''; input.disabled = true; }
  button.disabled = true;
  void (save ? nativeSpeech.setKey({ value }) : nativeSpeech.clearKey()).then(() => {
    if (input) input.value = '';
    const current = container.querySelector<HTMLInputElement>('#voice-bailian-key');
    if (current) current.value = '';
    showToast(save ? '语音 Key 已安全保存，尚未调用服务' : '语音 Key 已清除，当前语音已停止');
  }).catch(error => {
    showToast(shortVoiceError(error));
  }).finally(() => {
    keyWritePending = false;
    setVoiceTestCredentialWritePending(false);
    emit('settings-changed');
  });
  return true;
}

