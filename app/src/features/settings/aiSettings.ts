import './settings.css';
import { esc } from '../../core/esc';
import { on } from '../../core/store';
import { getSetting, setSetting } from '../../core/repo/settingsRepo';
import { testAiConnection, listAiModels } from '../../core/repo/aiRepo';
import { AI_PROVIDERS, buildModelChoices, matchProviderId, modelPreset } from './providers';
import { registerSubpage, openSubpage, SUBPAGE_CLOSE_EVENT } from '../shell/router';
import { showToast } from '../shell/toast';
import { openPickList } from '../../shared/pickList';
import { secretStore } from '../../core/secretStore';
import { bailianVoiceSettingsHtml, handleVoiceSettingsChange, handleVoiceSettingsInput, handleVoiceSettingsClick, isVoiceKeyWritePending } from './bailianVoiceSettings';
import { getVoiceSettingsEpoch, invalidateVoiceConnectionTest, mountVoiceConnectionTest, syncVoiceConnectionTest } from './bailianVoiceTestSettings';
import { aiKeyInputHtml, getAiKeySettingsEpoch, handleAiKeyChange, handleAiKeyInput, preserveAiKeyDraft } from './aiKeySettings';

let body: HTMLElement | undefined;
let settingsRefreshToken = 0;
let customModel = false;

/** 直接叠放在来源页面上，关闭后保留来源草稿与焦点。 */
export function openAiSettings(): void { openSubpage('sp-ai-settings'); }

