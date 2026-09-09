/**
 * 拾光 · 云端备份区（features/backup/cloudBackup）[R06+R09]
 * 挂载进备份页「云盘连接」原占位区：通道选择（无 / WebDAV / S3）、配置表单与测试连接、
 * 「上传到云端」（复用与本地备份完全相同的 .skbak 生成逻辑，含可选口令加密）、
 * 云端文件列表（下载恢复 / 删除）。
 * 红线：仅整包 .skbak 上传 / 下载 + 显式恢复，无任何增量同步；凭证只写 settings KV，
 * 不出现在日志与错误消息中。
 */
import { Capacitor } from '@capacitor/core';
import { iconHtml } from '../../assets/icons';
import { esc } from '../../core/esc';
import { addBackupRecord, exportAll, sanitizeDumpForBackup } from '../../core/repo/backupRepo';
import { getSetting, setSetting } from '../../core/repo/settingsRepo';
import { secretStore } from '../../core/secretStore';
import { openSheet, closeSheet } from '../shell/sheet';
import { confirmDialog } from '../shell/dialog';
import { showToast } from '../shell/toast';
import { backupFileName, buildSkbak } from './skbak';
import { buildCurrentProvider, CloudError, type BackupProvider, type CloudFile } from './provider';
import { createWebdavProvider } from './providers/webdav';

/** 上传前警告阈值：50MB（原生桥 base64 转发的内存风险） */
const UPLOAD_WARN_BYTES = 50 * 1048576;
/** 云端列表最多展示条数 */
const LIST_LIMIT = 10;

/** 宿主注入的回调 */
export interface CloudBackupHooks {
  /** 上传 / 删除成功后通知备份页刷新状态卡与备份历史 */
  onChanged(): void;
  /** 复用备份页现有恢复五步流程（校验 → 确认 → 快照 → 替换 → 报告） */
  restoreFile(file: File): Promise<void>;
}

/* ── 模块状态 ── */
let mountToken = 0;
let sheetAbort: AbortController | undefined;

function sheetSignal(): AbortSignal {
  sheetAbort?.abort();
  sheetAbort = new AbortController();
  return sheetAbort.signal;
}

