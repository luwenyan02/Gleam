/**
 * 拾光 · 确认对话框工具
 * Promise 风格：await confirmDialog(...) 得到 true/false。
 * DOM 节点由 shell 挂载（#dialog-scrim）。
 */
import { esc } from '../../core/esc';

/** 对话框选项 */
export interface ConfirmOptions {
  title: string;
  /** 说明文字（可选） */
  message?: string;
  /** 确认按钮文案，默认「确定」 */
  okText?: string;
  /** 取消按钮文案，默认「取消」 */
  cancelText?: string;
  /** 危险操作（确认按钮红色语义，如删除） */
  danger?: boolean;
}

/**
 * 弹出确认对话框。
 * @returns 用户点确认为 true；取消/点遮罩为 false
 */
export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  const scrim = document.getElementById('dialog-scrim');
  if (!scrim) return Promise.resolve(false);
  return new Promise((resolve) => {
    scrim.innerHTML = `
      <div class="dialog" role="alertdialog" aria-modal="true" aria-label="${esc(opts.title)}">
        <h3>${esc(opts.title)}</h3>
        ${opts.message ? `<p class="sub">${esc(opts.message)}</p>` : ''}
        <div class="dialog-btns">
          <button class="btn ghost" data-act="cancel">${esc(opts.cancelText ?? '取消')}</button>
          <button class="btn primary" data-act="ok" ${opts.danger ? 'style="background:var(--over)"' : ''}>${esc(opts.okText ?? '确定')}</button>
        </div>
      </div>`;
    scrim.classList.add('show');
    const close = (result: boolean) => {
      scrim.classList.remove('show');
      resolve(result);
    };
    scrim.onclick = (e) => {
      const target = e.target as HTMLElement;
      const act = target.closest('[data-act]')?.getAttribute('data-act');
      if (act === 'ok') close(true);
      else if (act === 'cancel' || target === scrim) close(false);
    };
  });
}
