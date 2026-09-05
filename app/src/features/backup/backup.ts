/**
 * 拾光 · 备份与恢复子页（features/backup，PRD 4.15 Web 适配版，覆盖 sp-backup）
 * 结构对照原型 index.html #page-backup（L767 起）：
 * 备份状态卡 → 云端备份（R06 WebDAV/S3，见 cloudBackup.ts）→ 自动备份设置 → 可撤销快照 → 备份历史 →
 * Excel 导出 → 挖财导入入口（向导在 features/import）。
 * 生成 .skbak 走 skbak.ts（可选口令加密）；恢复五步：
 * 选文件 → 校验 → 自动快照 → 事务化整库替换 → 完成报告。
 */
import './backup.css';
import { iconHtml } from '../../assets/icons';
import { esc } from '../../core/esc';
import { on } from '../../core/store';
import {
  addBackupRecord, countLocalStats, createSnapshot, exportAll, listBackupRecords,
  listSnapshots, restoreAll, sanitizeDumpForBackup, undoSnapshot,
} from '../../core/repo/backupRepo';
import { getSetting, setSetting } from '../../core/repo/settingsRepo';
import { registerSubpage } from '../shell/router';
import { openSheet, closeSheet } from '../shell/sheet';
import { confirmDialog } from '../shell/dialog';
import { showToast } from '../shell/toast';
import { backupFileName, buildSkbak, parseSkbak, sniffEncrypted, type SkbakManifest } from './skbak';
import { saveBlobFile } from './download';
import { exportMonthExcel } from './excel';
import { mountCloudBackup } from './cloudBackup';
import { openImportWizard } from '../import/import';
import { openMonthWheel } from '../../shared/dateTimeWheel';
import type { Entry } from '../../core/types';
import type { TableDump } from '../../core/repo/backupRepo';

/* ── 模块状态 ── */
let body: HTMLElement | undefined;
let refreshToken = 0;
/** #sheet 复用容器：重开抽屉前废止上次绑定 */
let sheetAbort: AbortController | undefined;
/** Excel 导出月份状态（年+月），切换时由 openMonthWheel 更新 */
let exMonth = { year: new Date().getFullYear(), month: new Date().getMonth() + 1 };
const fmtMonth = (ym: { year: number; month: number }) =>
  `${ym.year}年${String(ym.month).padStart(2, '0')}月`;