async function refresh(): Promise<void> {
  const el = body;
  if (!el?.isConnected) return;
  const token = ++settingsRefreshToken;
  const voiceEpoch = getVoiceSettingsEpoch();
  const aiKeyEpoch = getAiKeySettingsEpoch();
  const voiceSettings = await bailianVoiceSettingsHtml();
  if (!el.isConnected) return;
  // [AI] AI 记账配置（OpenAI 兼容接口 + 自动入账阈值）
  const [aiBase, aiModel, aiKey, aiThreshold, modelCache] = await Promise.all([
    getSetting('ai.baseUrl'), getSetting('ai.model'), secretStore.get('ai.apiKey'), getSetting('ai.autoConfirmThreshold'), getSetting('ai.modelCatalogCache'),
  ]);
  if (!el.isConnected) return;

  // [AI] 平台回显（按 baseUrl 前缀匹配，匹配不上=自定义）
  const providerId = matchProviderId(aiBase);
  const providerLabel = providerId !== 'custom'
    ? (AI_PROVIDERS.find((p) => p.id === providerId)?.name ?? '自定义')
    : '自定义';
  const modelLabel = aiModel || '选择模型';
  const selectedModel = modelPreset(aiBase, aiModel);
  const showCustomModel = customModel || !!aiModel && !buildModelChoices(aiBase, '', modelCache).some(model => model.value.toLowerCase() === aiModel.toLowerCase());

  if (token !== settingsRefreshToken || !el.isConnected) return;
  // A slow settings read must never restore stale readiness, consent, or test success.
  if (voiceEpoch !== getVoiceSettingsEpoch()) { void refresh(); return; }
  if (aiKeyEpoch !== getAiKeySettingsEpoch()) { void refresh(); return; }
  const restoreAiKeyDraft = preserveAiKeyDraft(el);
  const voiceWorkspaceInput = el.querySelector<HTMLInputElement>('#voice-bailian-workspace');
  const voiceWorkspaceDraft = voiceWorkspaceInput?.dataset.voiceDirty ? voiceWorkspaceInput.value : undefined;
  const voiceKeyDraft = isVoiceKeyWritePending() ? '' : el.querySelector<HTMLInputElement>('#voice-bailian-key')?.value ?? '';
  const voiceRegionInput = el.querySelector<HTMLElement>('#voice-bailian-region');
  const voiceRegionDraft = voiceRegionInput?.dataset.voiceDirty ? voiceRegionInput.dataset.region : undefined;
  const voiceSourceInput = el.querySelector<HTMLInputElement>('#voice-key-shared');
  const voiceSourceDraft = voiceSourceInput?.dataset.voiceDirty ? voiceSourceInput.checked : undefined;
  const expandedDetails = new Set([...el.querySelectorAll<HTMLDetailsElement>('details[data-settings-detail][open]')].map(detail => detail.dataset.settingsDetail));
  el.innerHTML = `
    <section class="card" aria-label="AI 记账">
      <h3 class="card-title">AI 记账</h3>
      <div class="ai-set">
        <label>平台
          <button id="ai-provider" class="ai-pick-btn" type="button">${esc(providerLabel)}</button>
        </label>
        <label>API 地址<input id="ai-base" type="url" value="${esc(aiBase)}" placeholder="https://api.openai.com（OpenAI 兼容）" autocomplete="off"></label>
        <label>选择模型
          <button id="ai-model-pick" class="ai-pick-btn" type="button">${esc(modelLabel)}</button>
        </label>
        <label id="ai-custom-model"${showCustomModel ? '' : ' hidden'}>自定义模型名<input id="ai-model" type="text" value="${esc(aiModel)}" placeholder="如 qwen3.8-flash / kimi-k3" autocomplete="off"></label>
        <div class="field"><span>识别类型</span><span class="sub" id="ai-model-capability">${selectedModel ? selectedModel.vision ? '图片、文字' : '文字' : '以接口为准'}</span></div>
        <label>API Key${aiKeyInputHtml(aiKey)}</label>
        <label>自动入账阈值
          <div class="ai-thres"><input id="ai-thres" type="range" min="50" max="100" step="5" value="${aiThreshold}"><span class="num" id="ai-thres-val">${aiThreshold}%</span></div>
        </label>
        <p class="settings-status">文字、图片识别达到阈值且分类、账户完整时，自动入账。</p>
      </div>
      <div class="field"><span>连接测试</span>
        <div class="ai-actions">
          <button class="chip" data-act="ai-models">获取模型列表</button>
          <button class="chip" data-act="ai-test">测试连接</button>
        </div>
      </div>
    </section>

    ${voiceSettings}`;

  restoreAiKeyDraft();
  for (const detail of el.querySelectorAll<HTMLDetailsElement>('details[data-settings-detail]')) detail.open = expandedDetails.has(detail.dataset.settingsDetail);
  const voiceInput = el.querySelector<HTMLInputElement>('#voice-bailian-key');
  if (voiceInput && !voiceInput.disabled) voiceInput.value = voiceKeyDraft;
  const regionInput = el.querySelector<HTMLElement>('#voice-bailian-region');
  if (regionInput && voiceRegionDraft) { regionInput.dataset.region = voiceRegionDraft; regionInput.dataset.voiceDirty = 'true'; regionInput.textContent = voiceRegionDraft === 'singapore' ? '新加坡' : '北京'; }
  const sourceInput = el.querySelector<HTMLInputElement>('#voice-key-shared');
  if (sourceInput && voiceSourceDraft !== undefined) {
    sourceInput.checked = voiceSourceDraft; sourceInput.dataset.voiceDirty = 'true';
    if (voiceInput) {
      voiceInput.readOnly = voiceSourceDraft;
      const test = el.querySelector<HTMLElement>('[data-voice-test]');
      voiceInput.placeholder = (voiceSourceDraft ? test?.dataset.maskedMainKey : test?.dataset.keySource === 'shared' ? undefined : test?.dataset.maskedKey) || (voiceSourceDraft ? '请先填写 API Key' : '输入语音 Key');
    }
  }
  const workspaceInput = el.querySelector<HTMLInputElement>('#voice-bailian-workspace');
  if (workspaceInput && voiceWorkspaceDraft !== undefined) { workspaceInput.value = voiceWorkspaceDraft; workspaceInput.dataset.voiceDirty = 'true'; }
  syncVoiceConnectionTest(el);
}

