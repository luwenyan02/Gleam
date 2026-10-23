/**
 * 拾光 · 设置与安全子页（features/settings，PRD 4.19，覆盖 sp-settings）
 * 分区顺序：记账偏好 → 数据与备份 → 智能能力与通知 → 外观与安全。
 * 入口：我的页右上角齿轮（data-sub="sp-settings"，M1 已接）。
 */
import './settings.css';
import { Capacitor } from '@capacitor/core';
import { iconHtml } from '../../assets/icons';
import { on } from '../../core/store';
import { getSetting, setSetting } from '../../core/repo/settingsRepo';
import { ensurePermission } from '../../core/notify';
import { registerSubpage, SUBPAGE_CLOSE_EVENT } from '../shell/router';
import { openSheet, closeSheet } from '../shell/sheet';
import { showToast } from '../shell/toast';
import {
  setPin, verifyPin, clearPin, biometricAvailable, enrollBiometric,
} from './lock';
import { openPickList } from '../../shared/pickList';
import {
  accountingMonthRange, getAccountingMonth, setAccountingMonthStartDay,
} from '../../core/repo/periodRepo';
import { formatAccountingRange } from '../../core/period';


let body: HTMLElement | undefined;
let sheetAbort: AbortController | undefined;
let settingsRefreshToken = 0;

export { openAiSettings } from './aiSettings';
import { initAiSettings, openAiSettings } from './aiSettings';

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
  const isNative = Capacitor.isNativePlatform();
  const [pin, webauthn, bioOk, countAsIncome, autoRenew, retention, themeMode, monthStartDay] = await Promise.all([
    getSetting('security.pin'), getSetting('security.webauthn'), biometricAvailable(),
    getSetting('reimburse.countAsIncome'),
    getSetting('budget.autoRenew'), getSetting('trash.retentionDays'),
    getSetting('theme.mode'),
    getSetting('accounting.monthStartDay'),
  ]);
  if (!el.isConnected) return;
  const currentAccountingMonth = await getAccountingMonth();
  const currentAccountingRange = await accountingMonthRange(currentAccountingMonth);
  if (!el.isConnected) return;
  // [R07] Android 使用系统通知；Web 使用首页应用内提醒。
  const [ntfRecurring, ntfCredit] = await Promise.all([
    getSetting('notification.recurring'), getSetting('notification.creditCard'),
  ]);
  if (!el.isConnected) return;
  const themeChip = (val: 'light' | 'dark' | 'system', label: string) =>
    `<button class="chip${themeMode === val ? ' active' : ''}" data-theme-mode="${val}">${label}</button>`;

  if (token !== settingsRefreshToken || !el.isConnected) return;
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

    <section class="card" aria-label="数据">
      <h3 class="card-title">数据</h3>
      <div class="field"><span>回收站保留</span><span class="sub">${retention} 天后自动清除</span></div>
    </section>

    <section class="card" aria-label="智能能力">
      <button class="settings-ai-entry" type="button" data-act="ai-settings" aria-label="AI 配置">
        <span><strong>AI 配置</strong><span class="sub">AI 记账 · 百炼短语音</span></span>
        ${iconHtml('ic-right')}
      </button>
    </section>`;

  // 固定信息架构：记账偏好 → 数据与备份 → 智能能力与通知 → 外观与安全。
  const order = ['记账偏好', '备份', '数据', '智能能力', '通知', '外观', '安全'];
  for (const label of order) {
    const section = el.querySelector<HTMLElement>(`section[aria-label="${label}"]`);
    if (section) el.appendChild(section);
  }
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
          <p class="settings-status" style="margin-bottom:8px">忘记 PIN 将无法解锁，请牢记。</p>
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
  initAiSettings();
  registerSubpage('sp-settings', {
    title: '设置',
    render(el) {
      body = el;
      el.closest('.subpage')?.addEventListener(SUBPAGE_CLOSE_EVENT, () => {
        if (body === el) { body = undefined; settingsRefreshToken++; }
      }, { once: true });
      el.addEventListener('click', (e) => {
        const t = e.target as HTMLElement;
        const sw = t.closest<HTMLElement>('[data-sw]')?.dataset.sw;
        const themeMode = t.closest<HTMLElement>('[data-theme-mode]')?.dataset.themeMode as 'light' | 'dark' | 'system' | undefined;
        const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
        if (themeMode) {
          // 主题切换：setSetting 后 core/theme.ts 监听 settings-changed 自动应用
          void setSetting('theme.mode', themeMode).then(() => refresh());

        } else if (act === 'change-pin') {
          openPinSheet('change');
        } else if (act === 'ai-settings') {
          openAiSettings();
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
        } else if (sw === 'ntf-recurring' || sw === 'ntf-credit') {
          // [R07] 通知开关：原生端首次开启先确保系统授权，拒绝则回退并引导
          const key = ({ 'ntf-recurring': 'notification.recurring', 'ntf-credit': 'notification.creditCard' } as const)[sw];
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
      void refresh();
    },
    onShow() { void refresh(); },
  });

  // 报销页等处修改同一 key 时保持双向同步
  on('settings-changed', (payload) => {
    const key = (payload as { key?: string } | undefined)?.key ?? '';
    if (!key.startsWith('ai.') && !key.startsWith('voice.')) void refresh();
  });
}

