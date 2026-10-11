/**
 * 拾光 · 设置与安全子页（features/settings，PRD 4.19，覆盖 sp-settings）
 * 分区顺序：记账偏好 → 数据与备份 → 智能能力与通知 → 外观与安全 → 关于。
 * 入口：我的页右上角齿轮（data-sub="sp-settings"，M1 已接）。
 */
import './settings.css';
import { Capacitor } from '@capacitor/core';
import { iconHtml } from '../../assets/icons';
import { esc } from '../../core/esc';
import { on } from '../../core/store';
import { getSetting, setSetting } from '../../core/repo/settingsRepo';
import { testAiConnection, listAiModels } from '../../core/repo/aiRepo';
import { AI_PROVIDERS, buildModelChoices, matchProviderId, modelPreset, recentModels } from './providers';
import { ensurePermission } from '../../core/notify';
import { registerSubpage, openSubpage } from '../shell/router';
import { openSheet, closeSheet } from '../shell/sheet';
import { showToast } from '../shell/toast';
import { APP_VERSION } from '../backup/skbak';
import {
  setPin, verifyPin, clearPin, biometricAvailable, enrollBiometric,
} from './lock';
import { openPickList } from '../../shared/pickList';
import { secretStore } from '../../core/secretStore';
import {
  accountingMonthRange, getAccountingMonth, setAccountingMonthStartDay,
} from '../../core/repo/periodRepo';
import { formatAccountingRange } from '../../core/period';
import { bailianVoiceSettingsHtml, handleVoiceSettingsChange, handleVoiceSettingsInput, handleVoiceSettingsClick, isVoiceKeyWritePending } from './bailianVoiceSettings';

import { getVoiceSettingsEpoch, invalidateVoiceConnectionTest, mountVoiceConnectionTest, syncVoiceConnectionTest } from './bailianVoiceTestSettings';
import { openSettingsManual } from './settingsManual';
import { aiKeyInputHtml, getAiKeySettingsEpoch, handleAiKeyChange, handleAiKeyInput, preserveAiKeyDraft } from './aiKeySettings';

let body: HTMLElement | undefined;
let sheetAbort: AbortController | undefined;
let revealAiOnOpen = false;
let settingsRefreshToken = 0;

/** 复用设置页的接口配置；保留下层页面与草稿。 */
export function openAiSettings(): void {
  revealAiOnOpen = true;
  openSubpage('sp-settings');
  revealAiOnOpen = false;
}

function sheetSignal(): AbortSignal {
  sheetAbort?.abort();
  sheetAbort = new AbortController();
  return sheetAbort.signal;
}

/* ── 渲染 ── */

const switchHtml = (key: string, on_: boolean, label: string, disabled = false) =>
  `<button class="switch${on_ ? ' on' : ''}" role="switch" aria-checked="${on_}" data-sw="${key}" aria-label="${label}"${disabled ? ' disabled' : ''}></button>`;

