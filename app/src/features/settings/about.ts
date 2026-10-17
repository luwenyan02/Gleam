import './about.css';
import { iconHtml } from '../../assets/icons';
import { aboutVersionText, type AppVersionInfo } from '../../core/appVersion';
import { esc } from '../../core/esc';
import { closeSheet, openSheet } from '../shell/sheet';
import { appUpdate, supportsAppUpdate, updateError, type AppUpdate } from './appUpdate';

export function openAbout(info: AppVersionInfo): void {
  const android = supportsAppUpdate();
  let alive = true, busy = false, ready = false, hasToken = false, downloaded = false;
  let requestId = '';
  let update: AppUpdate | undefined;
  const events = new AbortController();
  openSheet({
    ariaLabel: '关于拾光',
    onClose() {
      alive = false; events.abort();
      if (busy && requestId) void appUpdate.cancel({ requestId }).catch(() => {});
      const input = document.querySelector<HTMLInputElement>('#update-token');
      if (input) input.value = '';
    },
    render(el) {
      el.innerHTML = `<div class="sheet-head"><h3 class="sheet-title">关于拾光</h3><button class="icon-btn" data-update-close aria-label="关闭关于拾光">${iconHtml('ic-close')}</button></div>
        <div class="sheet-scroll about-app">
          <p class="about-version">${esc(aboutVersionText(info))}</p>
          <p class="sub">记录，是为了被时间照亮</p>
          ${android ? `<div class="about-update">
            <button class="btn primary" data-update-check disabled>检查新版</button>
            <p class="sub about-status" role="status" aria-live="polite" data-update-status>正在读取更新设置…</p>
            <section data-update-release hidden><h4 data-update-version></h4><p class="about-release-notes" data-update-notes></p>
              <button class="btn primary" data-update-download>下载更新</button>
              <button class="btn primary" data-update-install hidden>安装新版</button>
            </section>
            <button class="btn" data-update-cancel hidden>取消操作</button>
            <details data-update-config><summary>GitHub 访问设置</summary>
              <p class="sub">更新来源：luwenyan02/Gleam 的正式 Release。</p>
              <p class="sub">使用 Fine-grained Token，仅选择 Gleam 仓库，将 Contents 设为 Read-only。Token 仅在本机加密保存，不进入备份。</p>
              <label for="update-token">只读 GitHub Token</label>
              <div class="about-token-input"><input id="update-token" type="password" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="255" placeholder="粘贴或填写 Token" disabled><button class="btn" type="button" data-update-paste disabled>粘贴</button></div>
              <div class="about-token-actions"><button class="btn" data-update-save disabled>保存并验证</button><button class="btn" data-update-clear hidden>移除 Token</button></div>
            </details>
          </div>` : ''}
        </div>`;
      el.querySelector('[data-update-close]')!.addEventListener('click', closeSheet, { signal: events.signal });
      if (!android) return;
      const find = <T extends HTMLElement>(name: string) => el.querySelector<T>(`[data-update-${name}]`)!;
      const token = el.querySelector<HTMLInputElement>('#update-token')!;
      const status = (text: string) => { if (alive) find('status').textContent = text; };
      const sync = () => {
        if (!alive) return;
        find<HTMLButtonElement>('check').disabled = busy || !ready || !hasToken;
        find<HTMLButtonElement>('check').textContent = busy ? '处理中…' : '检查新版';
        token.disabled = busy || !ready;
        find<HTMLButtonElement>('paste').disabled = busy || !ready;
        find<HTMLButtonElement>('save').disabled = busy || !ready || !token.value.trim();
        find<HTMLButtonElement>('clear').disabled = busy || !ready;
        find('clear').hidden = !hasToken;
        find('cancel').hidden = !busy;
        find('release').hidden = !update?.available;
        find<HTMLButtonElement>('download').disabled = busy;
        find('download').hidden = downloaded;
        find<HTMLButtonElement>('install').disabled = busy;
        find('install').hidden = !downloaded;
        token.placeholder = hasToken ? '已保存，填写新 Token 可替换' : '粘贴或填写 Token';
      };
      const run = async (text: string, action: (id: string) => Promise<void>) => {
        if (busy || !ready) return;
        busy = true; requestId = crypto.randomUUID(); status(text); sync();
        try { await action(requestId); }
        catch (error) { status(updateError(error)); }
        finally { busy = false; sync(); }
      };
      token.addEventListener('input', sync, { signal: events.signal });
      find('paste').addEventListener('click', () => void run('正在粘贴…', async () => {
        const result = await appUpdate.readClipboard();
        if (!alive) return;
        token.value = result.text.trim();
        token.focus();
        status('已粘贴，点击“保存并验证”');
      }), { signal: events.signal });
      find('save').addEventListener('click', () => void run('正在验证仓库读取权限…', async id => {
        await appUpdate.saveToken({ requestId: id, token: token.value.trim() });
        if (!alive) return;
        token.value = ''; hasToken = true; update = undefined; downloaded = false;
        status('Token 已保存，可以检查新版'); find<HTMLDetailsElement>('config').open = false;
      }), { signal: events.signal });
      find('clear').addEventListener('click', () => void run('正在移除 Token…', async id => {
        await appUpdate.clearToken({ requestId: id });
        if (!alive) return;
        token.value = ''; hasToken = false; update = undefined; downloaded = false;
        status('Token 已移除');
      }), { signal: events.signal });
      find('check').addEventListener('click', () => void run('正在检查 GitHub 正式发布…', async id => {
        update = undefined; downloaded = false; sync();
        const result = await appUpdate.check({ requestId: id });
        if (!alive) return;
        update = result;
        if (!result.available) { status('当前已是最新版本'); return; }
        if (!result.releaseId || !result.version || !result.size) throw new Error('Invalid update');
        find('version').textContent = `发现新版 v${result.version}`;
        find('notes').textContent = result.notes || '此版本未提供更新说明。';
        find('download').textContent = `下载更新（${(result.size / 1024 / 1024).toFixed(1)} MB）`;
        status('下载后校验安装包，再由系统确认安装');
      }), { signal: events.signal });
      find('download').addEventListener('click', () => void run('正在下载并校验安装包…', async id => {
        await appUpdate.download({ requestId: id, releaseId: update!.releaseId! });
        if (!alive) return;
        downloaded = true; status('校验通过，可以安装新版');
      }), { signal: events.signal });
      find('install').addEventListener('click', () => void run('正在打开系统安装界面…', async id => {
        const result = await appUpdate.install({ requestId: id, releaseId: update!.releaseId! });
        status(result.permissionRequired ? '请允许拾光安装应用，返回后再次点击“安装新版”' : '已打开系统安装界面，请按提示操作');
      }), { signal: events.signal });
      find('cancel').addEventListener('click', () => {
        if (busy) {
          status('正在取消…');
          void appUpdate.cancel({ requestId }).catch(error => status(updateError(error)));
        }
      }, { signal: events.signal });
      void appUpdate.configuration().then(config => {
        if (!alive) return;
        ready = true; hasToken = config.hasToken;
        find<HTMLDetailsElement>('config').open = !hasToken;
        status(hasToken ? '点击检查 GitHub 上的新版安装包' : '请先配置只读 GitHub Token'); sync();
      }).catch(error => status(updateError(error)));
    },
  });
}
