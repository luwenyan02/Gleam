import { entryDisplayAmount } from '../../core/entryAmount';
import { displayEntryNote } from './entryRowText';
import { categoryDisplayMap } from '../../core/categoryIcons';
/**
 * 拾光 · 单条账单只读详情子页（sp-entry-view）
 * 头部金额卡、字段列表、关联退款展示与底部操作栏（编辑 / 复制 / 删除 / 退款）。
 */
import { iconHtml } from '../../assets/icons';
import { esc } from '../../core/esc';
import { formatFen, formatFenCny } from '../../core/money';
import { on } from '../../core/store';
import { LOAN_KIND_META, type Entry } from '../../core/types';
import {
  getEntry, getEntryTagIds, listRefunds, refundableAmount,
} from '../../core/repo/entryRepo';
import { listCategories, listExpenseTree } from '../../core/repo/categoryRepo';
import { listAccounts } from '../../core/repo/accountRepo';
import { listMerchants } from '../../core/repo/merchantRepo';
import { listTags } from '../../core/repo/tagRepo';
import { getImportBatch } from '../../core/repo/aiRepo';
import { closeSubpage } from '../shell/router';
import { showToast } from '../shell/toast';
import {
  canRefund, getViewEntryId, runEntryQuickAction, type EntryQuickAction,
} from './entrySwipe';
import { fullDateTime, typeName } from './detailShared';
import { reimbursementDetailText } from '../reimburse/reimburse';
import { listEntryAttachments } from '../../core/repo/entryAttachmentRepo';
import { previewReceipt, receiptThumbnail } from '../entry/receiptEditor';
import { openEntityInsight } from '../tagmerchant/tagmerchant';
import { openEntryLifeStory } from '../life/lifeExtras';