function sheetSignal(): AbortSignal {
  sheetAbort?.abort();
  sheetAbort = new AbortController();
  return sheetAbort.signal;
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtSize(bytes: number): string {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/* ── 页面渲染 ── */

async function refresh(): Promise<void> {
  const el = body;
  if (!el?.isConnected) return;
  const token = ++refreshToken;
  // [R09] 计数改走 countLocalStats（db 直接 count），避免每次刷新都全量导出附件 Blob
  const [counts, lastAt, auto, wifiOnly, records, snapshots] = await Promise.all([
    countLocalStats(), getSetting('backup.lastBackupAt'), getSetting('backup.auto'),
    getSetting('backup.wifiOnly'), listBackupRecords(), listSnapshots(),
  ]);
  if (token !== refreshToken || !el.isConnected) return;

  const freqChip = (val: 'off' | 'daily' | 'weekly', label: string) =>
    `<button class="chip${auto === val ? ' active' : ''}" data-freq="${val}">${label}</button>`;

  const curMonth = (() => {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() + 1 };
  })();
  exMonth = curMonth;

  el.innerHTML = `
    <section class="card backup-status">
      <span class="bs-ic">${iconHtml('ic-cloud', 26)}</span>
      <p class="big num">${counts.total.toLocaleString('zh-CN')} <small>条记录 · 本机 IndexedDB</small></p>
      <p class="sub">数据均保存在本机 · 上次备份 <b>${lastAt ? fmtTime(lastAt) : '从未备份'}</b></p>
      <div class="bs-stats" aria-label="本地数据概览">
        <span>账单 <b class="num">${counts.liveEntries.toLocaleString('zh-CN')}</b></span>
        <span>生活记录 <b class="num">${counts.liveLifeNotes.toLocaleString('zh-CN')}</b></span>
        <span>备份历史 <b class="num">${records.length}</b></span>
      </div>
      <button class="btn primary" data-act="backup">立即备份（下载 .skbak）</button>
      <p class="tiny" style="margin-top:8px">生成完整备份包（.skbak，可全量恢复），支持口令加密 · 保存到本机后可自行上传网盘</p>
      <button class="btn ghost" data-act="restore" style="margin-top:10px">从备份文件恢复…</button>
    </section>

    <section class="card list" id="cloud-backup" aria-label="云端备份"></section>

    <section class="card" aria-label="自动备份设置">
      <h3 class="card-title">自动备份</h3>
      <div class="field"><span>频率</span>
        <div class="chip-group">${freqChip('off', '关')}${freqChip('daily', '每日')}${freqChip('weekly', '每周')}</div>
      </div>
      <div class="field"><span>仅 Wi-Fi 下上传</span><button class="switch${wifiOnly ? ' on' : ''}" role="switch" aria-checked="${wifiOnly}" data-act="wifi" aria-label="仅 Wi-Fi 下上传"></button></div>
      <p class="tiny">网页版不能后台自动生成文件：到期时会在此页与首页提醒「该备份了」，点一下即可完成</p>
    </section>

    ${snapshots.length ? `
    <section class="card list" aria-label="可撤销快照">
      <h3 class="card-title" style="padding:10px 2px 0">可撤销快照（保留 7 天）</h3>
      ${snapshots.map((s) => `
        <div class="row"><span class="e-ic neutral">${iconHtml('ic-repeat', 18)}</span>
          <div class="e-main"><p class="e-title">${esc(s.label)}</p><p class="e-meta">${fmtTime(s.createdAt)} · ${s.counts.entries ?? 0} 条账单</p></div>
          <button class="restore-link" data-undo="${s.id}">撤销到此</button>
        </div>`).join('')}
      <p class="tiny" style="padding:6px 2px 10px">恢复/导入前自动创建；撤销即把全部数据回滚到该时点</p>
    </section>` : ''}

    <section class="card list" aria-label="备份历史">
      <h3 class="card-title" style="padding:10px 2px 0">备份历史</h3>
      ${records.length ? records.map((r) => `
        <div class="row"><span class="e-ic neutral">${iconHtml(r.encrypted ? 'ic-lock' : 'ic-file', 18)}</span>
          <div class="e-main"><p class="e-title">${esc(r.fileName)}</p><p class="e-meta">${fmtSize(r.size)} · ${r.provider === 'webdav' ? '已上传 WebDAV' : r.provider === 's3' ? '已上传 S3' : '已下载到本机'} · ${r.entryCount} 条账单${r.encrypted ? ' · 已加密' : ''}</p></div>
        </div>`).join('') : '<p class="sub" style="padding:8px 2px">还没有备份记录，点上方「立即备份」生成第一份</p>'}
      <p class="tiny" style="padding:6px 2px 10px">恢复为全量替换：会先自动创建当前数据的本地快照，7 天内可撤销</p>
    </section>

    <section class="card" aria-label="Excel 导出">
      <h3 class="card-title">Excel 导出</h3>
      <div class="bk-month">
        <button class="chip" id="bk-month" data-act="month-pick">${fmtMonth(exMonth)}</button>
        <button class="btn ghost" data-act="excel">导出 Excel</button>
      </div>
      <p class="tiny" style="margin-top:8px">拾光账单_YYYY-MM.xlsx · 与挖财模版同构 12 列，可再被下方导入器读回；退款账单以属性「退款」标注，读回时按普通支出入账（跨文件不保留退款关联）</p>
    </section>

    <section class="card" id="migrate-block" aria-label="账单导入">
      <h3 class="card-title">账单导入</h3>
      <div class="flt-row" role="tablist" aria-label="导入来源" style="margin-bottom:10px">
        <button class="chip active" data-src="wacai" role="tab" aria-selected="true">挖财 Excel</button>
        <button class="chip" data-src="wechat" role="tab">微信账单</button>
        <button class="chip" data-src="alipay" role="tab">支付宝账单</button>
      </div>
      <p class="sub" style="margin-bottom:10px">挖财导出为单张工作表，每行一条流水，「类型」列区分支出 / 收入 / 转账 / 借贷；拾光按下表逐列映射，导入本地数据库。</p>
      <table class="map-table">
        <thead><tr><th>挖财字段</th><th>拾光处理</th></tr></thead>
        <tbody>
          <tr><td>日期时间</td><td>记账时间（精确到分钟）</td></tr>
          <tr><td>类型</td><td>账单类型：支出 / 收入 / 转账 / 借贷</td></tr>
          <tr><td>类别</td><td>两级分类：「餐饮/早餐」按斜杠拆为大类＋小类，无斜杠自动匹配</td></tr>
          <tr><td>金额 / 币种</td><td>金额；外币按参考汇率折算并在备注保留原币种</td></tr>
          <tr><td>收付账户</td><td>账户；转账行「现金：-1.00, 微信钱包：+1.00」自动拆为转出 / 转入</td></tr>
          <tr><td>收付款人</td><td>借贷对象与往来金额（如「张三：+100.00」）</td></tr>
          <tr><td>参与人</td><td>多人分摊只记「自己」份额入账，完整分摊明细写入备注</td></tr>
          <tr><td>标签</td><td>标签，逗号分隔可多个</td></tr>
          <tr><td>商家</td><td>商家</td></tr>
          <tr><td>属性 / 备注</td><td>「已报销」→ 报销状态标记；「退款」→ 按普通支出入账并在备注标注；备注原样保留</td></tr>
        </tbody>
      </table>
      <div class="btn-row">
        <button class="btn ghost" data-act="pick-import">选择 Excel 文件</button>
        <button class="btn primary" disabled>开始导入</button>
      </div>
      <p class="tiny">支持 .xlsx / .xls · 导入前会自动创建一次本地快照，7 天内可撤销</p>
    </section>`;

  // [R06] 云端备份区挂载（内部自行异步加载配置与云端列表）
  const cloudHost = el.querySelector<HTMLElement>('#cloud-backup');
  if (cloudHost) {
    mountCloudBackup(cloudHost, {
      onChanged: () => void refresh(),
      restoreFile: runRestore,
    });
  }
}

/* ── 备份生成（可选口令） ── */

function openBackupSheet(): void {
  openSheet({
    ariaLabel: '生成备份',
    onClose: () => sheetAbort?.abort(),
    render(el) {
      el.innerHTML = `
        <div class="sheet-head">
          <p class="sheet-title">生成备份包</p>
          <button class="icon-btn" data-act="close" aria-label="关闭">${iconHtml('ic-close')}</button>
        </div>
        <div class="sheet-scroll bk-form">
          <div class="field"><span>口令加密</span><button class="switch" role="switch" aria-checked="false" data-act="enc" aria-label="口令加密"></button></div>
          <div id="bk-pwd" hidden>
            <input class="note" type="password" id="bk-p1" placeholder="设置口令" autocomplete="new-password">
            <input class="note" type="password" id="bk-p2" placeholder="再次输入口令" autocomplete="new-password">
            <p class="tiny" style="margin-bottom:8px">⚠️ 口令不存储、不可找回：忘记口令将无法恢复该备份包</p>
          </div>
          <button class="btn primary" data-act="gen">生成并下载</button>
          <p class="tiny" style="margin-top:8px">备份包不包含云备份与 AI 接口的密钥，恢复后需重新填写</p>
        </div>`;
      el.addEventListener('click', (e) => {
        const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
        if (!act) return;
        if (act === 'close') closeSheet();
        else if (act === 'enc') {
          const sw = el.querySelector<HTMLElement>('[data-act="enc"]')!;
          const onNow = sw.classList.toggle('on');
          sw.setAttribute('aria-checked', String(onNow));
          el.querySelector<HTMLElement>('#bk-pwd')!.hidden = !onNow;
        } else if (act === 'gen') {
          void (async () => {
            let password: string | undefined;
            if (el.querySelector('[data-act="enc"]')!.classList.contains('on')) {
              const p1 = el.querySelector<HTMLInputElement>('#bk-p1')!.value;
              const p2 = el.querySelector<HTMLInputElement>('#bk-p2')!.value;
              if (p1.length < 4) { showToast('口令至少 4 位'); return; }
              if (p1 !== p2) { showToast('两次输入的口令不一致'); return; }
              password = p1;
            }
            const btn = el.querySelector<HTMLButtonElement>('[data-act="gen"]')!;
            btn.disabled = true;
            btn.textContent = '正在生成…';
            try {
              const dump = sanitizeDumpForBackup(await exportAll());
              const blob = await buildSkbak(dump, password);
              const name = backupFileName();
              const savedTip = await saveBlobFile(blob, name);
              await addBackupRecord({
                fileName: name, size: blob.size, provider: 'local',
                entryCount: (dump.entries ?? []).length, encrypted: !!password,
              });
              await setSetting('backup.lastBackupAt', Date.now());
              closeSheet();
              showToast(savedTip || `备份已生成：${name}`);
              void refresh();
            } catch (err) {
              showToast(err instanceof Error ? err.message : String(err));
              btn.disabled = false;
              btn.textContent = '生成并下载';
            }
          })();
        }
      }, { signal: sheetSignal() });
    },
  });
}

/* ── 恢复五步 ── */

/** 加密包口令输入抽屉 */
function askPassword(): Promise<string | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    openSheet({
      ariaLabel: '输入备份口令',
      onClose: () => { sheetAbort?.abort(); if (!settled) { settled = true; resolve(undefined); } },
      render(el) {
        el.innerHTML = `
          <div class="sheet-head">
            <p class="sheet-title">该备份包已加密</p>
            <button class="icon-btn" data-act="close" aria-label="关闭">${iconHtml('ic-close')}</button>
          </div>
          <div class="sheet-scroll bk-form">
            <input class="note" type="password" id="rp-pwd" placeholder="输入备份口令" autocomplete="off">
            <p class="tiny" style="margin-bottom:8px">口令不存储、不可找回；输入错误将无法解密</p>
            <button class="btn primary" data-act="ok">解密并继续</button>
          </div>`;
        el.addEventListener('click', (e) => {
          const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
          if (act === 'close') closeSheet();
          else if (act === 'ok') {
            const v = el.querySelector<HTMLInputElement>('#rp-pwd')!.value;
            if (!v) { showToast('请输入口令'); return; }
            settled = true;
            closeSheet();
            resolve(v);
          }
        }, { signal: sheetSignal() });
      },
    });
  });
}

