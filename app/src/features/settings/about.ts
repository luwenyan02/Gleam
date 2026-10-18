import './about.css';
import type { PluginListenerHandle } from '@capacitor/core';
import { iconHtml } from '../../assets/icons';
import { aboutVersionText, type AppVersionInfo } from '../../core/appVersion';
import { esc } from '../../core/esc';
import { closeSheet, openSheet } from '../shell/sheet';
import { appUpdate, supportsAppUpdate, updateError, updateProgress, type AppUpdate } from './appUpdate';

type UpdateAction = 'check' | 'download' | 'install';
type Operation = 'restore' | 'check' | 'download' | 'install' | 'config';

export function openAbout(info: AppVersionInfo): void {
  const android = supportsAppUpdate();
  let alive = true, busy = true, ready = false, hasToken = false;
  let action: UpdateAction = 'check', operation: Operation | undefined = 'restore';
  let requestId = '', progress = 0;
  let update: AppUpdate | undefined;
  let progressListener: PluginListenerHandle | undefined;
  const events = new AbortController();
  const stopProgress = () => {
    const listener = progressListener; progressListener = undefined;
    if (listener) void listener.remove().catch(() => {});
  };
  openSheet({
    ariaLabel: '关于拾光',
    onClose() {
      alive = false; events.abort(); stopProgress();
      // Downloads may finish while About is closed. Reopening verifies the file first.
      if (busy && requestId && operation !== 'download') void appUpdate.cancel({ requestId }).catch(() => {});
      const input = document.querySelector<HTMLInputElement>('#update-token');
      if (input) input.value = '';
    },
    render(el) {
      el.innerHTML = `<div class="sheet-head"><h3 class="sheet-title">关于拾光</h3><button class="icon-btn" data-update-close aria-label="关闭关于拾光">${iconHtml('ic-close')}</button></div>
        <div class="sheet-scroll about-app">
          <p class="about-version">${esc(aboutVersionText(info))}</p>
          <p class="sub">记录，是为了被时间照亮</p>
          ${android ? `<div class="about-update">
            <button class="btn primary about-update-action" data-update-action disabled><span data-update-label>检查更新</span></button>
            <div class="about-update-progress" data-update-progress role="progressbar" aria-label="更新包下载进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" hidden></div>
            <p class="sub about-status" role="status" aria-live="polite" data-update-status>正在读取更新设置…</p>
            <section data-update-release hidden><h4 data-update-version></h4><p class="about-release-notes" data-update-notes></p>
              <button class="btn secondary" data-update-recheck>重新检查</button>
            </section>
            <button class="btn" data-update-cancel hidden>取消操作</button>
            <details data-update-config><summary>GitHub 访问设置</summary>
              <p class="sub">更新来源：luwenyan02/Gleam 的正式 Release。</p>
              <label for="update-token">只读 GitHub Token</label>
              <div class="about-token-input"><input id="update-token" type="password" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="255" placeholder="点击右侧粘贴" readonly disabled><button class="btn secondary" type="button" data-update-paste disabled>粘贴</button></div>
              <div class="about-token-actions"><button class="btn primary" data-update-save disabled>保存并验证</button><button class="btn secondary" data-update-clear hidden>移除 Token</button></div>
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
        const downloading = busy && operation === 'download';
        const main = find<HTMLButtonElement>('action');
        main.disabled = busy || !ready || (!hasToken && action !== 'install');
        main.setAttribute('aria-busy', String(busy));
        main.dataset.updateState = downloading ? 'downloading' : action;
        main.classList.toggle('downloading', downloading);
        main.style.setProperty('--update-progress', `${downloading ? progress : 0}%`);
        find('label').textContent = downloading ? `下载中 ${progress}%`
          : busy && operation === 'restore' ? '检查安装包…'
          : busy && operation === 'check' ? '检查中…'
          : busy && operation === 'install' ? '正在打开…'
          : ({ check: '检查更新', download: '下载更新', install: '更新' } as const)[action];
        find('progress').hidden = !downloading;
        find('progress').setAttribute('aria-valuenow', String(progress));
        token.disabled = busy || !ready;
        find<HTMLButtonElement>('paste').disabled = busy || !ready;
        find<HTMLButtonElement>('save').disabled = busy || !ready || !token.value.trim();
        find<HTMLButtonElement>('clear').disabled = busy || !ready;
        find('clear').hidden = !hasToken;
        find('cancel').hidden = !busy || operation === 'restore' || operation === 'install';
        find('release').hidden = !update?.available;
        find<HTMLButtonElement>('recheck').disabled = busy || !hasToken;
        token.placeholder = hasToken ? '已保存，可粘贴替换' : '点击右侧粘贴';
      };
      const reset = () => { action = 'check'; update = undefined; progress = 0; };
      const acceptRelease = (result: AppUpdate, downloaded = false) => {
        if (!result.available) { reset(); return; }
        if (!result.releaseId || !result.version || !Number.isFinite(result.size) || result.size! <= 0) throw new Error('Invalid update');
        update = result; action = downloaded ? 'install' : 'download';
        find('version').textContent = `发现新版 v${result.version}`;
        find('notes').textContent = result.notes || '此版本未提供更新说明。';
      };
      const run = async (kind: Operation, text: string, task: (id: string) => Promise<void>) => {
        if (busy || !ready) return;
        busy = true; operation = kind; requestId = crypto.randomUUID(); status(text); sync();
        try { await task(requestId); }
        catch (error) {
          if (!alive) return;
          const code = error && typeof error === 'object' && 'code' in error ? error.code : '';
          if (code === 'RECHECK' || (kind === 'install' && ['CHECKSUM', 'PACKAGE', 'SIGNATURE'].includes(String(code)))) reset();
          if (kind === 'download') progress = 0;
          status(updateError(error));
        } finally { busy = false; operation = undefined; sync(); }
      };
      const check = () => run('check', '正在检查 GitHub 正式发布…', async id => {
        reset(); sync();
        const result = await appUpdate.check({ requestId: id });
        if (!alive) return;
        acceptRelease(result);
        status(result.available ? `安装包 ${(result.size! / 1024 / 1024).toFixed(1)} MB，下载后将自动校验` : '当前已是最新版本');
      });
      find('paste').addEventListener('click', () => void run('config', '正在粘贴…', async () => {
        const result = await appUpdate.readClipboard();
        if (!alive) return;
        token.value = result.text.trim(); token.focus(); status('已粘贴，点击“保存并验证”');
      }), { signal: events.signal });
      find('save').addEventListener('click', () => void run('config', '正在验证仓库读取权限…', async id => {
        await appUpdate.saveToken({ requestId: id, token: token.value.trim() });
        if (!alive) return;
        token.value = ''; hasToken = true; reset();
        status('Token 已保存，可以检查更新'); find<HTMLDetailsElement>('config').open = false;
      }), { signal: events.signal });
      find('clear').addEventListener('click', () => void run('config', '正在移除 Token…', async id => {
        await appUpdate.clearToken({ requestId: id });
        if (!alive) return;
        token.value = ''; hasToken = false; reset(); status('Token 已移除');
      }), { signal: events.signal });
      find('recheck').addEventListener('click', () => { if (hasToken) void check(); }, { signal: events.signal });
      find('action').addEventListener('click', () => {
        if (busy || (!hasToken && action !== 'install')) return;
        if (action === 'check') { void check(); return; }
        if (action === 'install') {
          void run('install', '正在打开系统安装界面…', async id => {
            const result = await appUpdate.install({ requestId: id, releaseId: update!.releaseId! });
            status(result.permissionRequired ? '请允许拾光安装应用，返回后再次点击“更新”' : '已打开系统安装界面，请按提示操作');
          });
          return;
        }
        progress = 0;
        void run('download', '正在下载并校验安装包…', async id => {
          const releaseId = update!.releaseId!;
          const listener = await appUpdate.addListener('downloadProgress', event => {
            if (!alive || operation !== 'download' || requestId !== id) return;
            const next = updateProgress(progress, event, id, releaseId);
            if (next !== progress) { progress = next; sync(); }
          });
          if (!alive) { void listener.remove().catch(() => {}); return; }
          progressListener = listener;
          try {
            await appUpdate.download({ requestId: id, releaseId });
            if (!alive) return;
            progress = 100; action = 'install'; status('下载完成，点击“更新”安装新版');
          } finally { stopProgress(); }
        });
      }, { signal: events.signal });
      find('cancel').addEventListener('click', () => {
        if (busy) {
          status('正在取消…');
          void appUpdate.cancel({ requestId }).catch(error => status(updateError(error)));
        }
      }, { signal: events.signal });
      sync();
      void (async () => {
        try {
          let configurationError: unknown;
          try { hasToken = (await appUpdate.configuration()).hasToken; }
          catch (error) { configurationError = error; }
          if (!alive) return;
          requestId = crypto.randomUUID();
          status('正在检查已下载的安装包…');
          const restored = await appUpdate.restore({ requestId });
          if (!alive) return;
          if (restored.downloaded === true) acceptRelease(restored, true);
          else reset();
          find<HTMLDetailsElement>('config').open = !hasToken && action !== 'install';
          status(action === 'install' ? '安装包已就绪，点击“更新”安装新版'
            : configurationError ? updateError(configurationError) : hasToken ? '' : '请先配置只读 GitHub Token');
        } catch (error) { status(updateError(error)); }
        finally { ready = true; busy = false; operation = undefined; sync(); }
      })();
    },
  });
}