export function initAiSettings(): void {
  registerSubpage('sp-ai-settings', {
    title: 'AI 配置',
    render(el) {
      body = el;
      customModel = false;
      mountVoiceConnectionTest(el);
      el.closest('.subpage')?.addEventListener(SUBPAGE_CLOSE_EVENT, () => {
        if (body === el) { body = undefined; settingsRefreshToken++; }
      }, { once: true });
      el.addEventListener('click', (e) => {
        const t = e.target as HTMLElement;
        if (handleVoiceSettingsClick(t, el)) return;
        const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
        if (act === 'ai-test') {
          // [AI] 发一次最小请求验证 baseUrl/model/apiKey 可用
          const btn = t.closest<HTMLButtonElement>('[data-act]')!;
          if (btn.disabled) return;
          btn.disabled = true;
          btn.textContent = '测试中…';
          void testAiConnection()
            .then(() => showToast('连接成功，AI 接口可用'))
            .catch((err) => showToast(err instanceof Error ? err.message : String(err)))
            .finally(() => void refresh());
        } else if (act === 'ai-models') {
          // [AI] 拉取平台 /models：成功后存 'ai.recentModels' 并重渲染进下拉；失败 toast 引导
          const btn = t.closest<HTMLButtonElement>('[data-act]')!;
          if (btn.disabled) return;
          btn.disabled = true;
          btn.textContent = '获取中…';
          const currentBase = el.querySelector<HTMLInputElement>('#ai-base')?.value ?? '';
          void listAiModels(buildModelChoices(currentBase, '', null).map(model => model.value))
           .then((ms) => showToast(ms.length ? `已获取 ${ms.length} 个模型，请点击「选择模型」查看` : '该平台未返回可用模型，请手动填写模型名'))
            .catch((err) => showToast(err instanceof Error ? err.message : String(err)))
            .finally(() => void refresh());
        } else if (t.closest('#ai-provider')) {
          // [AI] 平台 pickList：选预设 → 填 baseUrl → dispatchEvent change → 持久化链路
          const curBase = el.querySelector<HTMLInputElement>('#ai-base')?.value ?? '';
          const curPid = matchProviderId(curBase);
          openPickList({
            container: el,
            title: '选择平台',
            items: [
              { value: 'custom', label: '自定义' },
              ...AI_PROVIDERS.map((p) => ({ value: p.id, label: p.name })),
            ],
            selected: curPid,
            onPick(value, label) {
              const btn = el.querySelector<HTMLButtonElement>('#ai-provider');
              if (btn) btn.textContent = label;
              if (value === 'custom') return;
              const p = AI_PROVIDERS.find((it) => it.id === String(value));
              const input = el.querySelector<HTMLInputElement>('#ai-base');
              if (!p || !input) return;
              input.value = p.baseUrl;
              input.dispatchEvent(new Event('change', { bubbles: true }));
            },
          });
        } else if (t.closest('#ai-model-pick')) {
          // [AI] 模型 pickList：选模型 → 填 model → dispatchEvent change；选"自定义"→ 聚焦手输
          void (async () => {
            const [curBase, curModel, cache] = await Promise.all([
              getSetting('ai.baseUrl'), getSetting('ai.model'), getSetting('ai.modelCatalogCache'),
            ]);
            const opts = buildModelChoices(curBase, curModel, cache);
            openPickList({
              container: el,
              title: '选择模型',
              items: [
                { value: '__custom__', label: '自定义输入…' },
                ...opts,
              ],
              selected: curModel || undefined,
              searchable: true,
              onPick(value, label) {
                const btn = el.querySelector<HTMLButtonElement>('#ai-model-pick');
                const input = el.querySelector<HTMLInputElement>('#ai-model');
                if (!input) return;
                if (value === '__custom__') {
                  customModel = true;
                  input.closest<HTMLElement>('label')!.hidden = false;
                  // Picker teardown restores its opener on the next frame; focus the revealed editor afterwards.
                  requestAnimationFrame(() => { if (input.isConnected && !el.closest('[inert]')) input.focus(); });
                  return;
                }
                customModel = false;
                if (btn) btn.textContent = label;
                input.value = String(value);
                input.dispatchEvent(new Event('change', { bubbles: true }));
              },
            });
          })();
        }
      });
      // [AI] AI 记账配置：change 即持久化（settings-changed 重渲染后值不丢）；滑块拖动时实时回显百分比
      el.addEventListener('change', (e) => {
        const t = e.target as HTMLInputElement;
        if (handleVoiceSettingsChange(t)) return;
        if (handleAiKeyChange(t)) return;
        if (t.id === 'ai-base') void setSetting('ai.baseUrl', t.value.trim());
        else if (t.id === 'ai-model') void setSetting('ai.model', t.value.trim());
        else if (t.id === 'ai-thres') void setSetting('ai.autoConfirmThreshold', Number(t.value));
      });
      // A renderer-induced change can consume the browser's native change flag.
      // The next real blur still commits our dirty draft; the editor deduplicates both events.
      el.addEventListener('focusout', (e) => {
        handleAiKeyChange(e.target as HTMLInputElement);
      });
      el.addEventListener('input', (e) => {
        const t = e.target as HTMLInputElement;
        if (handleVoiceSettingsInput(t)) return;
        if (handleAiKeyInput(t)) {
          invalidateVoiceConnectionTest('主 API Key 输入已变化，请重新测试');
          return;
        }
        if (t.id !== 'ai-thres') return;
        const label = el.querySelector('#ai-thres-val');
        if (label) label.textContent = `${t.value}%`;
      });
      void refresh();
    },
    onShow() { void refresh(); },
  });

  on('settings-changed', () => void refresh());
}
