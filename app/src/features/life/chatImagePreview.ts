import { iconHtml } from '../../assets/icons';
import { imageFileName, saveImageFile, shareImageFile, validateImageBlob } from '../../shared/imageExport';
import { closeSheet, openSheet } from '../shell/sheet';
import './chatImagePreview.css';

export interface ChatImagePreviewOptions {
  name: string;
  opener: HTMLElement;
  load(): Promise<Blob | undefined>;
}

/** 只读图片抽屉，沿用全局返回、Escape和焦点恢复；不写入聊天或账本。 */
export function openChatImagePreview(options: ChatImagePreviewOptions): void {
  let closed = false;
  let url: string | undefined;
  let blob: Blob | undefined;
  let busy = false;
  const release = () => { if (url) URL.revokeObjectURL(url); url = undefined; };
  openSheet({
    ariaLabel: '图片预览',
    opener: options.opener,
    onClose() { closed = true; blob = undefined; release(); },
    render(el) {
      el.innerHTML = `<div class="sheet-head chat-image-preview-head"><p class="sheet-title">图片预览</p><button type="button" class="icon-btn" data-image-close aria-label="关闭图片预览">${iconHtml('ic-close')}</button></div>
        <div class="chat-image-preview-body"><div class="chat-image-preview-stage"><img data-image-preview alt="" hidden></div></div>
        <p class="sub chat-image-preview-status" data-image-status role="status" aria-live="polite">正在读取图片…</p>
        <div class="chat-image-preview-actions"><button type="button" class="btn ghost" data-image-save disabled>保存图片</button><button type="button" class="btn primary" data-image-share disabled>分享图片</button></div>`;
      el.querySelector('[data-image-close]')!.addEventListener('click', closeSheet);
      const image = el.querySelector<HTMLImageElement>('[data-image-preview]')!;
      const status = el.querySelector<HTMLElement>('[data-image-status]')!;
      const buttons = [...el.querySelectorAll<HTMLButtonElement>('[data-image-save],[data-image-share]')];
      const setEnabled = () => { for (const button of buttons) button.disabled = !blob || busy; };
      const fail = (message: string) => {
        if (closed) return;
        blob = undefined; image.hidden = true; image.removeAttribute('src'); release();
        status.textContent = message; setEnabled();
      };
      image.onload = () => {
        if (closed) return;
        status.textContent = ''; image.hidden = false; setEnabled();
      };
      image.onerror = () => fail('图片已损坏或无法显示');
      async function load(): Promise<void> {
        try {
          const loaded = await options.load();
          if (closed) return;
          if (!loaded) { fail('图片已删除或不存在'); return; }
          try { validateImageBlob(loaded); }
          catch (error) { fail(error instanceof Error ? error.message : '图片不可用'); return; }
          if (closed) return;
          blob = loaded;
          image.alt = imageFileName(options.name, loaded.type);
          url = URL.createObjectURL(loaded);
          image.src = url;
        } catch { fail('图片暂时无法读取，请稍后重试'); }
      }
      for (const [index, button] of buttons.entries()) button.addEventListener('click', async () => {
        if (!blob || busy || closed) return;
        const heldFocus = document.activeElement === button;
        busy = true; setEnabled();
        status.textContent = index === 0 ? '正在保存图片…' : '正在打开分享…';
        try {
          const message = await (index === 0 ? saveImageFile : shareImageFile)(blob, options.name);
          if (!closed) status.textContent = message;
        } catch { if (!closed) status.textContent = index === 0 ? '图片保存失败，请重试' : '图片分享失败，请重试或保存图片'; }
        finally {
          busy = false;
          if (!closed) {
            setEnabled();
            // 禁用当前按钮会让浏览器把焦点丢到body，恢复后让Escape仍交给抽屉。
            // 用户已经选择其他控件时保留其焦点；关闭中的异步结果也不再抢焦点。
            if (heldFocus && button.isConnected && !button.disabled && (!document.activeElement || document.activeElement === document.body)) {
              button.focus({ preventScroll: true });
            }
          }
        }
      });
      void load();
    },
  });
}
