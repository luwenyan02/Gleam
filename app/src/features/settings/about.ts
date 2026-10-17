import './about.css';
import { iconHtml } from '../../assets/icons';
import { aboutVersionText, type AppVersionInfo } from '../../core/appVersion';
import { esc } from '../../core/esc';
import { closeSheet, openSheet } from '../shell/sheet';
import { appUpdate, supportsAppUpdate, updateError, type AppUpdate } from './appUpdate';

export function openAbout(info: AppVersionInfo): void {
  const android = supportsAppUpdate();
  let alive = true, busy = false, ready = false, downloaded = false;
  let requestId = '';
  let update: AppUpdate | undefined;
  const events = new AbortController();
  openSheet({
    ariaLabel: '关于拾光',
    onClose() {
      alive = false; events.abort();
      if (busy && requestId) void appUpdate.cancel({ requestId }).catch(() => {});
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

          </div>` : ''}
        </div>`;
      el.querySelector('[data-update-close]')!.addEventListener('click', closeSheet, { signal: events.signal });
      if (!android) return;
      const find = <T extends HTMLElement>(name: string) => el.querySelector<T>(`[data-update-${name}]`)!;
      const status = (text: string) => { if (alive) find('status').textContent = text; };
      const sync = () => {
        if (!alive) return;
        find<HTMLButtonElement>('check').disabled = busy || !ready;
        find<HTMLButtonElement>('check').textContent = busy ? '处理中…' : '检查新版';
        find('cancel').hidden = !busy;
        find('release').hidden = !update?.available;
        find<HTMLButtonElement>('download').disabled = busy;
        find('download').hidden = downloaded;
        find<HTMLButtonElement>('install').disabled = busy;
        find('install').hidden = !downloaded;
      };
      const run = async (text: string, action: (id: string) => Promise<void>) => {
        if (busy || !ready) return;
        busy = true; requestId = crypto.randomUUID(); status(text); sync();
        try { await action(requestId); }
        catch (error) { status(updateError(error)); }
        finally { busy = false; sync(); }
      };
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
      void appUpdate.configuration().then(() => {
        if (!alive) return;
        ready = true;
        status('点击检查新版安装包'); sync();
      }).catch(error => status(updateError(error)));
    },
  });
}