/** 恢复完成报告（时点 / 条数 / 时间范围） */
async function showRestoreReport(manifest: SkbakManifest, dump: TableDump): Promise<void> {
  const entries = (dump.entries ?? []) as Entry[];
  const live = entries.filter((e) => e.deletedAt === 0);
  let range = '无账单';
  if (live.length) {
    const ts = live.map((e) => e.occurredAt);
    const f = (t: number) => {
      const d = new Date(t);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };
    range = `${f(Math.min(...ts))} ~ ${f(Math.max(...ts))}`;
  }
  await confirmDialog({
    title: '恢复完成',
    message: `备份时点：${fmtTime(manifest.generatedAt)} · 账单 ${manifest.counts.entries ?? 0} 条（流水范围 ${range}）、账户 ${manifest.counts.accounts ?? 0} 个、生活记录 ${manifest.counts.lifeNotes ?? 0} 条。恢复前的数据已存为快照，7 天内可在本页撤销。`,
    okText: '好的',
    cancelText: '关闭',
  });
}

/** 恢复主流程：选文件 → 校验 → 快照 → 整库替换 → 报告 */
function pickRestoreFile(): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.skbak,application/octet-stream,application/zip';
  input.onchange = () => {
    const file = input.files?.[0];
    if (file) void runRestore(file);
  };
  input.click();
}