function fmtTime(ts: number): string {
  if (!ts) return '时间未知';
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtSize(bytes: number): string {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** CloudError 归一文案（其余异常统一兜底，不透传底层 message 以防泄露配置） */
function errText(err: unknown): string {
  if (err instanceof CloudError) return err.message;
  return '云端操作失败，请稍后重试';
}

function isJianguoyunWebdav(server: string): boolean {
  try { return new URL(server).hostname.toLowerCase() === 'dav.jianguoyun.com'; }
  catch { return false; }
}

/* ── 渲染 ── */

/** 表单字段描述：label + 设置对象内的字段名 */
const WEBDAV_FIELDS = [
  { key: 'server', label: '服务器地址', type: 'url', ph: '如 https://dav.jianguoyun.com/dav' },
  { key: 'username', label: '用户名', type: 'text', ph: '账号 / 邮箱' },
  { key: 'password', label: '密码', type: 'password', ph: '应用密码（坚果云需生成）' },
  { key: 'path', label: '备份目录', type: 'text', ph: '如 拾光备份' },
] as const;

const S3_FIELDS = [
  { key: 'endpoint', label: '服务地址', type: 'url', ph: '留空为 AWS；R2/MinIO/OSS 填自定义地址' },
  { key: 'region', label: 'Region', type: 'text', ph: '如 us-east-1 / auto' },
  { key: 'bucket', label: 'Bucket', type: 'text', ph: '存储桶名' },
  { key: 'accessKey', label: 'Access Key', type: 'text', ph: 'Access Key ID' },
  { key: 'secretKey', label: 'Secret Key', type: 'password', ph: 'Secret Access Key' },
  { key: 'prefix', label: '目录前缀', type: 'text', ph: '如 gleam-backup/' },
] as const;

function fieldRows(
  fields: readonly { key: string; label: string; type: string; ph: string }[],
  values: Record<string, string>,
): string {
  return fields.map((f) => `
    <label class="cb-field">
      <span>${f.label}</span>
      <input class="note" type="${f.type}" data-cb-field="${f.key}" value="${esc(values[f.key] ?? '')}"
        placeholder="${esc(f.ph)}" autocomplete="${f.type === 'password' ? 'new-password' : 'off'}"
        autocapitalize="off" spellcheck="false">
    </label>`).join('');
}

/**
 * 挂载云端备份区（backup.ts refresh 时调用；host 每次都是新节点，事件不重复绑定）。
 */
export function mountCloudBackup(host: HTMLElement, hooks: CloudBackupHooks): void {
  const token = ++mountToken;
  void (async () => {
    const [provKind, webdavCfg, s3Cfg, webdavPassword, s3AccessKey, s3SecretKey] = await Promise.all([
      getSetting('cloud.provider'), getSetting('cloud.webdav'), getSetting('cloud.s3'),
      secretStore.get('cloud.webdav.password'),
      secretStore.get('cloud.s3.accessKey'),
      secretStore.get('cloud.s3.secretKey'),
    ]);
    if (token !== mountToken || !host.isConnected) return;

    const chip = (val: 'none' | 'webdav' | 's3', label: string) =>
      `<button class="chip${provKind === val ? ' active' : ''}" data-cb-prov="${val}">${label}</button>`;
    const webHint = !Capacitor.isNativePlatform()
      ? `<p class="tiny cb-hint">${isJianguoyunWebdav(webdavCfg.server)
        ? '坚果云不允许浏览器跨域直连，请在 Android 端使用'
        : '浏览器版直连需要 WebDAV 服务器允许 CORS；如服务不支持，请在 Android 端使用'}</p>`
      : '';
    const form = provKind === 'webdav'
      ? fieldRows(WEBDAV_FIELDS, { ...webdavCfg, password: webdavPassword ?? '' } as unknown as Record<string, string>)
      : provKind === 's3'
        ? fieldRows(S3_FIELDS, { ...s3Cfg, accessKey: s3AccessKey ?? '', secretKey: s3SecretKey ?? '' } as unknown as Record<string, string>)
        : '';

    host.innerHTML = `
      <h3 class="card-title" style="padding:10px 2px 0">云端备份</h3>
      ${webHint}
      <div class="chip-group cb-provs" role="tablist" aria-label="云备份通道">
        ${chip('none', '不启用')}${chip('webdav', 'WebDAV')}${chip('s3', 'S3 兼容')}
      </div>
      ${provKind === 'none' ? `
        <p class="tiny" style="padding:4px 2px 10px">支持 WebDAV（坚果云 / 群晖 / Nextcloud）与 S3 兼容对象存储（R2 / MinIO / OSS）；上传的是完整备份包（.skbak），恢复需手动确认；${secretStore.kind === 'android-keystore' ? '凭证由 Android 系统 Keystore 加密保存' : '浏览器版凭证只在当前标签页会话中保留'}</p>
      ` : `
        <div class="cb-form">${form}</div>
        <div class="btn-row cb-actions">
          <button class="btn ghost" data-cb-act="test">测试连接</button>
          <button class="btn primary" data-cb-act="upload">上传到云端</button>
        </div>
        <p class="tiny" style="padding:2px 2px 6px">整包上传当前全部数据（.skbak，可选口令加密）；${secretStore.kind === 'android-keystore' ? '凭证由 Android 系统 Keystore 加密保存' : '浏览器版凭证仅保留在当前标签页会话'}，修改后点「测试连接」即保存</p>
        <div class="cb-list" id="cb-list"><p class="sub cb-list-state">正在加载云端列表…</p></div>
      `}`;

    bindEvents(host, hooks);
    if (provKind !== 'none') void loadList(host, token);
  })();
}

/** 读取表单当前值并持久化到 settings（测试 / 上传前调用），返回按表单构建的通道 */
async function saveFormAndBuild(host: HTMLElement): Promise<BackupProvider | undefined> {
  const kind = await getSetting('cloud.provider');
  const read = (key: string) =>
    host.querySelector<HTMLInputElement>(`[data-cb-field="${key}"]`)?.value.trim() ?? '';
  if (kind === 'webdav') {
    const cfg = { server: read('server'), username: read('username'), password: read('password'), path: read('path') };
    if (!cfg.server || !cfg.username || !cfg.password) { showToast('请先填写服务器地址、用户名与应用密码'); return undefined; }
    await Promise.all([
      setSetting('cloud.webdav', { ...cfg, password: '' }),
      cfg.password ? secretStore.set('cloud.webdav.password', cfg.password) : secretStore.remove('cloud.webdav.password'),
    ]);
    return createWebdavProvider(cfg);
  }
  if (kind === 's3') {
    const cfg = {
      endpoint: read('endpoint'), region: read('region'), bucket: read('bucket'),
      accessKey: read('accessKey'), secretKey: read('secretKey'), prefix: read('prefix'),
    };
    await Promise.all([
      setSetting('cloud.s3', { ...cfg, accessKey: '', secretKey: '' }),
      cfg.accessKey ? secretStore.set('cloud.s3.accessKey', cfg.accessKey) : secretStore.remove('cloud.s3.accessKey'),
      cfg.secretKey ? secretStore.set('cloud.s3.secretKey', cfg.secretKey) : secretStore.remove('cloud.s3.secretKey'),
    ]);
    if (!cfg.bucket || !cfg.accessKey || !cfg.secretKey) { showToast('请先填写 Bucket 与密钥'); return undefined; }
    const { createS3Provider } = await import('./providers/s3');
    return createS3Provider(cfg);
  }
  return undefined;
}

/* ── 云端列表 ── */

async function loadList(host: HTMLElement, token: number): Promise<void> {
  const box = host.querySelector<HTMLElement>('#cb-list');
  if (!box) return;
  try {
    const provider = await buildCurrentProvider();
    if (!provider) {
      if (token === mountToken && box.isConnected) {
        box.innerHTML = '<p class="sub cb-list-state">填写配置并「测试连接」后，这里会列出云端备份</p>';
      }
      return;
    }
    const files = await provider.list();
    if (token !== mountToken || !box.isConnected) return;
    renderList(box, files);
  } catch (err) {
    if (token !== mountToken || !box.isConnected) return;
    box.innerHTML = `<p class="sub cb-list-state cb-err">${esc(errText(err))}</p>`;
  }
}

function renderList(box: HTMLElement, files: CloudFile[]): void {
  if (!files.length) {
    box.innerHTML = '<p class="sub cb-list-state">云端还没有备份，点「上传到云端」生成第一份</p>';
    return;
  }
  const shown = files.slice(0, LIST_LIMIT);
  box.innerHTML = `
    <p class="tiny" style="padding:4px 2px">云端备份（最近 ${shown.length} 条${files.length > LIST_LIMIT ? ` / 共 ${files.length} 条` : ''}）</p>
    ${shown.map((f) => `
      <div class="row cb-file" data-cb-name="${esc(f.name)}">
        <span class="e-ic neutral">${iconHtml('ic-cloud', 18)}</span>
        <div class="e-main">
          <p class="e-title">${esc(f.name)}</p>
          <p class="e-meta">${fmtSize(f.size)} · ${fmtTime(f.lastModified)}</p>
        </div>
        <button class="restore-link" data-cb-dl>下载恢复</button>
        <button class="restore-link cb-del" data-cb-del aria-label="删除该云端备份">删除</button>
      </div>`).join('')}`;
}

/* ── 事件 ── */

function bindEvents(host: HTMLElement, hooks: CloudBackupHooks): void {
  host.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const prov = t.closest<HTMLElement>('[data-cb-prov]')?.dataset.cbProv as 'none' | 'webdav' | 's3' | undefined;
    const act = t.closest<HTMLElement>('[data-cb-act]')?.dataset.cbAct;
    const fileRow = t.closest<HTMLElement>('[data-cb-name]');
    const name = fileRow?.dataset.cbName;
    if (prov) {
      // 切换通道：settings-changed 触发备份页整体刷新并重挂载对应表单
      void setSetting('cloud.provider', prov);
    } else if (act === 'test') {
      void runTest(host);
    } else if (act === 'upload') {
      void (async () => {
        const provider = await saveFormAndBuild(host);
        if (provider) openUploadSheet(provider, hooks);
      })();
    } else if (name && t.closest('[data-cb-dl]')) {
      void downloadRestore(name, hooks);
    } else if (name && t.closest('[data-cb-del]')) {
      void deleteCloudFile(name, host, hooks);
    }
  });
}

