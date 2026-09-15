import { esc } from '../../core/esc';
import { MAX_ENTRY_ATTACHMENTS, MAX_RECEIPT_BYTES, RECEIPT_MIME_TYPES } from '../../core/repo/entryAttachmentRepo';
import { manageOverlay } from '../../shared/overlay';
import { showToast } from '../shell/toast';
import './receipts.css';

export interface ReceiptDraft {
  id?: number;
  blob: Blob;
  name?: string;
  thumbnail?: string;
}

/** 验证可解码图片并生成小缩略图；取消选图不写数据库。 */
export async function prepareReceipt(file: File): Promise<ReceiptDraft> {
  if (!RECEIPT_MIME_TYPES.includes(file.type)) throw new Error('凭证仅支持 JPG、PNG、WebP 图片');
  if (!file.size || file.size > MAX_RECEIPT_BYTES) throw new Error('每张凭证须在 10 MB 以内');
  const bitmap = await createImageBitmap(file).catch(() => { throw new Error('图片无法读取，请换一张图片'); });
  try {
    if (bitmap.width * bitmap.height > 40_000_000) throw new Error('图片像素过大，请缩小后添加');
    const scale = Math.min(1, 240 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('无法生成图片预览');
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return { blob: file, name: file.name, thumbnail: canvas.toDataURL('image/jpeg', 0.75) };
  } finally { bitmap.close(); }
}

export function previewReceipt(receipt: ReceiptDraft): void {
  const root = document.createElement('div');
  root.className = 'receipt-preview';
  root.setAttribute('aria-label', '凭证原图');
  const url = URL.createObjectURL(receipt.blob);
  root.innerHTML = `<button type="button" aria-label="关闭凭证预览">关闭</button><img alt="${esc(receipt.name ?? '凭证原图')}">`;
  root.querySelector('img')!.src = url;
  const close = () => { release(); root.remove(); URL.revokeObjectURL(url); };
  const release = manageOverlay(root, close);
  root.querySelector('button')!.onclick = close;
  root.onclick = event => { if (event.target === root) close(); };
  document.body.appendChild(root);
}

export function receiptThumbnail(receipt: ReceiptDraft): string {
  // 备份内容不可注入任意 URL；老照片无缩略图时以占位按钮按需打开。
  return receipt.thumbnail?.match(/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/)
    ? `<img src="${receipt.thumbnail}" alt="">` : '<span>图片</span>';
}

export function mountReceiptEditor(host: HTMLElement, initial: ReceiptDraft[]): {
  values(): ReceiptDraft[];
  add(receipts: ReceiptDraft[]): void;
  clear(): void;
  dispose(): void;
} {
  let items: ReceiptDraft[] = [...initial];
  let disposed = false;
  let busy = false;
  let revision = 0;

  function render(): void {
    host.innerHTML = `<div class="receipt-heading"><span>凭证 · ${items.length}/${MAX_ENTRY_ATTACHMENTS}</span><button type="button" data-receipt-add ${busy || items.length >= MAX_ENTRY_ATTACHMENTS ? 'disabled' : ''}>添加图片</button></div>
      <input type="file" accept="image/jpeg,image/png,image/webp" multiple hidden aria-label="选择凭证图片">
      <div class="receipt-strip">${items.map((item, index) => `<div class="receipt-item">
        <button type="button" class="receipt-thumb" data-preview="${index}" aria-label="预览凭证 ${index + 1}">${receiptThumbnail(item)}</button>
        <div class="receipt-actions"><button type="button" data-before="${index}" aria-label="凭证 ${index + 1} 前移" ${busy || index === 0 ? 'disabled' : ''}>←</button><button type="button" data-replace="${index}" ${busy ? 'disabled' : ''}>替换</button><button type="button" data-remove="${index}" aria-label="移除凭证 ${index + 1}" ${busy ? 'disabled' : ''}>移除</button></div>
      </div>`).join('')}</div>`;
    const input = host.querySelector('input')!;
    let replaceIndex: number | undefined;
    host.querySelector<HTMLButtonElement>('[data-receipt-add]')!.onclick = () => { replaceIndex = undefined; input.multiple = true; input.click(); };
    host.querySelectorAll<HTMLButtonElement>('[data-preview]').forEach(button => button.onclick = () => previewReceipt(items[Number(button.dataset.preview)]!));
    host.querySelectorAll<HTMLButtonElement>('[data-remove]').forEach(button => button.onclick = () => { items.splice(Number(button.dataset.remove), 1); revision++; render(); });
    host.querySelectorAll<HTMLButtonElement>('[data-before]').forEach(button => button.onclick = () => {
      const index = Number(button.dataset.before);
      [items[index - 1], items[index]] = [items[index]!, items[index - 1]!]; revision++; render();
    });
    host.querySelectorAll<HTMLButtonElement>('[data-replace]').forEach(button => button.onclick = () => {
      replaceIndex = Number(button.dataset.replace); input.multiple = false; input.click();
    });
    input.onchange = async () => {
      const files = Array.from(input.files ?? []);
      if (!files.length || busy) return;
      if (files.length + items.length - (replaceIndex == null ? 0 : 1) > MAX_ENTRY_ATTACHMENTS) {
        showToast(`每笔最多 ${MAX_ENTRY_ATTACHMENTS} 张凭证`); input.value = ''; return;
      }
      const target = replaceIndex;
      const started = revision;
      busy = true; render();
      try {
        const prepared: ReceiptDraft[] = [];
        for (const file of files) prepared.push(await prepareReceipt(file));
        if (disposed || started !== revision) return;
        if (target == null) items.push(...prepared); else items.splice(target, 1, ...prepared);
      } catch (error) { if (!disposed) showToast(error instanceof Error ? error.message : String(error)); }
      finally { busy = false; if (!disposed) render(); }
    };
  }
  render();
  return {
    values() { if (busy) throw new Error('图片正在处理，请稍候保存'); return [...items]; },
    add(receipts) {
      if (busy) throw new Error('图片正在处理，请稍后再试');
      if (items.length + receipts.length > MAX_ENTRY_ATTACHMENTS) throw new Error(`每笔最多 ${MAX_ENTRY_ATTACHMENTS} 张凭证`);
      items.push(...receipts); revision++; render();
    },
    clear() { items = []; revision++; render(); },
    dispose() { disposed = true; revision++; items = []; },
  };
}
