import { esc } from '../../core/esc';
import { getSetting, setSetting } from '../../core/repo/settingsRepo';
import { secretStore } from '../../core/secretStore';
import { openPickList } from '../../shared/pickList';
import { showToast } from '../shell/toast';
import { isBailianAiBaseUrl, noteDecisionSupported, validNoteDecisionWorkspace } from '../entry/noteDecisionService';

async function readiness(): Promise<string> {
  if (!noteDecisionSupported()) return '仅 Android 可用';
  if (!isBailianAiBaseUrl(await getSetting('ai.baseUrl'))) return '请先配置百炼 AI 记账，再开启备注推荐';
  const [workspace, region] = await Promise.all([getSetting('ai.noteDecision.workspace'), getSetting('ai.noteDecision.region')]);
  if (typeof workspace !== 'string' || !validNoteDecisionWorkspace(workspace)) return '请填写对应 Key 的百炼业务空间 ID';
  if (!['beijing', 'singapore'].includes(region)) return '请选择有效的百炼服务地域';
  if (!(await secretStore.get('ai.apiKey'))?.trim()) return '请先保存百炼 AI 记账的 API Key';
  return '';
}

export async function setNoteDecisionEnabled(enabled: boolean): Promise<void> {
  if (enabled) { const reason = await readiness(); if (reason) throw new Error(reason); }
  await setSetting('ai.noteDecision.enabled', enabled);
}

export async function noteDecisionSettingsHtml(): Promise<string> {
  const [enabled, workspace, region, reason] = await Promise.all([
    getSetting('ai.noteDecision.enabled'), getSetting('ai.noteDecision.workspace'), getSetting('ai.noteDecision.region'), readiness(),
  ]);
  const supported = noteDecisionSupported();
  return `<details class="settings-details" data-settings-detail="note-decision"><summary>备注智能推荐（试验）</summary>
    <p class="settings-status">完成备注后，将本条备注、分类及账户名称、近 7/30/90 天使用统计发送至阿里百炼。长卡号仅保留尾号；不发送余额或全部流水。</p>
    <p class="settings-status">高置信且证据明确时自动回填，歧义或低置信时保持原值；不覆盖手动选择，可撤销，仍需手动保存。</p>
    <div class="field"><span>启用备注推荐</span><button id="note-decision-enabled" class="switch${enabled ? ' on' : ''}" role="switch" aria-checked="${enabled}" aria-label="启用备注推荐" type="button"${!supported && !enabled ? ' disabled' : ''}></button></div>
    <div class="ai-set">
      <label>服务地域<button id="note-decision-region" class="ai-pick-btn" type="button" data-region="${esc(region)}"${supported ? '' : ' disabled'}>${region === 'singapore' ? '新加坡' : '北京'}</button></label>
      <label>业务空间 ID<input id="note-decision-workspace" value="${esc(workspace)}" maxlength="63" placeholder="备注推荐业务空间 ID" autocomplete="off" spellcheck="false"${supported ? '' : ' disabled'}></label>
    </div>
    <p class="settings-status">复用已保存的百炼 AI 记账 API Key；此处地域和业务空间单独设置。</p>
    ${reason ? `<p class="settings-status" role="status">${esc(reason)}</p>` : ''}
  </details>`;
}

export function preserveNoteDecisionDraft(container: HTMLElement): () => void {
  const input = container.querySelector<HTMLInputElement>('#note-decision-workspace');
  const draft = input?.dataset.noteDecisionDirty ? input.value : undefined;
  return () => {
    const next = container.querySelector<HTMLInputElement>('#note-decision-workspace');
    if (next && draft !== undefined) { next.value = draft; next.dataset.noteDecisionDirty = 'true'; }
  };
}

export function handleNoteDecisionInput(input: HTMLInputElement): boolean {
  if (input.id !== 'note-decision-workspace') return false;
  input.dataset.noteDecisionDirty = 'true'; return true;
}

export function handleNoteDecisionChange(input: HTMLInputElement): boolean {
  if (input.id !== 'note-decision-workspace') return false;
  if (!noteDecisionSupported()) return true;
  const value = input.value.trim();
  if (value && !validNoteDecisionWorkspace(value)) { showToast('业务空间 ID 仅支持最多 63 位字母、数字或连字符'); return true; }
  delete input.dataset.noteDecisionDirty;
  void setSetting('ai.noteDecision.workspace', value).catch(() => showToast('备注推荐设置未保存，请重试'));
  return true;
}

export function handleNoteDecisionClick(target: HTMLElement, container: HTMLElement): boolean {
  const toggle = target.closest<HTMLButtonElement>('#note-decision-enabled');
  if (toggle) {
    if (toggle.disabled) return true;
    const enabled = toggle.getAttribute('aria-checked') !== 'true';
    toggle.disabled = true;
    void setNoteDecisionEnabled(enabled)
      .catch(error => showToast(error instanceof Error ? error.message : '备注推荐设置未保存，请重试'))
      .finally(() => { toggle.disabled = !noteDecisionSupported() && toggle.getAttribute('aria-checked') !== 'true'; });
    return true;
  }
  const region = target.closest<HTMLButtonElement>('#note-decision-region');
  if (!region) return false;
  if (!noteDecisionSupported()) return true;
  openPickList({ container, title: '备注推荐服务地域', selected: region.dataset.region ?? 'beijing',
    items: [{ value: 'beijing', label: '北京' }, { value: 'singapore', label: '新加坡' }],
    onPick(value) {
      if (value !== 'beijing' && value !== 'singapore') return;
      void setSetting('ai.noteDecision.region', value).catch(() => showToast('备注推荐设置未保存，请重试'));
    },
  });
  return true;
}