async function refresh(): Promise<void> {
  const el = body;
  if (!el?.isConnected) return;
  const token = ++settingsRefreshToken;
  const voiceEpoch = getVoiceSettingsEpoch();
  const aiKeyEpoch = getAiKeySettingsEpoch();
  const isNative = Capacitor.isNativePlatform();
  const [pin, webauthn, bioOk, countAsIncome, autoRenew, backupAuto, retention, themeMode, monthStartDay] = await Promise.all([
    getSetting('security.pin'), getSetting('security.webauthn'), biometricAvailable(),
    getSetting('reimburse.countAsIncome'),
    getSetting('budget.autoRenew'), getSetting('backup.auto'), getSetting('trash.retentionDays'),
    getSetting('theme.mode'),
    getSetting('accounting.monthStartDay'),
  ]);
  if (!el.isConnected) return;
  const voiceSettings = await bailianVoiceSettingsHtml();
  if (!el.isConnected) return;
  const currentAccountingMonth = await getAccountingMonth();
  const currentAccountingRange = await accountingMonthRange(currentAccountingMonth);
  if (!el.isConnected) return;
  // [R07] Android 使用系统通知；Web 使用首页应用内提醒。
  const [ntfRecurring, ntfCredit, ntfBackup] = await Promise.all([
    getSetting('notification.recurring'), getSetting('notification.creditCard'), getSetting('notification.backup'),
  ]);
  if (!el.isConnected) return;
  // [AI] AI 记账配置（OpenAI 兼容接口 + 静默入账阈值）
  const [aiBase, aiModel, aiKey, aiThreshold] = await Promise.all([
    getSetting('ai.baseUrl'), getSetting('ai.model'), secretStore.get('ai.apiKey'), getSetting('ai.autoConfirmThreshold'),
  ]);
  if (!el.isConnected) return;

  const freqChip = (val: 'off' | 'daily' | 'weekly', label: string) =>
    `<button class="chip${backupAuto === val ? ' active' : ''}" data-freq="${val}">${label}</button>`;

  const themeChip = (val: 'light' | 'dark' | 'system', label: string) =>
    `<button class="chip${themeMode === val ? ' active' : ''}" data-theme-mode="${val}">${label}</button>`;

  // [AI] 平台回显（按 baseUrl 前缀匹配，匹配不上=自定义）
  const providerId = matchProviderId(aiBase);
  const providerLabel = providerId !== 'custom'
    ? (AI_PROVIDERS.find((p) => p.id === providerId)?.name ?? '自定义')
    : '自定义';
  const modelLabel = aiModel || '选择模型';
  const selectedModel = modelPreset(aiBase, aiModel);

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
  el.innerHTML = `
    <section class="card" aria-label="安全">
      <h3 class="card-title">安全</h3>
      <div class="field"><span>应用锁（PIN 码）</span>${switchHtml('pin', !!pin, '应用锁')}</div>
      ${pin ? `<div class="field"><span>修改 PIN 码</span><button class="chip" data-act="change-pin">修改</button></div>` : ''}
      ${pin && bioOk ? `<div class="field"><span>Touch ID / 生物识别</span>${switchHtml('bio', !!webauthn, '生物识别解锁')}</div>` : ''}
    </section>

    <section class="card" aria-label="外观">
      <h3 class="card-title">外观</h3>
      <div class="field"><span>主题模式</span>
        <div class="chip-group">${themeChip('light', '浅色')}${themeChip('dark', '深色')}${themeChip('system', '跟随系统')}</div>
      </div>
    </section>

    <section class="card" aria-label="通知">
      <h3 class="card-title">通知</h3>
      <div class="field"><span>周期账入账提醒</span>${switchHtml('ntf-recurring', ntfRecurring as boolean, '周期账入账提醒')}</div>
      <div class="field"><span>信用卡还款日提醒</span>${switchHtml('ntf-credit', ntfCredit as boolean, '信用卡还款日提醒')}</div>
      <div class="field"><span>备份到期提醒</span>${switchHtml('ntf-backup', ntfBackup as boolean, '备份到期提醒')}</div>
      <div class="field"><span>提醒方式</span><span class="sub">${isNative ? '系统通知' : '首页提醒'}</span></div>
    </section>

    <section class="card" aria-label="记账偏好">
      <h3 class="card-title">记账偏好</h3>
      <div class="field"><span>报销到账记为收入</span>${switchHtml('reimburse', countAsIncome as boolean, '报销到账记为收入')}</div>
      <div class="field"><span>每月起始日</span>
        <button class="pick-trigger" id="accounting-month-start" type="button" aria-haspopup="listbox">每月 ${monthStartDay} 日</button>
      </div>
      <div class="field"><span>本期范围</span><span class="sub">${formatAccountingRange(currentAccountingRange)}</span></div>
      <div class="field"><span>预算自动延续到下月</span>${switchHtml('budget', autoRenew as boolean, '预算自动延续')}</div>
    </section>

    <section class="card" aria-label="备份">
      <h3 class="card-title">备份</h3>
      <div class="field"><span>备份提醒</span>
        <div class="chip-group">${freqChip('off', '关')}${freqChip('daily', '每日')}${freqChip('weekly', '每周')}</div>
      </div>
    </section>

    <section class="card" aria-label="数据">
      <h3 class="card-title">数据</h3>
      <div class="field"><span>回收站保留</span><span class="sub">${retention} 天后自动清除</span></div>
    </section>

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
        <label>模型名（可修改）<input id="ai-model" type="text" value="${esc(aiModel)}" placeholder="如 qwen3.8-flash / kimi-k3" autocomplete="off"></label>
        <div class="field"><span>识别类型</span><span class="sub" id="ai-model-capability">${selectedModel ? selectedModel.vision ? '图片、文字' : '文字' : '以接口为准'}</span></div>
        <label>API Key${aiKeyInputHtml(aiKey)}</label>
        <label>静默入账置信度阈值
          <div class="ai-thres"><input id="ai-thres" type="range" min="50" max="100" step="5" value="${aiThreshold}"><span class="num" id="ai-thres-val">${aiThreshold}%</span></div>
        </label>
      </div>
      <div class="field"><span>连通性</span>
        <div class="ai-actions">
          <button class="chip" data-act="ai-models">获取模型列表</button>
          <button class="chip" data-act="ai-test">测试连接</button>
        </div>
      </div>
    </section>

    ${voiceSettings}
    <section class="card" aria-label="关于">
      <h3 class="card-title">关于拾光</h3>
      <div class="field"><span>版本</span><span class="sub">v${APP_VERSION}</span></div>
      <div class="field"><span>使用手册</span><button class="chip" data-act="settings-manual">查看</button></div>
    </section>`;

  // 固定信息架构：记账偏好 → 数据与备份 → 智能能力与通知 → 外观与安全 → 关于。
  const order = ['记账偏好', '备份', '数据', 'AI 记账', '百炼短语音', '通知', '外观', '安全', '关于'];
  for (const label of order) {
    const section = el.querySelector<HTMLElement>(`section[aria-label="${label}"]`);
    if (section) el.appendChild(section);
  }
  restoreAiKeyDraft();
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
  if (el.dataset.revealAi) requestAnimationFrame(() => {
    if (!el.isConnected || !el.dataset.revealAi) return;
    delete el.dataset.revealAi;
    const section = el.querySelector<HTMLElement>('section[aria-label="AI 记账"]');
    // 只滚动设置内容，避免 scrollIntoView 同时移动外层、把返回栏卷走。
    if (section) el.scrollTop += section.getBoundingClientRect().top - el.getBoundingClientRect().top;
    const heading = section?.querySelector<HTMLElement>('h3');
    if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
  });
}

