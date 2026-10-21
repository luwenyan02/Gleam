import { iconHtml } from '../../assets/icons';
import { esc } from '../../core/esc';
import { formatFenCny } from '../../core/money';
import type { LifeNote } from '../../core/types';
import { getAttachment, getLifeNote } from '../../core/repo/lifeRepo';
import { openSheet, closeSheet } from '../shell/sheet';
import './lifeNotePreview.css';

const KIND_LABEL: Record<LifeNote['kind'], string> = { diary: '日记', photo: '照片记录', habit: '习惯打卡' };

/** 只读查看正式记录；不打开编辑器、不生成草稿，也不调用 AI。 */
export function openLifeNotePreview(noteId: number, opener: HTMLElement): void {
  let disposed = false;
  let content: HTMLElement;
  const urls: string[] = [];
  openSheet({
    ariaLabel: '拾光记录预览',
    opener,
    onClose() { disposed = true; urls.splice(0).forEach(url => URL.revokeObjectURL(url)); },
    render(el) {
      el.innerHTML = `<div class="sheet-head life-preview-head"><p class="sheet-title">拾光记录</p><button class="icon-btn" data-life-preview-close aria-label="关闭记录预览">${iconHtml('ic-close')}</button></div><div class="sheet-scroll life-preview-content" data-life-preview-content><p class="sub" role="status">正在读取记录…</p></div>`;
      el.querySelector('[data-life-preview-close]')!.addEventListener('click', closeSheet);
      content = el.querySelector<HTMLElement>('[data-life-preview-content]')!;
      void load();
    },
  });

  async function load(): Promise<void> {
    try {
      const note = Number.isSafeInteger(noteId) && noteId > 0 ? await getLifeNote(noteId) : undefined;
      if (disposed) return;
      if (!note || note.deletedAt) { content.innerHTML = '<p class="sub" role="status">这条记录已删除或不存在</p>'; return; }
      const tags = [note.mood ? `心情 · ${note.mood}` : '', ...(note.tags ?? [])].filter(Boolean);
      content.innerHTML = `<p class="life-preview-date">${esc(KIND_LABEL[note.kind])} · ${esc(new Date(note.occurredAt).toLocaleString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }))}</p>
        <h2 class="life-preview-title">${esc(note.title || KIND_LABEL[note.kind])}</h2>
        ${tags.length ? `<p class="life-preview-tags">${tags.map(tag => `<span class="chip tag">${esc(tag)}</span>`).join('')}</p>` : ''}
        ${note.body ? `<p class="life-preview-body">${esc(note.body)}</p>` : note.kind === 'habit' ? '<p class="life-preview-body">已完成打卡</p>' : ''}
        ${note.linkedAmount ? `<p class="sub">关联支出 ${formatFenCny(note.linkedAmount)}</p>` : ''}
        ${note.originalBody && note.originalBody !== note.body ? `<details class="life-preview-original"><summary tabindex="0">原话</summary><p class="life-preview-body">${esc(note.originalBody)}</p></details>` : ''}
        ${note.photoRefs?.length ? '<div class="life-preview-photos" data-life-preview-photos><p class="sub" role="status">正在读取照片…</p></div>' : ''}`;
      const photos = await Promise.allSettled((note.photoRefs ?? []).map(id => getAttachment(id)));
      if (disposed) return;
      const host = content.querySelector<HTMLElement>('[data-life-preview-photos]');
      if (!host) return;
      host.innerHTML = photos.map((result, index) => {
        if (result.status === 'fulfilled' && result.value) {
          try {
            const url = URL.createObjectURL(result.value.blob); urls.push(url);
            return `<img src="${esc(url)}" alt="${esc(result.value.name || `照片 ${index + 1}`)}">`;
          } catch { /* 损坏的附件不影响其他照片和正文。 */ }
        }
        return '<p class="sub">照片不可用</p>';
      }).join('');
    } catch {
      if (!disposed) content.innerHTML = '<p class="sub" role="status">记录暂时无法读取，请稍后重试</p>';
    }
  }
}
