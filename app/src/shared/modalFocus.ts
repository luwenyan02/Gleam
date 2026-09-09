const FOCUSABLE = [
  'button:not([disabled])',
  'a[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function visibleFocusable(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE)]
    .filter((item) => !item.closest('[hidden],[inert],[aria-hidden="true"]') && item.getClientRects().length > 0 && getComputedStyle(item).visibility !== 'hidden');
}

/** 锁定 Tab 焦点并支持 Escape；返回清理函数。 */
export function trapModalFocus(container: HTMLElement, onEscape: () => void): () => void {
  const controller = new AbortController();
  container.addEventListener('keydown', (event) => {
    if (event.defaultPrevented) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onEscape();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = visibleFocusable(container);
    if (!focusable.length) { event.preventDefault(); container.focus(); return; }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === container)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !container.contains(document.activeElement))) {
      event.preventDefault();
      first.focus();
    }
  }, { signal: controller.signal });
  const focusFirst = () => { if (container.isConnected && !controller.signal.aborted) (visibleFocusable(container)[0] ?? container).focus({preventScroll:true}); };
  // 已挂载时立即接管焦点，避免弹层可见但首个 Escape 仍发往背景页面。
  if (container.isConnected) focusFirst();
  const frame = container.isConnected ? 0 : requestAnimationFrame(focusFirst);
  return () => { cancelAnimationFrame(frame); controller.abort(); };
}

interface ElementState {
  element: HTMLElement;
  inert: boolean;
  ariaHidden: string | null;
}

/** 临时把 App 其余直接子节点移出焦点顺序和辅助技术树。 */
export function isolateModal(exempt: readonly HTMLElement[]): () => void {
  const app = document.querySelector<HTMLElement>('.app');
  if (!app) return () => undefined;
  const exemptSet = new Set(exempt);
  const states: ElementState[] = [];
  for (const element of app.children) {
    if (!(element instanceof HTMLElement) || exemptSet.has(element)) continue;
    states.push({ element, inert: element.inert, ariaHidden: element.getAttribute('aria-hidden') });
    element.inert = true;
    element.setAttribute('aria-hidden', 'true');
  }
  return () => {
    for (const state of states) {
      state.element.inert = state.inert;
      if (state.ariaHidden == null) state.element.removeAttribute('aria-hidden');
      else state.element.setAttribute('aria-hidden', state.ariaHidden);
    }
  };
}
