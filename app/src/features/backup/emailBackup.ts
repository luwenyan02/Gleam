import { esc } from '../../core/esc';
import { iconHtml } from '../../assets/icons';
import { getSetting, setSetting } from '../../core/repo/settingsRepo';
import { addBackupRecord, exportAll, sanitizeDumpForBackup } from '../../core/repo/backupRepo';
import { secretStore } from '../../core/secretStore';
import { openSheet, closeSheet } from '../shell/sheet';
import { showToast } from '../shell/toast';
import { backupFileName, buildSkbak } from './skbak';
import { sendEmailBackup, testEmailService, validateEmailConfig, type EmailConfig } from './emailTransport';

let currentHost: HTMLElement | undefined;
let busy = false;

function setBusy(value: boolean): void {
  busy = value;
  currentHost?.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button').forEach(el => { el.disabled = value; });
}

export function mountEmailBackup(host: HTMLElement, onChanged: () => void): void {
  currentHost = host;
  void (async () => {
    try {
      const [cfg, token] = await Promise.all([getSetting('cloud.email'), secretStore.get('cloud.email.token')]);
      if (currentHost !== host || !host.isConnected) return;
      host.innerHTML = `
        <h3 class="card-title">邮箱备份</h3>
        <p class="tiny eb-hint">通过你配置的邮件服务发送到邮箱，支持 QQ 邮箱。备份使用口令加密。</p>
        <div class="cb-form">
          <label class="cb-field"><span>邮件服务地址</span><input class="note" type="url" data-email="endpoint" value="${esc(cfg.endpoint)}" placeholder="https://mail.example.com" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
          <label class="cb-field"><span>服务访问令牌</span><input class="note" type="password" data-email="token" value="${esc(token ?? '')}" placeholder="填写邮件服务令牌，不是 QQ 邮箱授权码" autocomplete="new-password"></label>
          <label class="cb-field"><span>收件邮箱</span><input class="note" type="email" data-email="recipient" value="${esc(cfg.recipient)}" placeholder="可填写自己的 QQ 邮箱" autocomplete="email" autocapitalize="off" spellcheck="false"></label>
        </div>
        <div class="btn-row cb-actions"><button class="btn ghost" data-email-act="test">保存并测试</button><button class="btn primary" data-email-act="send">发送备份</button></div>
        <p class="tiny eb-hint">测试连接不会发邮件。单份备份最大 10 MB；收到后下载附件，在「从备份文件恢复」中导入。</p>
        <p class="tiny">${secretStore.kind === 'android-keystore' ? '访问令牌由 Android 系统加密保存。' : '访问令牌仅保留在当前标签页会话。'}QQ 邮箱授权码在邮件服务端配置。</p>`;
      setBusy(busy);
      host.addEventListener('click', event => {
        const action = (event.target as HTMLElement).closest<HTMLElement>('[data-email-act]')?.dataset.emailAct;
        if (!action || busy) return;
        const read = (key: string) => host.querySelector<HTMLInputElement>(`[data-email="${key}"]`)!.value.trim();
        try {
          const auth = read('token');
          const config = validateEmailConfig({ endpoint: read('endpoint'), recipient: read('recipient') }, auth);
          if (action === 'send') openEmailSheet(config, auth, onChanged);
          else void testAndSave(config, auth);
        } catch (error) { showToast((error as Error).message, 3600); }
      });
    } catch { if (currentHost === host) host.innerHTML = '<p class="tiny">邮箱配置读取失败，请重新打开备份页。</p>'; }
  })();
}

async function saveConfig(config: EmailConfig, token: string): Promise<void> {
  await secretStore.set('cloud.email.token', token);
  await setSetting('cloud.email', config);
}

async function testAndSave(config: EmailConfig, token: string): Promise<void> {
  setBusy(true);
  let connected = false;
  try {
    await testEmailService(config, token);
    connected = true;
    await saveConfig(config, token);
    showToast('QQ 邮箱连接成功，配置已保存；未发送邮件', 3600);
  } catch (error) {
    showToast(connected ? '连接成功，但本机配置保存失败，请重试' : (error as Error).message, 3600);
  } finally { setBusy(false); }
}

