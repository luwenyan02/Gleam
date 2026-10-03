/**
 * 拾光 · AI 记账收件箱（features/ai-inbox，sp-ai-inbox 子页，自动记账一期）
 * 顶部文本粘贴 + 选图（Web 端与手动兜底入口）→ 素材入队 → 串行调 aiRepo 识别 →
 * 按状态分区卡片流（识别中 / 待确认可内联编辑 / 失败可重试）。
 * 高置信度（≥ 'ai.autoConfirmThreshold' 且分类/账户映射成功且未命中查重）静默入账；
 * 其余人工确认。入账统一走 entryRepo.importEntriesBatch(source:'ai')，
 * 「撤销本批」按 importBatchId 逐条 softDeleteEntry（复用回收站 30 天恢复）。
 * 队列持久化在 settings 'ai.pendingItems'（KV），UI 监听 'settings-changed' 刷新。
 */
import './aiInbox.css';
import { iconHtml } from '../../assets/icons';
import { esc } from '../../core/esc';
import { formatFen, formatFenCny, parseYuanToFen } from '../../core/money';
import { entryIdentity } from '../../core/entryIdentity';
import { canAutoConfirmAiItem } from '../../core/aiInboxPolicy';
import type { AiPendingItem, Account, Category } from '../../core/types';
import { on } from '../../core/store';
import { getSetting } from '../../core/repo/settingsRepo';
import { secretStore } from '../../core/secretStore';
import { listCategories } from '../../core/repo/categoryRepo';
import { listAccounts } from '../../core/repo/accountRepo';
import { ensureMerchant, touchMerchant } from '../../core/repo/merchantRepo';
import { saveImportAtomically } from '../../core/repo/importSaveRepo';
import {
  findDuplicates, importEntriesBatch, listEntries, softDeleteEntry,
  type ImportEntryItem, type NewEntry,
} from '../../core/repo/entryRepo';
import {
  AiConfigError, addAiPendingItems, getAiAttachment, listAiBatches, listAiPendingItems,
  mapAccountNameToId, mapCategoryNameToId, recognizeImage, recognizeText,
  removeAiPendingItems, replaceAiPendingItem, resetStuckRecognizing, saveAiAttachment,
  updateAiPendingItem, type AiParsedBill,
} from '../../core/repo/aiRepo';
import { registerSubpage, openSubpage } from '../shell/router';
import { showToast } from '../shell/toast';
import { openEntrySheet } from '../entry/entrySheet';
import { openDateTimeWheel } from '../../shared/dateTimeWheel';
import { openPickList, type PickListItem } from '../../shared/pickList';

/* ── 模块状态 ── */

let body: HTMLElement | undefined;
/** shell 挂载完成标记（分享事件可能早于 mountShell 到达，先缓冲再打开） */
let inboxReady = false;
let pendingOpen = false;
/** 识别串行执行守卫 */
let recognizeRunning = false;
/** 并发刷新令牌 */
let refreshToken = 0;
/** 卡片图片预览 object URL，重渲染前统一回收 */
let previewUrls: string[] = [];
/** 「疑似重复仍要入账」二次确认记录（tempId） */
const dupAcked = new Set<string>();
/** 本次会话已提示过「疑似重复」的条目（tempId），卡片上展示警示 */
const dupWarned = new Set<string>();

/** pickList 数据缓存（refresh 时构建，click handler 同步读取） */
let cachedExpenseCats: Category[] = [];
let cachedIncomeCats: Category[] = [];
let cachedAccounts: Account[] = [];
let expCatItems: PickListItem[] = [];
let incCatItems: PickListItem[] = [];
let acctItems: PickListItem[] = [];

/* ── 分享到达通知（shareListener 调用） ── */

/**
 * 系统分享素材已入队：打开收件箱并触发识别。
 * shell 未挂载（冷启动早期）时先缓冲，initAiInbox 后补打开。
 */