async function runRestore(file: File): Promise<void> {
  try {
    const buf = await file.arrayBuffer();
    let password: string | undefined;
    if (sniffEncrypted(buf)) {
      password = await askPassword();
      if (password === undefined) return; // 用户取消
    }
    // 第二步：校验（校验值 + schemaVersion + 口令）
    const { manifest, dump } = await parseSkbak(buf, password);
    const ok = await confirmDialog({
      title: '确认恢复此备份？',
      message: `备份时点 ${fmtTime(manifest.generatedAt)} · 账单 ${manifest.counts.entries ?? 0} 条。当前数据将被完全替换（恢复前会自动创建快照，7 天内可撤销）。`,
      okText: '恢复',
      danger: true,
    });
    if (!ok) return;
    // 第三步：自动快照
    await createSnapshot('restore', `恢复「${file.name}」前`);
    // 第四步：事务化整库替换（失败由 Dexie 回滚）
    await restoreAll(dump);
    // 第五步：完成报告
    await showRestoreReport(manifest, dump);
    void refresh();
  } catch (err) {
    void confirmDialog({
      title: '恢复未执行',
      message: err instanceof Error ? err.message : String(err),
      okText: '知道了',
      cancelText: '关闭',
    });
  }
}

/* ── 导入入口 ── */