/* ── PIN 设置抽屉 ── */

/**
 * PIN 抽屉三种模式：set 首次设置 / change 修改（先验旧）/ off 关闭（先验旧）。
 */
function openPinSheet(mode: 'set' | 'change' | 'off'): void {
  const title = mode === 'set' ? '设置 PIN 码' : mode === 'change' ? '修改 PIN 码' : '关闭应用锁';
  openSheet({
    ariaLabel: title,
    onClose: () => sheetAbort?.abort(),
    render(el) {
      el.innerHTML = `
        <div class="sheet-head">
          <p class="sheet-title">${title}</p>
          <button class="icon-btn" data-act="close" aria-label="关闭">${iconHtml('ic-close')}</button>
        </div>
        <div class="sheet-scroll st-form">
          ${mode !== 'set' ? `<input type="password" inputmode="numeric" id="pin-old" placeholder="当前 PIN 码" autocomplete="off" maxlength="12">` : ''}
          ${mode !== 'off' ? `
          <input type="password" inputmode="numeric" id="pin-1" placeholder="新 PIN 码（4-12 位数字）" autocomplete="off" maxlength="12">
          <input type="password" inputmode="numeric" id="pin-2" placeholder="再次输入新 PIN 码" autocomplete="off" maxlength="12">` : ''}
          <p class="tiny" style="margin-bottom:8px">PIN 以加盐哈希保存在本机；忘记 PIN 将无法解锁，请牢记</p>
          <button class="btn primary" data-act="ok">${mode === 'off' ? '确认关闭' : '保存'}</button>
        </div>`;
      el.addEventListener('click', (e) => {
        const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
        if (act === 'close') closeSheet();
        else if (act === 'ok') {
          void (async () => {
            if (mode !== 'set') {
              const old = el.querySelector<HTMLInputElement>('#pin-old')!.value;
              if (!(await verifyPin(old))) { showToast('当前 PIN 码不正确'); return; }
            }
            if (mode === 'off') {
              await clearPin();
              closeSheet();
              showToast('应用锁已关闭');
            } else {
              const p1 = el.querySelector<HTMLInputElement>('#pin-1')!.value;
              const p2 = el.querySelector<HTMLInputElement>('#pin-2')!.value;
              if (!/^\d{4,12}$/.test(p1)) { showToast('PIN 码须为 4-12 位数字'); return; }
              if (p1 !== p2) { showToast('两次输入不一致'); return; }
              await setPin(p1);
              closeSheet();
              showToast(mode === 'set' ? '应用锁已开启' : 'PIN 码已修改');
            }
            void refresh();
          })();
        }
      }, { signal: sheetSignal() });
    },
  });
}