export function notifyShareReceived(): void {
  if (!inboxReady) {
    pendingOpen = true;
    return;
  }
  try { openSubpage('sp-ai-inbox'); } catch { /* 子页未注册时忽略，识别照常进行 */ }
  void recognizePending();
}

/* ── 识别管道（串行） ── */

/** 识别结果 → 待确认条目（继承素材引用；一次多笔时共享同一 attachmentId） */
function billToItem(bill: AiParsedBill, origin: AiPendingItem): AiPendingItem {
  return {
    tempId: crypto.randomUUID(),
    status: 'ready',
    source: origin.source,
    type: bill.type,
    amount: bill.amount,
    categoryName: bill.categoryName,
    accountName: bill.accountName,
    merchantName: bill.merchantName,
    note: bill.note,
    occurredAt: bill.occurredAt,
    confidence: bill.confidence,
    attachmentId: origin.attachmentId,
    rawText: origin.rawText,
    createdAt: origin.createdAt,
  };
}

/**
 * 串行处理队列中全部 'pending' 素材：置 recognizing → 调识别 → 替换为 ready 项；
 * 失败置 failed 可重试；API 未配置时回退 pending 并 toast 引导。
 * 全部完成后尝试高置信度静默入账。
 */
async function recognizePending(): Promise<void> {
  if (recognizeRunning) return;
  recognizeRunning = true;
  try {
    for (;;) {
      const item = (await listAiPendingItems()).find((it) => it.status === 'pending');
      if (!item) break;
      await updateAiPendingItem(item.tempId, { status: 'recognizing' });
      try {
        let bills: AiParsedBill[];
        if (item.rawText) {
          bills = await recognizeText(item.rawText);
        } else if (item.attachmentId != null) {
          const att = await getAiAttachment(item.attachmentId);
          if (!att) throw new Error('截图附件已丢失');
          bills = await recognizeImage(att.blob);
        } else {
          throw new Error('素材为空');
        }
        if (!bills.length) {
          await updateAiPendingItem(item.tempId, { status: 'failed', error: '未识别到账单信息' });
        } else {
          await replaceAiPendingItem(item.tempId, bills.map((b) => billToItem(b, item)));
        }
      } catch (err) {
        if (err instanceof AiConfigError) {
          // 配置缺失不算素材失败：回退待识别，引导去设置页后可重试
          await updateAiPendingItem(item.tempId, { status: 'pending' });
          showToast(err.message);
          break;
        }
        await updateAiPendingItem(item.tempId, {
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    await autoConfirm();
  } finally {
    recognizeRunning = false;
  }
}

/* ── 入账 ── */

interface ConfirmResult {
  imported: number;
  /** 命中查重跳过数 */
  skippedDup: number;
  /** 分类/账户未映射或金额非法跳过数 */
  skippedInvalid: number;
  /** 事务开始时已不在待确认队列的过期条目数 */
  skippedStale: number;
  /** 首个入账账单 id（「编辑更多」用） */
  firstEntryId?: number;
}

/**
 * 确认入账核心：分类/账户名映射为 id → 查重（同批内按已入库查重口径去重）→
 * importEntriesBatch(source:'ai') 单事务写入 → 从 KV 队列移除并清理附件。
 * @param items 待入账条目（须为 ready 状态）
 * @param allowDup 允许入账命中查重的条目（用户已二次确认「仍要入账」）
 */
async function confirmItems(items: AiPendingItem[], allowDup = false): Promise<ConfirmResult> {
  return saveImportAtomically(async () => {
    const result: ConfirmResult = { imported: 0, skippedDup: 0, skippedInvalid: 0, skippedStale: 0 };
    // 写事务获得锁后重读队列；双击或旧界面不能再次消费已入账 tempId。
    const liveById = new Map(
      (await listAiPendingItems())
        .filter((item) => item.status === 'ready')
        .map((item) => [item.tempId, item]),
    );
    const liveItems: AiPendingItem[] = [];
    for (const requested of items) {
      const live = liveById.get(requested.tempId);
      if (live) liveItems.push(live);
      else result.skippedStale++;
    }
    if (!liveItems.length) return result;

    const [expenseCats, incomeCats, accounts] = await Promise.all([
      listCategories('expense'), listCategories('income'), listAccounts(),
    ]);
    const entryItems: ImportEntryItem[] = [];
    const confirmedIds: string[] = [];
    const merchantIds: number[] = [];
    const batchKeys = new Set<string>();
    const counts: Record<string, number> = { expense: 0, income: 0 };

    for (const item of liveItems) {
      const type = item.type;
      const amount = item.amount ?? 0;
      const occurredAt = item.occurredAt ?? Date.now();
      const categoryId = mapCategoryNameToId(type ?? 'expense', item.categoryName ?? '', expenseCats, incomeCats);
      const accountId = mapAccountNameToId(item.accountName ?? '', accounts);
      if (!type || amount <= 0 || !Number.isSafeInteger(amount) || categoryId == null || accountId == null) {
        result.skippedInvalid++;
        continue;
      }
      // 同批内与库内均按「时间+类型+金额+账户」口径查重
      const key = entryIdentity({ type, amount, occurredAt, accountId });
      if (batchKeys.has(key)) { result.skippedDup++; continue; }
      const dup = await findDuplicates(occurredAt, type, amount, accountId);
      if (dup.length && !allowDup) { result.skippedDup++; continue; }
      batchKeys.add(key);
      const merchantId = item.merchantName ? await ensureMerchant(item.merchantName) : undefined;
      if (merchantId != null) merchantIds.push(merchantId);
      const input: NewEntry = { type, amount, occurredAt, categoryId, accountId, merchantId, note: item.note || undefined };
      entryItems.push({ input });
      confirmedIds.push(item.tempId);
      counts[type] = (counts[type] ?? 0) + 1;
    }

    if (entryItems.length) {
      const { entryIds } = await importEntriesBatch(entryItems, { source: 'ai', fileName: 'AI识别', counts });
      for (const id of merchantIds) await touchMerchant(id);
      await removeAiPendingItems(confirmedIds);
      result.imported = entryItems.length;
      result.firstEntryId = entryIds[0];
    }
    return result;
  });
}

/**
 * 高置信度静默入账：ready 且有效置信度 ≥ 阈值的条目自动 confirmItems
 * （映射失败/命中查重的条目会被 confirmItems 跳过，留在队列人工处理）。
 */
async function autoConfirm(): Promise<void> {
  const threshold = await getSetting('ai.autoConfirmThreshold');
  const items = (await listAiPendingItems())
    .filter((it) => canAutoConfirmAiItem(it, threshold));
  if (!items.length) return;
  const r = await confirmItems(items);
  if (r.imported > 0) showToast(`AI 已入账 ${r.imported} 笔，可在收件箱「最近入账」撤销`);
}

/** 撤销一个 AI 批次：按 importBatchId 找出未删除账单逐条软删除（回收站 30 天可恢复） */
async function undoBatch(batchId: number): Promise<void> {
  const targets = (await listEntries()).filter((e) => e.importBatchId === batchId);
  if (!targets.length) { showToast('该批次账单已撤销或删除'); return; }
  for (const e of targets) await softDeleteEntry(e.id);
  showToast(`已撤销 ${targets.length} 笔，可在回收站恢复`);
  void refresh();
}

/* ── 手动素材入口 ── */

/**
 * 顶部文本框识别：入队一条 paste 素材并触发识别。
 * 同文本素材尚未识别完成（pending/recognizing/failed）时不重复入队——
 * 未配置期间用户误以为提交失败而重复提交，会产生双份识别结果并触发查重告警，
 * 这里视作对原素材的重试（failed 重置回 pending）。
 */
async function submitText(text: string): Promise<void> {
  const dup = (await listAiPendingItems()).find((it) => it.status !== 'ready' && it.rawText === text);
  if (dup) {
    if (dup.status === 'failed') await updateAiPendingItem(dup.tempId, { status: 'pending', error: undefined });
    showToast('该文本已在识别队列中，继续识别');
    void recognizePending();
    return;
  }
  await addAiPendingItems([{
    tempId: crypto.randomUUID(), status: 'pending', source: 'paste', rawText: text, createdAt: Date.now(),
  }]);
  void recognizePending();
}

/** 选图识别：截图 Blob 写 attachments 后入队 pick 素材并触发识别 */
async function submitImages(files: FileList): Promise<void> {
  const items: AiPendingItem[] = [];
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;
    const attachmentId = await saveAiAttachment(file, file.name);
    items.push({ tempId: crypto.randomUUID(), status: 'pending', source: 'pick', attachmentId, createdAt: Date.now() });
  }
  if (!items.length) { showToast('请选择图片文件'); return; }
  await addAiPendingItems(items);
  void recognizePending();
}

/* ── 卡片内联编辑（change 即持久化回队列，重渲染不丢） ── */

/** 内联编辑落库：金额/备注仍走 change 事件；type/time/category/account 各自 click handler 直接完成 */
async function applyInlineEdit(t: HTMLElement, tempId: string): Promise<void> {
  if (t instanceof HTMLInputElement && t.dataset.field === 'amount') {
    try {
      await updateAiPendingItem(tempId, { amount: parseYuanToFen(t.value) });
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err));
      void refresh();
    }
  } else if (t instanceof HTMLInputElement && t.dataset.field === 'note') {
    await updateAiPendingItem(tempId, { note: t.value.trim() || undefined });
  } else if (t instanceof HTMLInputElement && t.dataset.field === 'merchant') {
    const name = t.value.trim();
    if (name) {
      const id = await ensureMerchant(name);
      if (id != null) await touchMerchant(id);
    }
    await updateAiPendingItem(tempId, { merchantName: name || undefined });
  }
}

/**
 * 单条确认入账。命中查重且未确认时先展示「疑似重复」，二次点击「仍要入账」放行。
 * @param editAfter true = 入账成功后打开记一笔抽屉微调（openEntrySheet({ entryId })）
 */
/** 编辑更多：先以草稿打开记账抽屉，保存后才入账并从队列移除。 */
async function editDraft(tempId: string): Promise<void> {
  const item = (await listAiPendingItems()).find((it) => it.tempId === tempId);
  if (!item || item.status !== 'ready') return;
  if (item.amount == null || !item.categoryName || !item.accountName) {
    showToast('请先在卡片上补全金额、分类与账户');
    return;
  }
  const [expenseCats, incomeCats, accounts] = await Promise.all([
    listCategories('expense'), listCategories('income'), listAccounts(),
  ]);
  const categoryId = mapCategoryNameToId(item.type ?? 'expense', item.categoryName, expenseCats, incomeCats);
  const accountId = mapAccountNameToId(item.accountName, accounts);
  if (categoryId == null || accountId == null) {
    showToast('分类或账户未匹配，请先在卡片上重新选择');
    return;
  }
  await openEntrySheet({
    draft: {
      type: item.type ?? 'expense',
      amount: item.amount,
      categoryId,
      accountId,
      occurredAt: item.occurredAt,
      note: item.note,
      merchantName: item.merchantName,
    },
    onSaved: () => {
      void removeAiPendingItems([tempId]).then(() => {
        showToast('草稿已入账，待确认项已移除');
        void refresh();
      });
    },
  });
}

async function confirmOne(tempId: string, editAfter: boolean): Promise<void> {
  const item = (await listAiPendingItems()).find((it) => it.tempId === tempId);
  if (!item || item.status !== 'ready') return;
  const allowDup = dupAcked.has(tempId);
  const r = await confirmItems([item], allowDup);
  if (r.imported > 0) {
    dupAcked.delete(tempId);
    dupWarned.delete(tempId);
    showToast(`已入账 ${formatFenCny(item.amount ?? 0)}`);
    if (editAfter && r.firstEntryId != null) void openEntrySheet({ entryId: r.firstEntryId });
    return;
  }
  if (r.skippedDup > 0) {
    // 疑似重复：卡片亮警示，按钮切换为「仍要入账」等待二次确认
    dupWarned.add(tempId);
    dupAcked.add(tempId);
    showToast('疑似重复：已有同时间同金额账单，请确认');
    void refresh();
    return;
  }
  if (r.skippedStale > 0) return;
  showToast('请先补全类型、金额、分类与账户');
}

/** 底部「全部确认入账」：逐条走查重（命中者留在队列），其余合入一个批次 */
async function confirmAll(): Promise<void> {
  const items = (await listAiPendingItems()).filter((it) => it.status === 'ready');
  if (!items.length) { showToast('暂无待确认账单'); return; }
  const r = await confirmItems(items);
  const parts = [`入账 ${r.imported} 笔`];
  if (r.skippedDup) parts.push(`疑似重复跳过 ${r.skippedDup} 笔`);
  if (r.skippedInvalid) parts.push(`待补全 ${r.skippedInvalid} 笔`);
  showToast(parts.join(' · '));
}

/* ── 渲染 ── */

/** 时间文案（"MM月DD日 HH:mm"） */
function formatTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 置信度徽标（高 ≥80 / 中 ≥50 / 低） */
function confBadge(conf: number | undefined): string {
  const c = conf ?? 0;
  const cls = c >= 80 ? 'hi' : c >= 50 ? 'mid' : 'lo';
  return `<span class="ai-conf ${cls}">置信 ${c}%</span>`;
}

/** 素材摘要（截图缩略图 / 文本片段） */
function sourceHtml(item: AiPendingItem, imgUrl?: string): string {
  if (imgUrl) return `<img class="ai-thumb" src="${imgUrl}" alt="截图素材">`;
  if (item.rawText) return `<p class="ai-raw">${esc(item.rawText.slice(0, 80))}${item.rawText.length > 80 ? '…' : ''}</p>`;
  return '';
}

/* categoryOptions 已删除：分类选择改为 openPickList，数据由模块缓存 expCatItems/incCatItems 提供 */

/** 待确认卡片（chip toggle + pickList 触发器 + 确认/编辑更多/忽略） */
function readyCardHtml(item: AiPendingItem, imgUrl?: string): string {
  const type = item.type ?? 'expense';
  const dupWarn = dupWarned.has(item.tempId);
  return `
    <section class="card ai-card${dupWarn ? ' dup' : ''}" data-temp="${item.tempId}">
      <div class="ai-card-head">
        <button class="chip${type === 'expense' ? ' active' : ''}" data-field="type" data-value="expense" data-temp-id="${item.tempId}">支出</button><button class="chip${type === 'income' ? ' active' : ''}" data-field="type" data-value="income" data-temp-id="${item.tempId}">收入</button>
        ${confBadge(item.confidence)}
        <label class="ai-merchant-field">商家<input data-field="merchant" type="text" value="${esc(item.merchantName ?? '')}" placeholder="商家（可选）"></label>
      </div>
      ${sourceHtml(item, imgUrl)}
      <div class="ai-fields">
        <label>金额<input data-field="amount" type="text" inputmode="decimal" value="${item.amount != null ? formatFen(item.amount).replace(/,/g, '') : ''}" placeholder="0.00"></label>
        <label>时间<button class="ai-time-btn" data-field="time" data-temp-id="${item.tempId}">${formatTime(item.occurredAt ?? Date.now())}</button></label>
        <label>分类<button class="chip ai-pick-btn" data-field="category" data-temp-id="${item.tempId}">${esc(item.categoryName || '选择分类')}</button></label>
        <label>账户<button class="chip ai-pick-btn" data-field="account" data-temp-id="${item.tempId}">${esc(item.accountName || '选择账户')}</button></label>
        <label class="wide">备注<input data-field="note" type="text" value="${esc(item.note ?? '')}" placeholder="备注（可选）"></label>
      </div>
      ${dupWarn ? '<p class="ai-dup-tip">疑似重复：已有同时间同金额同账户的账单</p>' : ''}
      <div class="ai-actions">
        <button class="btn ghost" data-act="ignore">忽略</button>
        <button class="btn ghost" data-act="edit">编辑更多</button>
        <button class="btn primary" data-act="confirm">${dupWarn ? '仍要入账' : '确认入账'}</button>
      </div>
    </section>`;
}

/** 识别中 / 待识别 / 失败卡片 */
function rawCardHtml(item: AiPendingItem, imgUrl?: string): string {
  const busy = item.status === 'recognizing';
  return `
    <section class="card ai-card raw" data-temp="${item.tempId}">
      <div class="ai-card-head">
        ${busy ? '<span class="ai-spin" aria-hidden="true"></span><span class="sub">识别中…</span>'
    : item.status === 'failed'
      ? `<span class="ai-fail">识别失败</span>`
      : '<span class="sub">等待识别</span>'}
      </div>
      ${sourceHtml(item, imgUrl)}
      ${item.status === 'failed' && item.error ? `<p class="ai-err">${esc(item.error)}</p>` : ''}
      <div class="ai-actions">
        <button class="btn ghost" data-act="ignore">忽略</button>
        ${item.status !== 'recognizing' ? '<button class="btn primary" data-act="retry">重试识别</button>' : ''}
      </div>
    </section>`;
}

async function refresh(): Promise<void> {
  const el = body;
  if (!el?.isConnected) return;
  const token = ++refreshToken;
  const [items, batches, expenseCats, incomeCats, accounts, apiKey, baseUrl, model, entries] = await Promise.all([
    listAiPendingItems(), listAiBatches(3),
    listCategories('expense'), listCategories('income'), listAccounts(),
    secretStore.get('ai.apiKey'), getSetting('ai.baseUrl'), getSetting('ai.model'),
    listEntries(),
  ]);
  // 截图预览：附件 → object URL（旧 URL 统一回收）
  const attIds = [...new Set(items.map((it) => it.attachmentId).filter((id): id is number => id != null))];
  const atts = await Promise.all(attIds.map((id) => getAiAttachment(id)));
  if (token !== refreshToken || !el.isConnected) return;
  for (const url of previewUrls) URL.revokeObjectURL(url);
  previewUrls = [];
  const urlByAtt = new Map<number, string>();
  atts.forEach((att, i) => {
    if (!att) return;
    const url = URL.createObjectURL(att.blob);
    previewUrls.push(url);
    urlByAtt.set(attIds[i], url);
  });

  // 构建 pickList items 缓存（refresh 顶部一次构建，避免 N 张卡片 N 次遍历）
  cachedExpenseCats = expenseCats;
  cachedIncomeCats = incomeCats;
  cachedAccounts = accounts;
  expCatItems = [];
  for (const parent of expenseCats.filter((c) => c.parentId == null)) {
    const children = expenseCats.filter((c) => c.parentId === parent.id);
    if (!children.length) {
      expCatItems.push({ value: parent.id, label: parent.name });
      continue;
    }
    for (const c of children) {
      expCatItems.push({ value: c.id, label: `${parent.name}/${c.name}`, group: parent.name });
    }
  }
  incCatItems = incomeCats.map((c) => ({ value: c.id, label: c.name }));
  acctItems = accounts.map((a) => ({ value: a.id, label: a.name }));

  const configured = !!(apiKey?.trim() && baseUrl.trim() && model.trim());
  const ready = items.filter((it) => it.status === 'ready');
  const raws = items.filter((it) => it.status !== 'ready');
  const liveCountByBatch = new Map<number, number>();
  for (const e of entries) {
    if (e.importBatchId != null) liveCountByBatch.set(e.importBatchId, (liveCountByBatch.get(e.importBatchId) ?? 0) + 1);
  }

  el.innerHTML = `
    ${configured ? '' : `
    <section class="card ai-guide">
      <p><b>先配置 AI 接口</b></p>
      <p class="sub">填写 OpenAI 兼容 API 地址、模型与 Key 后，即可识别截图与短信</p>
      <button class="btn primary" data-act="go-settings">去设置</button>
    </section>`}
    <section class="card ai-input" aria-label="添加素材">
      <textarea id="ai-text" rows="3" placeholder="粘贴短信 / 扣款通知 / 账单文本，如：昨天午饭花了28元 支付宝"></textarea>
      <div class="ai-actions">
        <button class="btn ghost" data-act="pick-img">${iconHtml('ic-camera', 16)} 选择截图</button>
        <button class="btn primary" data-act="recognize-text">识别文本</button>
      </div>
      <input type="file" id="ai-file" accept="image/*" multiple hidden>
      <p class="tiny">安卓端可直接把支付截图 / 短信「分享」给拾光；识别经你配置的 AI 接口完成</p>
    </section>
    ${raws.map((it) => rawCardHtml(it, it.attachmentId != null ? urlByAtt.get(it.attachmentId) : undefined)).join('')}
    ${ready.length ? `
    <div class="ai-sec-head"><h3>待确认 ${ready.length} 笔</h3><button class="chip" data-act="confirm-all">全部确认入账</button></div>
    ${ready.map((it) => readyCardHtml(it, it.attachmentId != null ? urlByAtt.get(it.attachmentId) : undefined)).join('')}` : ''}
    ${!raws.length && !ready.length ? '<p class="ai-empty sub">收件箱是空的：分享截图或粘贴文本，AI 帮你记账</p>' : ''}
    ${batches.length ? `
    <section class="card" aria-label="最近 AI 入账">
      <h3 class="card-title">最近 AI 入账</h3>
      ${batches.map((b) => {
    const live = liveCountByBatch.get(b.id) ?? 0;
    const total = (b.counts.expense ?? 0) + (b.counts.income ?? 0);
    const d = new Date(b.createdAt);
    const when = `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    return `
      <div class="field">
        <span>${when} · ${total} 笔${live < total ? `（${total - live} 笔已撤）` : ''}</span>
        ${live > 0 ? `<button class="chip" data-undo="${b.id}">撤销本批</button>` : '<span class="tiny">已撤销</span>'}
      </div>`;
  }).join('')}
      <p class="tiny">撤销后账单进回收站，30 天内可恢复</p>
    </section>` : ''}`;
}

/* ── 装配 ── */

/**
 * 注册 AI 记账收件箱子页（sp-ai-inbox），main.ts 调用一次。
 * 启动时把遗留 'recognizing' 条目重置为 'pending'（中断恢复），并补打开缓冲的分享。
 */
export function initAiInbox(): void {
  registerSubpage('sp-ai-inbox', {
    title: 'AI 记账收件箱',
    render(el) {
      body = el;
      el.addEventListener('click', (e) => {
        const t = e.target as HTMLElement;

        /* ── 字段级 click handler（type chip / time btn / category btn / account btn） ── */
        const fieldEl = t.closest<HTMLElement>('[data-field]');
        if (fieldEl && !(fieldEl instanceof HTMLInputElement) && !(fieldEl instanceof HTMLTextAreaElement)) {
          const field = fieldEl.dataset.field;
          const tempId = fieldEl.dataset.tempId;
          if (field && tempId) {
            if (field === 'type') {
              const val = fieldEl.dataset.value as 'expense' | 'income' | undefined;
              if (val) {
                void updateAiPendingItem(tempId, { type: val, categoryName: undefined });
              }
            } else if (field === 'time') {
              const items = listAiPendingItems();
              void items.then((list) => {
                const item = list.find((it) => it.tempId === tempId);
                const ts = item?.occurredAt ?? Date.now();
                const d = new Date(ts);
                const now = new Date();
                const panel = openDateTimeWheel({
                  withTime: true,
                  initial: { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), hour: d.getHours(), minute: d.getMinutes() },
                  maxDate: { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() },
                  onConfirm(r) {
                    void updateAiPendingItem(tempId, { occurredAt: new Date(r.year, r.month - 1, r.day, r.hour ?? 0, r.minute ?? 0).getTime() });
                  },
                });
                document.body.appendChild(panel);
              });
            } else if (field === 'category') {
              void listAiPendingItems().then((list) => {
                const item = list.find((it) => it.tempId === tempId);
                const kind = item?.type ?? 'expense';
                const catItems = kind === 'income' ? incCatItems : expCatItems;
                const selectedId = mapCategoryNameToId(kind, item?.categoryName ?? '', cachedExpenseCats, cachedIncomeCats);
                openPickList({
                  container: el,
                  title: '选择分类',
                  items: catItems,
                  selected: selectedId ?? undefined,
                  searchable: true,
                  onPick(_value, label) {
                    void updateAiPendingItem(tempId, { categoryName: label });
                  },
                });
              });
            } else if (field === 'account') {
              void listAiPendingItems().then((list) => {
                const item = list.find((it) => it.tempId === tempId);
                const selectedId = mapAccountNameToId(item?.accountName ?? '', cachedAccounts);
                openPickList({
                  container: el,
                  title: '选择账户',
                  items: acctItems,
                  selected: selectedId ?? undefined,
                  searchable: false,
                  onPick(_value, label) {
                    void updateAiPendingItem(tempId, { accountName: label });
                  },
                });
              });
            }
            return;
          }
        }

        /* ── 原有 action 事件委托 ── */
        const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
        const undo = t.closest<HTMLElement>('[data-undo]')?.dataset.undo;
        const tempId = t.closest<HTMLElement>('[data-temp]')?.dataset.temp;
        if (undo) { void undoBatch(Number(undo)); return; }
        if (!act) return;
        if (act === 'go-settings') openSubpage('sp-settings');
        else if (act === 'pick-img') el.querySelector<HTMLInputElement>('#ai-file')?.click();
        else if (act === 'recognize-text') {
          const ta = el.querySelector<HTMLTextAreaElement>('#ai-text');
          const text = ta?.value.trim();
          if (!text) { showToast('请先粘贴要识别的文本'); return; }
          if (ta) ta.value = '';
          void submitText(text);
        } else if (act === 'confirm-all') void confirmAll();
        else if (tempId && act === 'confirm') void confirmOne(tempId, false);
        else if (tempId && act === 'edit') void editDraft(tempId);
        else if (tempId && act === 'ignore') {
          dupAcked.delete(tempId);
          dupWarned.delete(tempId);
          void removeAiPendingItems([tempId]);
        } else if (tempId && act === 'retry') {
          void updateAiPendingItem(tempId, { status: 'pending', error: undefined })
            .then(() => recognizePending());
        }
      });
      el.addEventListener('change', (e) => {
        const t = e.target as HTMLElement;
        if (t instanceof HTMLInputElement && t.id === 'ai-file') {
          if (t.files?.length) void submitImages(t.files);
          t.value = '';
          return;
        }
        const tempId = t.closest<HTMLElement>('[data-temp]')?.dataset.temp;
        if (tempId && (t as HTMLElement).dataset.field) void applyInlineEdit(t, tempId);
      });
      void refresh();
    },
    onShow() {
      void refresh();
      // 上次会话遗留 / 配置补齐后的待识别素材，进入页面即续跑
      void recognizePending();
    },
  });

  inboxReady = true;
  void resetStuckRecognizing();
  if (pendingOpen) {
    pendingOpen = false;
    notifyShareReceived();
  }

  // 队列存 settings KV：settings-changed 即队列/配置变化，页面打开时刷新
  on('settings-changed', () => { if (body?.isConnected) void refresh(); });
  // 入账/撤销后刷新「最近 AI 入账」批次的存活计数
  on('entries-changed', () => { if (body?.isConnected) void refresh(); });
}
