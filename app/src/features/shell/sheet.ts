/**
 * 拾光 · 底部抽屉（modal sheet）容器
 * 遮罩 #scrim + 容器 #sheet 由 shell 挂载。同一时间只开一个抽屉；
 * 内容由调用方 render 到容器（结构参考原型 .sheet-head/.sheet-scroll）。
 */

/** 打开抽屉的选项 */
export interface SheetOptions {
  /** 无障碍标签 */
  ariaLabel: string;
  /** 渲染抽屉内容（el 为 .sheet 容器，已清空） */
  render(el: HTMLElement): void;
  /** 关闭后回调（含点遮罩关闭） */
  onClose?(): void;
}

let current: SheetOptions | undefined;

/**
 * 打开底部抽屉（已开启时先关闭旧的）。
 */
export function openSheet(opts: SheetOptions): void {
  const sheet = document.getElementById('sheet');
  const scrim = document.getElementById('scrim');
  if (!sheet || !scrim) return;
  current = opts;
  sheet.setAttribute('aria-label', opts.ariaLabel);
  sheet.innerHTML = '';
  opts.render(sheet);
  scrim.classList.add('show');
  sheet.classList.add('open');
}

/** 关闭当前抽屉 */
export function closeSheet(): void {
  const sheet = document.getElementById('sheet');
  const scrim = document.getElementById('scrim');
  if (!sheet || !scrim) return;
  scrim.classList.remove('show');
  sheet.classList.remove('open');
  current?.onClose?.();
  current = undefined;
}

/** 抽屉是否开启 */
export function isSheetOpen(): boolean {
  return !!current;
}

/** 初始化：点遮罩关闭（shell 挂载后调用一次） */
export function initSheet(): void {
  document.getElementById('scrim')?.addEventListener('click', closeSheet);
}
