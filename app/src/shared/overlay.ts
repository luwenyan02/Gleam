import { trapModalFocus } from './modalFocus';
import { trackHistoryLayer } from './layerHistory';

const overlays: { root: HTMLElement; cancel: () => void }[] = [];

/** 供 Android 返回键使用，只取消最上层弹层。 */
export function dismissTopOverlay(): boolean {
  const top = overlays.at(-1);
  if (!top) return false;
  top.cancel();
  return true;
}

/** 兼容调用方先构建、再挂载的选择器；关闭时需调用返回的 release。 */
export function manageOverlay(root: HTMLElement, cancel: () => void, options: { modal?: boolean; opener?: HTMLElement } = {}): () => void {
  const opener = options.opener ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const item = { root, cancel };
  let released = false;
  let releaseFocus: () => void = () => {};
  const states: {element:HTMLElement;inert:boolean;hidden:string|null}[] = [];
  overlays.push(item);
  const releaseHistory = trackHistoryLayer(cancel);
  const escape = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || overlays.at(-1) !== item) return;
    event.preventDefault(); event.stopPropagation(); cancel();
  };
  const frame = requestAnimationFrame(() => {
    if (released || !root.isConnected) return;
    if (options.modal === false) {
      root.tabIndex = -1;
      document.addEventListener('keydown', escape, true);
      root.focus({ preventScroll: true });
      return;
    }
    root.setAttribute('role', root.getAttribute('role') ?? 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.tabIndex = -1;
    // 外置 wheel 隔离 .app；嵌套 picker 隔离 sheet 内兄弟，不能把父层一起 inert。
    for (let child: HTMLElement | null = root; child?.parentElement; child = child.parentElement) {
      for (const element of child.parentElement.children) {
        if (!(element instanceof HTMLElement) || element === child || element.id === 'toast'
          || ['SCRIPT','STYLE','LINK'].includes(element.tagName)) continue;
        states.push({element,inert:element.inert,hidden:element.getAttribute('aria-hidden')});
        element.inert = true; element.setAttribute('aria-hidden','true');
      }
      if (child.parentElement === document.body) break;
    }
    releaseFocus = trapModalFocus(root, cancel);
  });
  return () => {
    if (released) return;
    released = true; cancelAnimationFrame(frame); releaseFocus();
    document.removeEventListener('keydown', escape, true);
    const index = overlays.indexOf(item);
    if (index >= 0) overlays.splice(index,1);
    releaseHistory();
    for (const state of states.reverse()) {
      state.element.inert = state.inert;
      if (state.hidden == null) state.element.removeAttribute('aria-hidden');
      else state.element.setAttribute('aria-hidden',state.hidden);
    }
    root.inert = true;
    root.setAttribute('aria-hidden','true');
    requestAnimationFrame(() => {
      if (opener?.isConnected && !opener.closest('[inert]')) opener.focus({preventScroll:true});
    });
  };
}
