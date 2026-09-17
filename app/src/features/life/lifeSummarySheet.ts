import type { LifeDraft } from '../../core/types';
import { esc } from '../../core/esc';
import { openSheet, closeSheet } from '../shell/sheet';
import { showToast } from '../shell/toast';

export interface LifeSummarySheetOptions {
  draft: LifeDraft;
  persist(): Promise<void>;
  save(): Promise<void>;
  regenerate(): Promise<void>;
  onReturn(): void;
}

/** 覆盖聊天页的 A1 确认抽屉；方案始终独立于正式记录字段。 */
export function openLifeSummarySheet(options: LifeSummarySheetOptions): void {
  const proposal = options.draft.summaryProposal;
  if (!proposal) return;
  let saving = false;
  openSheet({
    ariaLabel: '确认生活记录',
    onClose: options.onReturn,
    render(el) {
      const stale = () => proposal.sourceMessageCount < options.draft.messages.length;
      el.innerHTML = `<div class="lf-sheet-head"><p class="sheet-title">留下一条记录</p><button class="icon-btn" data-life-summary-return aria-label="返回继续聊">×</button></div>
        <div class="sheet-scroll life-summary-sheet">
          <p class="sub">这是建议稿，保存前可以按自己的话修改。</p>
          <p class="life-summary-stale" ${stale() ? '' : 'hidden'}>对话已有新内容，当前建议不会自动覆盖你的修改。</p>
          <label>标题<input id="life-summary-title" class="note" maxlength="120" value="${esc(proposal.title)}"></label>
          <label>正文<textarea id="life-summary-body" class="note" maxlength="12000">${esc(proposal.body)}</textarea></label>
          <label>心情<input id="life-summary-mood" class="note" maxlength="60" value="${esc(proposal.mood ?? '')}" placeholder="可以不填"></label>
          <label>标签<input id="life-summary-tags" class="note" maxlength="720" value="${esc(proposal.tags.join('，'))}" placeholder="散步，朋友"></label>
          <p id="life-summary-status" class="sub" role="status"></p>
          <button class="btn primary" data-life-summary-save>保存这条记录</button>
          <div class="lc-row life-summary-actions"><button class="btn ghost" data-life-summary-return>返回继续聊</button><button class="btn ghost" data-life-summary-regenerate>重新整理</button></div>
        </div>`;
      const update = () => {
        proposal.title = el.querySelector<HTMLInputElement>('#life-summary-title')!.value;
        proposal.body = el.querySelector<HTMLTextAreaElement>('#life-summary-body')!.value;
        proposal.mood = el.querySelector<HTMLInputElement>('#life-summary-mood')!.value.trim() || undefined;
        proposal.tags = el.querySelector<HTMLInputElement>('#life-summary-tags')!.value.split(/[,，]/).map(tag => tag.trim()).filter(Boolean);
        void options.persist().catch(() => { el.querySelector('#life-summary-status')!.textContent = '编辑暂存在当前页面，请勿刷新'; });
      };
      el.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('#life-summary-title,#life-summary-body,#life-summary-mood,#life-summary-tags').forEach(input => input.oninput = update);
      el.querySelectorAll('[data-life-summary-return]').forEach(button => button.addEventListener('click', closeSheet));
      el.querySelector('[data-life-summary-regenerate]')!.addEventListener('click', async () => {
        if (saving) return;
        saving = true;
        el.querySelector<HTMLElement>('#life-summary-status')!.textContent = '重新整理中…';
        try { await options.regenerate(); }
        catch (error) { el.querySelector<HTMLElement>('#life-summary-status')!.textContent = error instanceof Error ? error.message : '暂时无法整理，请重试'; }
        finally { saving = false; }
      });
      el.querySelector('[data-life-summary-save]')!.addEventListener('click', async () => {
        if (saving) return;
        update();
        if (!proposal.title.trim() || !proposal.body.trim()) { showToast('请补充标题和正文后再保存'); return; }
        saving = true;
        el.querySelector<HTMLElement>('#life-summary-status')!.textContent = '保存中…';
        try { await options.save(); }
        catch (error) { el.querySelector<HTMLElement>('#life-summary-status')!.textContent = error instanceof Error ? error.message : '保存失败，请重试'; saving = false; }
      });
    },
  });
}