function openEmailSheet(config: EmailConfig, token: string, onChanged: () => void): void {
  let alive = true;
  let prepared: { blob: Blob; name: string; requestId: string; entryCount: number } | undefined;
  openSheet({
    ariaLabel: '发送邮箱备份', onClose: () => { alive = false; },
    render(el) {
      el.innerHTML = `
        <div class="sheet-head"><p class="sheet-title">发送邮箱备份</p><button class="icon-btn" data-email-close aria-label="关闭">${iconHtml('ic-close')}</button></div>
        <div class="sheet-scroll bk-form">
          <p class="eb-destination">收件邮箱：<b>${esc(config.recipient)}</b></p>
          <p class="tiny eb-destination">通过 ${esc(new URL(config.endpoint).host)} 发送完整加密备份。</p>
          <label class="cb-field"><span>备份口令</span><input class="note" type="password" id="email-p1" placeholder="至少 8 位" autocomplete="new-password"></label>
          <label class="cb-field"><span>确认口令</span><input class="note" type="password" id="email-p2" placeholder="再次输入备份口令" autocomplete="new-password"></label>
          <p class="tiny">口令不会随邮件发送，也不会保存；忘记口令将无法恢复。备份不包含云端及 AI 密钥。</p>
          <p class="tiny eb-result" role="status" aria-live="polite"></p>
          <button class="btn primary" data-email-confirm>生成并发送</button>
        </div>`;
      el.querySelector('[data-email-close]')!.addEventListener('click', () => closeSheet());
      el.querySelectorAll('input').forEach(input => input.addEventListener('input', () => {
        if (!busy) el.querySelector<HTMLElement>('.eb-result')!.textContent = '';
      }));
      el.querySelector('[data-email-confirm]')!.addEventListener('click', () => {
        if (busy) return;
        const p1 = el.querySelector<HTMLInputElement>('#email-p1')!;
        const p2 = el.querySelector<HTMLInputElement>('#email-p2')!;
        const result = el.querySelector<HTMLElement>('.eb-result')!;
        if (!prepared && p1.value.length < 8) { result.textContent = '备份口令至少 8 位'; return; }
        if (!prepared && p1.value !== p2.value) { result.textContent = '两次输入的口令不一致'; return; }
        const password = p1.value;
        const btn = el.querySelector<HTMLButtonElement>('[data-email-confirm]')!;
        btn.disabled = true; p1.disabled = true; p2.disabled = true;
        setBusy(true);
        result.textContent = '正在生成并发送，请稍候…';
        void (async () => {
          let accepted = false;
          let sending = false;
          try {
            if (!prepared) {
              const dump = sanitizeDumpForBackup(await exportAll());
              prepared = {
                blob: await buildSkbak(dump, password), name: backupFileName(),
                requestId: crypto.randomUUID(), entryCount: (dump.entries ?? []).length,
              };
              p1.value = ''; p2.value = '';
            }
            sending = true;
            await sendEmailBackup(config, token, prepared.blob, prepared.name, prepared.requestId);
            accepted = true;
            await addBackupRecord({ fileName: prepared.name, size: prepared.blob.size, provider: 'email', entryCount: prepared.entryCount, encrypted: true });
            await setSetting('backup.lastBackupAt', Date.now());
            await saveConfig(config, token);
            if (alive) closeSheet();
            showToast('邮件服务器已接收备份，请检查收件箱或垃圾邮件', 5000);
            onChanged();
          } catch (error) {
            const message = accepted ? '邮件服务器已接收备份，但本机记录或配置保存失败；请检查收件箱，不要重复发送'
              : sending ? (error as Error).message : '备份生成失败，请重试或使用本地备份';
            if (alive) {
              result.textContent = message;
              btn.disabled = accepted;
              btn.textContent = prepared ? '重试同一备份' : '生成并发送';
              if (!prepared) { p1.disabled = false; p2.disabled = false; }
            } else showToast(message, 5000);
          } finally { setBusy(false); }
        })();
      });
    },
  });
}
