import type { LifeDraft } from '../../core/types';
import { esc } from '../../core/esc';
import { getAttachment, listLifeLinkedEntries } from '../../core/repo/lifeRepo';
import { openSheet, closeSheet } from '../shell/sheet';
import { showToast } from '../shell/toast';
import { prepareReceipt } from '../entry/receiptEditor';
import { openDateWheel } from '../../shared/dateTimeWheel';

export interface LifeSummarySheetOptions {
  draft: LifeDraft;
  persist(): Promise<void>;
  save(): Promise<void>;
  regenerate(): Promise<void>;
  onReturn(): void;
}

const dateText = (timestamp: number) => new Date(timestamp).toLocaleDateString('zh-CN');
function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('照片读取失败'));
    reader.readAsDataURL(blob);
  });
}

/** 覆盖聊天页的 A1 确认抽屉；方案始终独立于正式记录字段。 */
export function openLifeSummarySheet(options: LifeSummarySheetOptions): void {
  const proposal = options.draft.summaryProposal;
  if (!proposal) return;
  let saving = false;
  let closed = false;
  const objectUrls: string[] = [];
  openSheet({
    ariaLabel: '确认生活记录',
    onClose: () => {
      closed = true;
      for (const url of objectUrls) URL.revokeObjectURL(url);
      options.onReturn();
    },
    render(el) {
      const stale = () => proposal.sourceMessageCount < options.draft.messages.length || options.draft.photos.length > 0;
      const sentPhotoCount = options.draft.messages.reduce((count, message) => count + (message.photos?.length ?? 0), 0);
      el.innerHTML = `<div class="lf-sheet-head"><p class="sheet-title">留下一条记录</p><button class="icon-btn" data-life-summary-return aria-label="返回继续聊">×</button></div>
        <div class="sheet-scroll life-summary-sheet">
          <p class="sub">这是建议稿，保存前可以按自己的话修改。</p>
          <p class="life-summary-stale" ${stale() ? '' : 'hidden'}>对话已有新内容，当前建议不会自动覆盖你的修改。</p>
          <label>标题<input id="life-summary-title" class="note" maxlength="120" value="${esc(proposal.title)}"></label>
          <label>正文<textarea id="life-summary-body" class="note" maxlength="12000">${esc(proposal.body)}</textarea></label>
          <label>心情<input id="life-summary-mood" class="note" maxlength="60" value="${esc(proposal.mood ?? '')}" placeholder="可以不填"></label>
          <label>标签<input id="life-summary-tags" class="note" maxlength="720" value="${esc(proposal.tags.join('，'))}" placeholder="散步，朋友"></label>
          <details class="lc-details life-summary-extra"><summary>照片、日期与回访</summary>
            <p class="sub">已保留 ${options.draft.existingPhotoRefs.length + sentPhotoCount + options.draft.photos.length} 张照片；另外可补充照片，保存时一并留在本机。</p>
            <div class="lc-row"><button class="chip" data-life-summary-photo>＋ 添加照片</button><button class="chip" data-life-summary-date>${dateText(options.draft.occurredAt)}</button></div>
            <input id="life-summary-file" type="file" accept="image/jpeg,image/png,image/webp" multiple hidden><div id="life-summary-photos" class="life-summary-photos"></div>
            <label>现在的感受<select id="life-summary-verdict"><option value="">自己写，不选评价</option><option value="again">值得再来</option><option value="neutral">一般</option><option value="not-for-me">不太适合我</option></select></label>
            <label>补一句<textarea id="life-summary-review" class="note" maxlength="2000" placeholder="留下了什么，只有你知道">${esc(options.draft.review?.text ?? '')}</textarea></label>
            <div class="lc-row"><button class="chip" data-life-summary-revisit>${options.draft.review?.revisitAt ? `${dateText(options.draft.review.revisitAt)} 再看看` : '选一天再看看'}</button><button class="chip" data-life-summary-no-revisit>不提醒</button></div>
          </details>
          <details class="lc-details life-summary-extra"><summary>关联账单</summary><p id="life-summary-linked" class="sub">${options.draft.entryId ? '保存后会关联当前账单，不会再次记账。' : '暂无关联账单。'}</p></details>
          <p id="life-summary-status" class="sub" role="status"></p>
          <button class="btn primary" data-life-summary-save>保存这条记录</button>
          <div class="lc-row life-summary-actions"><button class="btn ghost" data-life-summary-return>返回继续聊</button><button class="btn ghost" data-life-summary-regenerate>重新整理</button></div>
        </div>`;
      const update = () => {
        proposal.title = el.querySelector<HTMLInputElement>('#life-summary-title')!.value;
        proposal.body = el.querySelector<HTMLTextAreaElement>('#life-summary-body')!.value;
        proposal.mood = el.querySelector<HTMLInputElement>('#life-summary-mood')!.value.trim() || undefined;
        proposal.tags = el.querySelector<HTMLInputElement>('#life-summary-tags')!.value.split(/[,，]/).map(tag => tag.trim()).filter(Boolean);
        options.draft.review = {
          ...options.draft.review,
          verdict: (el.querySelector<HTMLSelectElement>('#life-summary-verdict')!.value || undefined) as NonNullable<LifeDraft['review']>['verdict'],
          text: el.querySelector<HTMLTextAreaElement>('#life-summary-review')!.value,
        };
        void options.persist().catch(() => { el.querySelector('#life-summary-status')!.textContent = '编辑暂存在当前页面，请勿刷新'; });
      };
      el.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('#life-summary-title,#life-summary-body,#life-summary-mood,#life-summary-tags').forEach(input => input.oninput = update);
      el.querySelector<HTMLSelectElement>('#life-summary-verdict')!.value = options.draft.review?.verdict ?? '';
      el.querySelector<HTMLSelectElement>('#life-summary-verdict')!.onchange = update;
      el.querySelector<HTMLTextAreaElement>('#life-summary-review')!.oninput = update;
      let existingPhotoSources: string[] = [];
      const renderPhotos = () => {
        const sentSources = options.draft.messages.flatMap(message => message.photos ?? []).map(photo => photo.dataUrl);
        const readonlySources = [...existingPhotoSources, ...sentSources];
        el.querySelector('#life-summary-photos')!.innerHTML = `${readonlySources.map((src, index) => `<div><img src="${src}" alt="已保留照片 ${index + 1}"></div>`).join('')}${options.draft.photos.map((photo, index) => `<div><img src="${photo.dataUrl}" alt="补充照片 ${index + 1}"><button class="chip" data-life-summary-remove-photo="${index}" aria-label="移除补充照片 ${index + 1}">移除</button></div>`).join('')}`;
        el.querySelectorAll<HTMLButtonElement>('[data-life-summary-remove-photo]').forEach(button => button.onclick = () => {
          options.draft.photos.splice(Number(button.dataset.lifeSummaryRemovePhoto), 1);
          void options.persist(); renderPhotos();
        });
      };
      const pickDate = (timestamp: number, accept: (value: number) => void) => {
        const date = new Date(timestamp);
        document.body.appendChild(openDateWheel({ initial: { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() }, onConfirm: result => accept(new Date(result.year, result.month - 1, result.day, 12).getTime()) }));
      };
      el.querySelector('[data-life-summary-photo]')!.addEventListener('click', () => el.querySelector<HTMLInputElement>('#life-summary-file')!.click());
      el.querySelector<HTMLInputElement>('#life-summary-file')!.onchange = event => { void (async () => {
        const files = (event.target as HTMLInputElement).files;
        if (!files?.length) return;
        const sent = options.draft.messages.reduce((count, message) => count + (message.photos?.length ?? 0), 0);
        if (files.length + options.draft.photos.length + options.draft.existingPhotoRefs.length + sent > 9) { showToast('这条记录最多保留 9 张照片'); return; }
        try {
          for (const file of Array.from(files)) { await prepareReceipt(file); options.draft.photos.push({ name: file.name, dataUrl: await dataUrl(file) }); }
          await options.persist(); renderPhotos();
        } catch (error) { el.querySelector<HTMLElement>('#life-summary-status')!.textContent = error instanceof Error ? error.message : '照片添加失败'; }
      })(); };
      el.querySelector('[data-life-summary-date]')!.addEventListener('click', () => pickDate(options.draft.occurredAt, value => {
        options.draft.occurredAt = value; el.querySelector('[data-life-summary-date]')!.textContent = dateText(value); void options.persist();
      }));
      el.querySelector('[data-life-summary-revisit]')!.addEventListener('click', () => pickDate(options.draft.review?.revisitAt ?? Date.now() + 7 * 86400000, value => {
        options.draft.review = { ...options.draft.review, revisitAt: value, dismissedAt: undefined };
        el.querySelector('[data-life-summary-revisit]')!.textContent = `${dateText(value)} 再看看`; void options.persist();
      }));
      el.querySelector('[data-life-summary-no-revisit]')!.addEventListener('click', () => {
        options.draft.review = { ...options.draft.review, revisitAt: undefined, dismissedAt: Date.now() };
        el.querySelector('[data-life-summary-revisit]')!.textContent = '选一天再看看'; void options.persist();
      });
      if (options.draft.noteId) void listLifeLinkedEntries(options.draft.noteId).then(entries => {
        const linked = el.querySelector('#life-summary-linked');
        if (linked) linked.textContent = entries.length ? `已关联 ${entries.length} 笔账单；保存不会改变金额。` : '暂无关联账单。';
      });
      renderPhotos();
      void Promise.all(options.draft.existingPhotoRefs.map(id => getAttachment(id))).then(attachments => {
        if (closed) return;
        const sources = attachments.flatMap(attachment => {
          if (!attachment?.blob) return [];
          const url = URL.createObjectURL(attachment.blob);
          if (closed) { URL.revokeObjectURL(url); return []; }
          objectUrls.push(url); return [url];
        });
        if (closed) { for (const url of sources) URL.revokeObjectURL(url); return; }
        existingPhotoSources = sources;
        renderPhotos();
      });
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