/* ── 装配 ── */

/** 注册设置子页（sp-settings），main.ts 调用一次 */
export function initSettings(): void {
  registerSubpage('sp-settings', {
    title: '设置',
    render(el) {
      body = el;
      mountVoiceConnectionTest(el);
      if (revealAiOnOpen) el.dataset.revealAi = 'true';
      el.addEventListener('click', (e) => {
        const t = e.target as HTMLElement;
        if (handleVoiceSettingsClick(t, el)) return;
        const sw = t.closest<HTMLElement>('[data-sw]')?.dataset.sw;
        const freq = t.closest<HTMLElement>('[data-freq]')?.dataset.freq as 'off' | 'daily' | 'weekly' | undefined;
        const themeMode = t.closest<HTMLElement>('[data-theme-mode]')?.dataset.themeMode as 'light' | 'dark' | 'system' | undefined;
        const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
        if (freq) {
          void setSetting('backup.auto', freq).then(() => refresh());
        } else if (themeMode) {
          // 主题切换：setSetting 后 core/theme.ts 监听 settings-changed 自动应用
          void setSetting('theme.mode', themeMode).then(() => refresh());
        } else if (act === 'settings-manual') {
          openSettingsManual();
        } else if (act === 'change-pin') {
          openPinSheet('change');
        } else if (act === 'ai-test') {
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
          void listAiModels(recentModels(matchProviderId(currentBase)).map(model => model.id))
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
                  input.focus();
                  return;
                }
                if (btn) btn.textContent = label;
                input.value = String(value);
                input.dispatchEvent(new Event('change', { bubbles: true }));
              },
            });
          })();
        } else if (t.closest('#accounting-month-start')) {
          openPickList({
            container: el,
            title: '选择每月起始日',
            items: Array.from({ length: 28 }, (_, index) => ({ value: index + 1, label: `每月 ${index + 1} 日` })),
            selected: Number(t.closest<HTMLButtonElement>('#accounting-month-start')?.textContent.match(/\d+/)?.[0] ?? 1),
            onPick(value) {
              void setAccountingMonthStartDay(Number(value))
                .then(() => { showToast('每月起始日已更新'); return refresh(); })
                .catch(err => showToast(err instanceof Error ? err.message : String(err)));
            },
          });
        } else if (sw === 'pin') {
          void getSetting('security.pin').then((pin) => openPinSheet(pin ? 'off' : 'set'));
        } else if (sw === 'bio') {
          void (async () => {
            const cur = await getSetting('security.webauthn');
            if (cur) {
              await setSetting('security.webauthn', null);
              showToast('已关闭生物识别解锁');
            } else {
              try {
                await enrollBiometric();
                showToast('生物识别解锁已启用');
              } catch {
                showToast('未能启用生物识别（已取消或设备不支持）');
              }
            }
            void refresh();
          })();
        } else if (sw === 'ntf-recurring' || sw === 'ntf-credit' || sw === 'ntf-backup') {
          // [R07] 通知开关：原生端首次开启先确保系统授权，拒绝则回退并引导
          const key = ({ 'ntf-recurring': 'notification.recurring', 'ntf-credit': 'notification.creditCard', 'ntf-backup': 'notification.backup' } as const)[sw];
          void (async () => {
            const cur = await getSetting(key);
            if (!cur && Capacitor.isNativePlatform() && !(await ensurePermission())) {
              showToast('未获得通知权限，请到系统设置中允许拾光发送通知');
              void refresh();
              return;
            }
            await setSetting(key, !cur);
            if (!Capacitor.isNativePlatform()) showToast(cur ? '已关闭首页应用内提醒' : '已开启，将在首页显示应用内提醒');
            void refresh();
          })();
        } else if (sw === 'reimburse' || sw === 'budget') {
          const key = ({ reimburse: 'reimburse.countAsIncome', budget: 'budget.autoRenew' } as const)[sw];
          void (async () => {
            const cur = await getSetting(key);
            await setSetting(key, !cur);
            void refresh();
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

  // 报销页等处修改同一 key 时保持双向同步
  on('settings-changed', () => void refresh());
}