/** 测试连接：先按表单保存配置，再走通道 test()，按类别提示结果 */
async function runTest(host: HTMLElement): Promise<void> {
  const btn = host.querySelector<HTMLButtonElement>('[data-cb-act="test"]');
  if (btn?.disabled) return;
  if (btn) { btn.disabled = true; btn.textContent = '测试中…'; }
  try {
    const provider = await saveFormAndBuild(host);
    if (!provider) return;
    const result = await provider.test();
    if (result?.directoryReady === false) {
      showToast('连接成功，备份目录将在首次上传时创建');
      const box = host.querySelector<HTMLElement>('#cb-list');
      if (box) box.innerHTML = '<p class="sub cb-list-state">连接成功，首次上传时将创建备份目录</p>';
    } else {
      showToast('连接成功，配置已保存');
      void loadList(host, mountToken);
    }
  } catch (err) {
    showToast(errText(err), 3200);
  } finally {
    if (btn?.isConnected) { btn.disabled = false; btn.textContent = '测试连接'; }
  }
}

/** 上传抽屉：与本地备份同一 .skbak 生成逻辑（可选口令），完成后写备份历史 */
function openUploadSheet(provider: BackupProvider, hooks: CloudBackupHooks): void {
  openSheet({
    ariaLabel: '上传备份到云端',
    onClose: () => sheetAbort?.abort(),
    render(el) {
      el.innerHTML = `
        <div class="sheet-head">
          <p class="sheet-title">上传备份到云端</p>
          <button class="icon-btn" data-act="close" aria-label="关闭">${iconHtml('ic-close')}</button>
        </div>
        <div class="sheet-scroll bk-form">
          <div class="field"><span>口令加密</span><button class="switch" role="switch" aria-checked="false" data-act="enc" aria-label="口令加密"></button></div>
          <div id="cb-pwd" hidden>
            <input class="note" type="password" id="cb-p1" placeholder="设置口令" autocomplete="new-password">
            <input class="note" type="password" id="cb-p2" placeholder="再次输入口令" autocomplete="new-password">
            <p class="tiny" style="margin-bottom:8px">⚠️ 口令不存储、不可找回：忘记口令将无法恢复该备份包</p>
          </div>
          <button class="btn primary" data-act="up">生成并上传</button>
          <p class="tiny" style="margin-top:8px">生成完整备份包（.skbak）并整包上传到云端目录，同名文件会被覆盖。备份包不包含云备份与 AI 接口的密钥，恢复后需重新填写</p>
        </div>`;
      el.addEventListener('click', (e) => {
        const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
        if (!act) return;
        if (act === 'close') closeSheet();
        else if (act === 'enc') {
          const sw = el.querySelector<HTMLElement>('[data-act="enc"]')!;
          const onNow = sw.classList.toggle('on');
          sw.setAttribute('aria-checked', String(onNow));
          el.querySelector<HTMLElement>('#cb-pwd')!.hidden = !onNow;
        } else if (act === 'up') {
          void (async () => {
            let password: string | undefined;
            if (el.querySelector('[data-act="enc"]')!.classList.contains('on')) {
              const p1 = el.querySelector<HTMLInputElement>('#cb-p1')!.value;
              const p2 = el.querySelector<HTMLInputElement>('#cb-p2')!.value;
              if (p1.length < 4) { showToast('口令至少 4 位'); return; }
              if (p1 !== p2) { showToast('两次输入的口令不一致'); return; }
              password = p1;
            }
            const btn = el.querySelector<HTMLButtonElement>('[data-act="up"]')!;
            btn.disabled = true;
            btn.textContent = '正在生成…';
            try {
              const dump = sanitizeDumpForBackup(await exportAll());
              const blob = await buildSkbak(dump, password);
              if (blob.size > UPLOAD_WARN_BYTES) {
                if (provider.kind === 'webdav' && Capacitor.getPlatform() === 'android') {
                  btn.disabled = false;
                  btn.textContent = '生成并上传';
                  showToast('Android WebDAV 单个备份包最大支持 50 MB，请改用本地备份或减少照片附件', 3600);
                  return;
                }
                const go = await confirmDialog({
                  title: '备份包较大',
                  message: `备份包 ${fmtSize(blob.size)}（超过 50MB），上传可能耗时较长且占用较多内存，建议清理照片附件后再备份。仍要继续上传吗？`,
                  okText: '继续上传',
                });
                if (!go) { btn.disabled = false; btn.textContent = '生成并上传'; return; }
              }
              btn.textContent = '正在上传…';
              const name = backupFileName();
              await provider.upload(name, blob);
              await addBackupRecord({
                fileName: name, size: blob.size, provider: provider.kind,
                entryCount: (dump.entries ?? []).length, encrypted: !!password,
              });
              await setSetting('backup.lastBackupAt', Date.now());
              closeSheet();
              showToast(`已上传到云端：${name}`);
              hooks.onChanged();
            } catch (err) {
              showToast(errText(err), 3200);
              btn.disabled = false;
              btn.textContent = '生成并上传';
            }
          })();
        }
      }, { signal: sheetSignal() });
    },
  });
}

