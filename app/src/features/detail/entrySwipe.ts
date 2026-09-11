/**
 * 拾光 · 账单左滑操作模块（对外复用）
 * 首页 / 明细 / 账户流水 / 搜索结果共用：.entry-swipe 外壳的横滑手势绑定、
 * 操作条 HTML（编辑 / 复制 / 删除 / 退款）与统一的快捷动作执行。
 * 同时持有只读详情页 / 退款页的目标账单 id（openEntryDetail / openRefundPage）。
 */
import { type Entry } from '../../core/types';
import {
  softDeleteEntry, listRefunds, refundableAmount,
} from '../../core/repo/entryRepo';
import { openSubpage } from '../shell/router';
import { showToast } from '../shell/toast';
import { confirmDialog } from '../shell/dialog';
import { openEntrySheet } from '../entry/entrySheet';

let viewEntryId: number | undefined;
let refundEntryId: number | undefined;

export type EntryQuickAction = 'edit' | 'copy' | 'delete' | 'refund';

/** 打开单条账单只读详情；编辑只从详情底部动作进入。 */
export function openEntryDetail(entryId: number): void {
  viewEntryId = entryId;
  openSubpage('sp-entry-view');
}

/** 打开关联退款页面。 */
export function openRefundPage(entryId: number): void {
  refundEntryId = entryId;
  openSubpage('sp-entry-refund');
}

/** 只读详情页当前目标账单 id（sp-entry-view render 读取） */
export function getViewEntryId(): number | undefined {
  return viewEntryId;
}

/** 退款页当前原账单 id（sp-entry-refund render 读取） */
export function getRefundEntryId(): number | undefined {
  return refundEntryId;
}

export function canRefund(entry: Entry): boolean {
  return entry.type === 'expense' && !entry.refundFlag
    && entry.reconcileBeforeBalance == null && entry.reconcileTargetBalance == null;
}

/** 列表左滑后显示的四个操作。 */
export function entrySwipeActionsHtml(entry: Entry): string {
  const refundDisabled = !canRefund(entry);
  return `<div class="entry-swipe-actions" aria-label="账单快捷操作">
    <button data-entry-action="edit">编辑</button>
    <button data-entry-action="copy">复制</button>
    <button class="danger" data-entry-action="delete">删除</button>
    <button class="refund${refundDisabled ? ' disabled' : ''}" data-entry-action="refund" aria-disabled="${refundDisabled}">退款</button>
  </div>`;
}

/** 为容器中的 .entry-swipe 绑定横向拖动；同一时间只展开一条。 */
export function bindEntrySwipeActions(container: HTMLElement): void {
  let row: HTMLElement | null = null;
  let startX = 0;
  let startY = 0;
  let deltaX = 0;
  let horizontal = false;
  let pointerId = -1;
  const actionWidth = 232;

  const closeOthers = (except?: HTMLElement) => {
    for (const item of container.querySelectorAll<HTMLElement>('.entry-swipe.swipe-open')) {
      if (item !== except) item.classList.remove('swipe-open');
    }
  };

  container.addEventListener('pointerdown', (event) => {
    const target = event.target as HTMLElement;
    if (target.closest('[data-entry-action], .ck')) return;
    const hit = target.closest<HTMLElement>('.entry-swipe');
    if (!hit) { closeOthers(); return; }
    row = hit;
    startX = event.clientX;
    startY = event.clientY;
    deltaX = 0;
    horizontal = false;
    pointerId = event.pointerId;
  });
  container.addEventListener('pointermove', (event) => {
    if (!row) return;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    if (!horizontal && Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) {
      horizontal = true;
      try { container.setPointerCapture(pointerId); } catch { /* 某些 WebView 不支持，无需阻断手势 */ }
    }
    if (!horizontal) return;
    event.preventDefault();
    deltaX = Math.max(-actionWidth, Math.min(0, dx));
    row.querySelector<HTMLElement>('.entry-swipe-content')!.style.transform = `translateX(${deltaX}px)`;
  });
  const finish = () => {
    if (!row) return;
    const current = row;
    const content = current.querySelector<HTMLElement>('.entry-swipe-content')!;
    content.style.transform = '';
    if (horizontal) {
      current.dataset.swipeSuppress = 'true';
      window.setTimeout(() => { delete current.dataset.swipeSuppress; }, 0);
    }
    if (horizontal && deltaX < -46) {
      closeOthers(current);
      current.classList.add('swipe-open');
    } else if (horizontal) {
      current.classList.remove('swipe-open');
    }
    row = null;
  };
  container.addEventListener('pointerup', finish);
  container.addEventListener('pointercancel', finish);
}

/** 统一执行详情页、明细页和首页的账单动作。 */
export async function runEntryQuickAction(action: EntryQuickAction, entry: Entry): Promise<'deleted' | 'done' | 'opened'> {
  if (action === 'edit') {
    void openEntrySheet({ entryId: entry.id });
    return 'opened';
  }
  if (action === 'copy') {
    void openEntrySheet({ repeatFromEntryId: entry.id });
    return 'opened';
  }
  if (action === 'delete') {
    const linked = !entry.refundFlag ? await listRefunds(entry.id) : [];
    const ok = await confirmDialog({
      title: '删除这笔账单？',
      message: linked.length
        ? `该账单关联 ${linked.length} 笔退款，删除后将一并进入回收站，30 天内可恢复。`
        : '删除后进入回收站，30 天内可在「我的 → 回收站」恢复。',
      okText: '删除',
      danger: true,
    });
    if (!ok) return 'done';
    await softDeleteEntry(entry.id);
    showToast('已删除，30 天内可在「我的 → 回收站」恢复');
    return 'deleted';
  }
  if (!canRefund(entry)) {
    showToast('仅普通支出账单支持退款');
    return 'done';
  }
  const remaining = await refundableAmount(entry.id);
  if (remaining <= 0) {
    showToast('这笔支出已全部退款');
    return 'done';
  }
  openRefundPage(entry.id);
  return 'opened';
}