export async function renderEntryView(body: HTMLElement): Promise<void> {
  const entryId = getViewEntryId();
  if (entryId == null) { body.innerHTML = '<p class="tiny">未指定账单</p>'; return; }
  const targetEntryId = entryId;
  const subpage = body.closest<HTMLElement>('.subpage')!;
  body.classList.add('entry-view-body');
  subpage.querySelector('.entry-view-actions')?.remove();
  const actionBar = document.createElement('div');
  actionBar.className = 'entry-view-actions';
  subpage.appendChild(actionBar);
  let current: Entry | undefined;

  async function refreshView(): Promise<void> {
    const [entry, tree, incomeCats, accounts, merchants, tags, tagIds] = await Promise.all([
      getEntry(targetEntryId), listExpenseTree(), listCategories('income'), listAccounts(true),
      listMerchants(), listTags(), getEntryTagIds(targetEntryId),
    ]);
    if (!entry || entry.deletedAt !== 0) {
      body.innerHTML = '<div class="placeholder"><p class="sub">账单不存在或已进入回收站</p></div>';
      actionBar.remove();
      return;
    }
    current = entry;
    const categories = [...tree.flatMap((group) => [group.parent, ...group.children]), ...incomeCats];
    const cat = categoryDisplayMap(categories).get(entry.categoryId ?? -1);
    const accountMap = new Map(accounts.map((account) => [account.id, account]));
    const account = accountMap.get(entry.accountId ?? -1);
    const merchant = merchants.find((item) => item.id === entry.merchantId);
    const selectedTags = tags.filter((tag) => tagIds.includes(tag.id));
    const refunds = entry.refundFlag ? [] : await listRefunds(entry.id);
    const original = entry.refundOfEntryId != null ? await getEntry(entry.refundOfEntryId) : undefined;
    const remaining = canRefund(entry) ? await refundableAmount(entry.id) : 0;
    const reconciliation = entry.reconcileBeforeBalance != null && entry.reconcileTargetBalance != null;
    const icon = reconciliation || entry.type === 'transfer' ? 'ic-swap'
      : entry.type === 'loan' ? LOAN_KIND_META[entry.loanKind ?? 'borrow'].icon
        : cat?.icon ?? 'ic-coin';
    const inflow = entryDisplayAmount(entry) >= 0;
    const accountText = entry.type === 'transfer' || entry.type === 'loan'
      ? `${accountMap.get(entry.fromAccountId ?? -1)?.name ?? '账户'} → ${accountMap.get(entry.toAccountId ?? -1)?.name ?? '账户'}`
      : account?.name ?? '未选择账户';
    const categoryText = reconciliation ? '余额对账调整' : entry.type === 'loan'
      ? LOAN_KIND_META[entry.loanKind ?? 'borrow'].name
      : entry.type === 'transfer' ? '账户转账' : cat?.name ?? '未分类';
    const reimbursement = reimbursementDetailText(entry);
    const batch = entry.importBatchId != null ? await getImportBatch(entry.importBatchId) : undefined;
    const sourceText = entry.importBatchId == null ? '手工录入' : batch?.source === 'ai' ? 'AI 记账' : '账单导入';
    const receipts = await listEntryAttachments(entry.id);
    const visibleNote = displayEntryNote(entry.note);

    subpage.querySelector<HTMLElement>('.sub-head h2')!.textContent = typeName(entry);
    body.innerHTML = `
      <section class="entry-view-hero">
        <span class="entry-view-icon${entry.refundFlag ? ' refund' : ''}">${iconHtml(icon, 22)}</span>
        <div><p>${typeName(entry)}</p><h3>${esc(categoryText)}</h3></div>
        <strong class="num ${inflow ? 'in' : 'out'}">${formatFen(entryDisplayAmount(entry), { sign: true })}</strong>
      </section>
      <section class="card list entry-view-fields">
        <div class="detail-field"><span>时间</span><b class="num">${fullDateTime(entry.occurredAt)}</b></div>
        <div class="detail-field"><span>${entry.type === 'expense' ? (entry.refundFlag || entry.amount < 0 ? '退款账户' : '付款账户') : '资金账户'}</span><b>${esc(accountText)}</b></div>
        <div class="detail-field"><span>分类</span><b>${esc(categoryText)}</b></div>
        <div class="detail-field"><span>商家</span><b>${merchant ? `<button class="chip" data-view-merchant="${merchant.id}">${esc(merchant.name)} ›</button>` : '无商家'}</b></div>
        ${entry.type === 'expense' && !entry.refundFlag && !entry.sourceAdjustment ? `<div class="detail-field"><span>报销</span><b>${reimbursement}</b></div>` : ''}
        ${selectedTags.length ? `<div class="detail-field"><span>标签</span><b>${selectedTags.map(tag => `<button class="chip" data-view-tag="${tag.id}">#${esc(tag.name)} ›</button>`).join(' ')}</b></div>` : ''}
      </section>
      <section class="card list entry-view-fields compact">
        <div class="detail-field"><span>来源</span><b>${sourceText}</b></div>
        ${entry.sourceAdjustment ? `<div class="detail-field"><span>原始记录</span><b>挖财第 ${entry.sourceAdjustment.rowNo} 行 · 保留原值，不支持编辑</b></div>` : ''}
        ${entry.refundFlag ? `<div class="detail-field"><span>关联原账单</span><b>${original ? `${esc(typeName(original))} · ${formatFenCny(original.amount)}` : '原账单已删除'}</b></div>` : ''}
      </section>
      <section class="entry-view-note${visibleNote ? '' : ' empty'}">${visibleNote ? esc(visibleNote) : '无备注'}</section>
      <section class="card entry-life-story"><button class="chip" data-entry-life>${entry.lifeNoteId ? '查看这一笔的故事 ›' : '给这一笔留下点记忆'}</button></section>
      ${receipts.length ? `<section aria-label="账单凭证"><p class="card-title">凭证 · ${receipts.length}</p><div class="receipt-strip">${receipts.map((receipt, index) => `<button class="receipt-thumb" type="button" data-view-receipt="${index}" aria-label="预览凭证 ${index + 1}">${receiptThumbnail(receipt)}</button>`).join('')}</div></section>` : ''}
      ${refunds.length ? `<section class="refund-links"><p class="card-title">关联退款 · ${refunds.length} 笔</p>${refunds.map((refund) => `<div><span>${fullDateTime(refund.occurredAt)}</span><b class="num">+${formatFen(refund.amount)}</b></div>`).join('')}<p>尚可退款 <b class="num">${formatFenCny(remaining)}</b></p></section>` : ''}
      <p class="entry-audit">账单 ID：${entry.id}<br>创建时间：${fullDateTime(entry.createdAt)}<br>修改时间：${fullDateTime(entry.updatedAt)}</p>`;
    body.querySelectorAll<HTMLButtonElement>('[data-view-receipt]').forEach(button => {
      button.onclick = () => previewReceipt(receipts[Number(button.dataset.viewReceipt)]!);
    });
    body.querySelectorAll<HTMLButtonElement>('[data-view-tag]').forEach(button => { button.onclick = () => openEntityInsight('tag', Number(button.dataset.viewTag)); });
    body.querySelector('[data-entry-life]')!.addEventListener('click', () => { void openEntryLifeStory(entry.id, subpage); });
    body.querySelectorAll<HTMLButtonElement>('[data-view-merchant]').forEach(button => { button.onclick = () => openEntityInsight('merchant', Number(button.dataset.viewMerchant)); });

    const refundLabel = !canRefund(entry) ? '不可退款' : remaining > 0 ? '退款' : '已退完';
    actionBar.innerHTML = `
      <button data-view-action="edit">${iconHtml('ic-pen', 17)}<span>编辑</span></button>
      <button data-view-action="copy">${iconHtml('ic-repeat', 17)}<span>再记</span></button>
      <button class="danger" data-view-action="delete">${iconHtml('ic-trash', 17)}<span>删除</span></button>
      <button class="refund${remaining <= 0 || !canRefund(entry) ? ' disabled' : ''}" data-view-action="refund" aria-disabled="${remaining <= 0 || !canRefund(entry)}">${iconHtml('ic-swap', 17)}<span>${refundLabel}</span></button>`;
  }

  actionBar.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>('[data-view-action]');
    if (!button || !current) return;
    if (button.getAttribute('aria-disabled') === 'true') {
      showToast(canRefund(current) ? '这笔支出已全部退款' : '该类型不支持退款');
      return;
    }
    void runEntryQuickAction(button.dataset.viewAction as EntryQuickAction, current).then((result) => {
      if (result === 'deleted') closeSubpage();
    });
  });
  const off = on('entries-changed', () => {
    if (!body.isConnected) { off(); return; }
    void refreshView();
  });
  await refreshView();
}
