import { esc } from '../../core/esc';
import { BAILIAN_VOICE_MODEL } from '../../core/bailianVoiceConfig';
import { nativeSpeech, type NativeSpeechConfiguration } from '../../core/nativeSpeech';
import { getSetting } from '../../core/repo/settingsRepo';
import { openPickList } from '../../shared/pickList';
import { handleVoiceConnectionTestClick, invalidateVoiceConnectionTest, syncVoiceConnectionTest, voiceConnectionTestHtml } from './bailianVoiceTestSettings';

// Retained for full-page render compatibility; only the explicit tested transaction writes keys.
export function isVoiceKeyWritePending(): boolean { return false; }

/** Raw voice keys are write-only; configuration contains only bounded masked summaries. */
export async function bailianVoiceSettingsHtml(): Promise<string> {
  const [region, workspace, readiness] = await Promise.all([
    getSetting('voice.bailian.region'), getSetting('voice.bailian.workspace'),
    nativeSpeech.configuration().catch((): NativeSpeechConfiguration => ({ supported: false, hasKey: false, credentialRevision: '' })),
  ]);
  const config = readiness.activeConfig ?? { region, workspace, model: BAILIAN_VOICE_MODEL };
  const shared = readiness.keySource === 'shared';
  const masked = shared ? readiness.maskedMainKey : readiness.maskedKey;
  return `<section class="card" aria-label="百炼短语音">
    <h3 class="card-title">百炼短语音</h3>
    ${readiness.supported ? '' : '<p class="settings-status" role="status">仅 Android 可用</p><details class="settings-details voice-web-details" data-settings-detail="voice-web"><summary>查看语音配置</summary>'}
    <div class="ai-set">
      <label>服务地域<button class="ai-pick-btn" id="voice-bailian-region" data-region="${config.region}" type="button"${readiness.supported ? '' : ' disabled'}>${config.region === 'singapore' ? '新加坡' : '北京'}</button></label>
      <label>业务空间 ID<input id="voice-bailian-workspace" value="${esc(config.workspace)}" maxlength="63" placeholder="业务空间 ID" autocomplete="off" spellcheck="false"${readiness.supported ? '' : ' disabled'}></label>
      <label>语音模型<input id="voice-bailian-model" value="${BAILIAN_VOICE_MODEL}" readonly aria-label="百炼语音模型"></label>
      <div class="voice-key-label"><label for="voice-bailian-key">语音Key</label><label class="voice-key-source"><input id="voice-key-shared" type="checkbox"${shared ? ' checked' : ''}${readiness.supported ? '' : ' disabled'}>与 API Key 相同</label></div>
      <input id="voice-bailian-key" type="password" value="" maxlength="512" placeholder="${esc(masked || (shared ? '请先填写 API Key' : '输入语音 Key'))}" aria-label="语音Key" autocomplete="new-password"${shared ? ' readonly' : ''}${readiness.supported ? '' : ' disabled'}>
    </div>
    <div class="settings-status-row">
      ${voiceConnectionTestHtml(readiness.supported, readiness.hasKey, readiness)}
    </div>
    ${readiness.supported ? '' : '</details>'}
  </section>`;
}

export function handleVoiceSettingsInput(input: HTMLInputElement): boolean {
  if (!['voice-bailian-workspace', 'voice-bailian-key', 'voice-bailian-model'].includes(input.id)) return false;
  input.dataset.voiceDirty = 'true';
  invalidateVoiceConnectionTest();
  return true;
}

export function handleVoiceSettingsChange(input: HTMLInputElement): boolean {
  if (input.id === 'voice-key-shared') {
    input.dataset.voiceDirty = 'true';
    invalidateVoiceConnectionTest();
    const container = input.closest<HTMLElement>('.sub-body');
    const key = container?.querySelector<HTMLInputElement>('#voice-bailian-key');
    const test = container?.querySelector<HTMLButtonElement>('[data-voice-test]');
    if (key) {
      key.value = ''; key.readOnly = input.checked;
      key.placeholder = (input.checked ? test?.dataset.maskedMainKey : test?.dataset.keySource === 'shared' ? undefined : test?.dataset.maskedKey) || (input.checked ? '请先填写 API Key' : '输入语音 Key');
    }
    if (container) syncVoiceConnectionTest(container);
    return true;
  }
  if (input.id !== 'voice-bailian-workspace') return false;
  handleVoiceSettingsInput(input); // Config remains a draft until the native tested transaction commits.
  return true;
}

export function handleVoiceSettingsClick(target: HTMLElement, container: HTMLElement): boolean {
  if (handleVoiceConnectionTestClick(target, container)) return true;
  const region = target.closest<HTMLButtonElement>('#voice-bailian-region');
  if (!region) return false;
  invalidateVoiceConnectionTest();
  openPickList({ container, title: '百炼语音地域',
    items: [{ value: 'beijing', label: '北京' }, { value: 'singapore', label: '新加坡' }], selected: region.dataset.region ?? 'beijing',
    onPick(value) {
      invalidateVoiceConnectionTest(); region.dataset.region = String(value); region.dataset.voiceDirty = 'true';
      region.textContent = value === 'singapore' ? '新加坡' : '北京';
    },
  });
  return true;
}