function pickImportFile(): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.xls,.xlsx';
  input.onchange = () => {
    const file = input.files?.[0];
    if (file) void openImportWizard(file);
  };
  input.click();
}

/* ── 装配 ── */

/** 注册备份与恢复子页（sp-backup），main.ts 调用一次 */
export function initBackup(): void {
  registerSubpage('sp-backup', {
    title: '备份与恢复',
    render(el) {
      body = el;
      el.addEventListener('click', (e) => {
        const t = e.target as HTMLElement;
        const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
        const freq = t.closest<HTMLElement>('[data-freq]')?.dataset.freq as 'off' | 'daily' | 'weekly' | undefined;
        const undoId = t.closest<HTMLElement>('[data-undo]')?.dataset.undo;
        if (freq) {
          void setSetting('backup.auto', freq).then(() => refresh());
        } else if (undoId) {
          void (async () => {
            const ok = await confirmDialog({
              title: '撤销到该快照？',
              message: '当前全部数据将回滚到快照时点，之后记的账会丢失。',
              okText: '撤销',
              danger: true,
            });
            if (!ok) return;
            await undoSnapshot(Number(undoId));
            showToast('已撤销到快照时点');
            void refresh();
          })();
        } else if (t.closest('[data-src]') && t.closest<HTMLElement>('[data-src]')!.dataset.src !== 'wacai') {
          showToast('微信 / 支付宝账单导入即将支持，当前请使用挖财 Excel');
        } else if (act === 'backup') openBackupSheet();
        else if (act === 'restore') pickRestoreFile();
        else if (act === 'wifi') {
          void (async () => {
            const cur = await getSetting('backup.wifiOnly');
            await setSetting('backup.wifiOnly', !cur);
            void refresh();
          })();
        } else if (act === 'excel') {
          void (async () => {
            const month = `${exMonth.year}-${String(exMonth.month).padStart(2, '0')}`;
            if (!month) { showToast('请选择导出月份'); return; }
            const n = await exportMonthExcel(month);
            showToast(n ? `已导出 ${n} 条账单` : '该月没有账单，已导出空表');
          })();
        } else if (act === 'month-pick') {
          const today = new Date();
          const panel = openMonthWheel({
            initial: { year: exMonth.year, month: exMonth.month },
            maxDate: { year: today.getFullYear(), month: today.getMonth() + 1 },
            onConfirm(r) {
              exMonth = r;
              const chip = el.querySelector('#bk-month');
              if (chip) chip.textContent = fmtMonth(exMonth);
            },
          });
          document.body.appendChild(panel);
        } else if (act === 'pick-import') pickImportFile();
      });
      void refresh();
    },
    onShow() { void refresh(); },
  });

  // 数据变化时若备份页在前台则刷新统计
  on('entries-changed', () => void refresh());
  on('settings-changed', () => void refresh());
}