/** 下载云端备份并交给现有恢复五步流程（流程内含二次确认与前置快照） */
async function downloadRestore(name: string, hooks: CloudBackupHooks): Promise<void> {
  try {
    const provider = await buildCurrentProvider();
    if (!provider) { showToast('云备份配置不完整，请先测试连接'); return; }
    showToast('正在下载云端备份…');
    const blob = await provider.download(name);
    await hooks.restoreFile(new File([blob], name, { type: 'application/octet-stream' }));
  } catch (err) {
    showToast(errText(err), 3200);
  }
}

/** 删除云端文件（二次确认；只删云端，不动本地备份历史） */
async function deleteCloudFile(name: string, host: HTMLElement, hooks: CloudBackupHooks): Promise<void> {
  const ok = await confirmDialog({
    title: '删除云端备份？',
    message: `将从云端删除「${name}」，此操作不可恢复（本机数据与本地备份不受影响）。`,
    okText: '删除',
    danger: true,
  });
  if (!ok) return;
  try {
    const provider = await buildCurrentProvider();
    if (!provider) { showToast('云备份配置不完整，请先测试连接'); return; }
    await provider.delete(name);
    showToast('已删除云端备份');
    void loadList(host, mountToken);
    hooks.onChanged();
  } catch (err) {
    showToast(errText(err), 3200);
  }
}
