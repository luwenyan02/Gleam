/** Small measured blocks keep even a single very large day out of the DOM. */
export interface SearchWindowBlock {
  first: number;
  last: number;
  estimate: number;
  html(): string;
}

export interface SearchAnchor { index: number; top: number }

export function searchAnchor(container: HTMLElement, scroll: HTMLElement): SearchAnchor | undefined {
  const top = scroll.getBoundingClientRect().top;
  for (const row of container.querySelectorAll<HTMLElement>('[data-sr-index]')) {
    const rect = row.getBoundingClientRect();
    if (rect.bottom > top && rect.top < top + scroll.clientHeight) {
      return { index: Number(row.dataset.srIndex), top: rect.top - top };
    }
  }
}

export function restoreSearchAnchor(container: HTMLElement, scroll: HTMLElement, anchor?: SearchAnchor): void {
  if (!anchor) return;
  const row = container.querySelector<HTMLElement>(`[data-sr-index="${anchor.index}"]`);
  if (row) scroll.scrollTop += row.getBoundingClientRect().top - scroll.getBoundingClientRect().top - anchor.top;
}

/** Owns only the current viewport, its overscan, and at most one focus/gesture block. */
export function createSearchWindow(
  host: HTMLElement, scroll: HTMLElement, blocks: SearchWindowBlock[], initialAnchor?: SearchAnchor,
): { destroy(): void; focus(index: number, selector: string, preventScroll: boolean): void } {
  const heights = blocks.map(block => block.estimate);
  const offsets: number[] = [];
  const mounted = new Map<number, HTMLElement>();
  const subpage = scroll.closest<HTMLElement>('.subpage');
  let frame = 0;
  let destroyed = false;
  let pointerBlock: number | undefined;
  let savedAnchor = initialAnchor;
  let savedScrollTop = scroll.scrollTop;
  let resizing = false;
  let width = scroll.clientWidth;

  function position(): void {
    let height = 0;
    blocks.forEach((_, index) => { offsets[index] = height; height += heights[index]; });
    host.style.height = `${height}px`;
    for (const [index, node] of mounted) node.style.top = `${offsets[index]}px`;
  }

  function atOffset(offset: number): number {
    let low = 0, high = blocks.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >>> 1;
      if (offsets[middle] <= offset) low = middle;
      else high = middle - 1;
    }
    return low;
  }

  function blockOf(target: EventTarget | null): number | undefined {
    const block = target instanceof Element ? target.closest<HTMLElement>('.sr-window-block') : null;
    return block && host.contains(block) ? Number(block.dataset.block) : undefined;
  }

  function schedule(resize = false): void {
    if (destroyed) return;
    resizing ||= resize;
    if (!frame) frame = requestAnimationFrame(render);
  }

  const observer = new ResizeObserver(entries => {
    // Host height is owned here; observing it would create a render/resize cycle.
    const changedWidth = scroll.clientWidth !== width;
    if (changedWidth) {
      width = scroll.clientWidth;
      blocks.forEach((block, index) => { heights[index] = block.estimate; });
    }
    if (entries.length) schedule(true);
  });

  function mount(index: number): HTMLElement {
    const existing = mounted.get(index);
    if (existing) return existing;
    const node = document.createElement('div');
    node.className = 'sr-window-block';
    node.dataset.block = String(index);
    node.style.top = `${offsets[index]}px`;
    node.innerHTML = blocks[index].html();
    const next = [...mounted.keys()].filter(key => key > index).sort((a, b) => a - b)[0];
    host.insertBefore(node, next == null ? null : mounted.get(next)!);
    mounted.set(index, node);
    observer.observe(node);
    return node;
  }

  function render(): void {
    frame = 0;
    if (destroyed || !host.isConnected || subpage?.inert || !scroll.clientHeight) return;
    // A user scroll can happen after ResizeObserver queued this frame. Never restore
    // an older viewport in that case (especially a scrollbar jump to the other end).
    const anchor = resizing && Math.abs(scroll.scrollTop - savedScrollTop) < 1
      ? savedAnchor : searchAnchor(host, scroll);
    resizing = false;
    position();
    const top = scroll.getBoundingClientRect().top - host.getBoundingClientRect().top;
    const overscan = scroll.clientHeight;
    const first = atOffset(Math.max(0, top - overscan));
    const last = atOffset(top + scroll.clientHeight + overscan);
    const keep = new Set<number>();
    for (let index = first; index <= last; index++) keep.add(index);
    const focused = blockOf(document.activeElement);
    if (focused != null) keep.add(focused);
    if (pointerBlock != null) keep.add(pointerBlock);
    // An anchor may be outside the estimated window after resizing or replacing a small list.
    if (anchor) {
      const index = blocks.findIndex(block => block.first <= anchor.index && block.last >= anchor.index);
      if (index >= 0) keep.add(index);
    }
    for (const index of keep) mount(index);
    for (const [index, node] of mounted) {
      if (keep.has(index)) continue;
      observer.unobserve(node);
      node.remove();
      mounted.delete(index);
    }
    let changed = false;
    for (const [index, node] of mounted) {
      const height = node.getBoundingClientRect().height;
      if (height > 0 && Math.abs(height - heights[index]) > 0.5) { heights[index] = height; changed = true; }
    }
    if (changed) position();
    restoreSearchAnchor(host, scroll, anchor);
    savedAnchor = searchAnchor(host, scroll);
    savedScrollTop = scroll.scrollTop;
    if (changed) schedule();
  }

  function focusBlock(index: number, backwards: boolean): void {
    const node = mount(index);
    const buttons = node.querySelectorAll<HTMLButtonElement>('button:not([disabled])');
    (backwards ? buttons[buttons.length - 1] : buttons[0])?.focus();
    schedule();
  }

  function keydown(event: KeyboardEvent): void {
    if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target as HTMLElement;
    const index = blockOf(target);
    if (index != null) {
      const buttons = mounted.get(index)!.querySelectorAll<HTMLElement>('button:not([disabled])');
      const edge = event.shiftKey ? buttons[0] : buttons[buttons.length - 1];
      const next = index + (event.shiftKey ? -1 : 1);
      if (target === edge && next >= 0 && next < blocks.length) {
        // Keep native button order across the boundary, including swipe actions.
        event.preventDefault();
        focusBlock(next, event.shiftKey);
      }
    } else {
      const controls = [...scroll.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])')]
        .filter(node => !node.hidden && node.getClientRects().length);
      const next = controls[controls.indexOf(target) + (event.shiftKey ? -1 : 1)];
      if (next && host.contains(next)) {
        event.preventDefault();
        focusBlock(event.shiftKey ? blocks.length - 1 : 0, event.shiftKey);
      }
    }
  }

  const onScroll = () => schedule();
  const onFocus = () => schedule();
  const onPointerDown = (event: PointerEvent) => { pointerBlock = blockOf(event.target); };
  const onPointerEnd = () => { pointerBlock = undefined; schedule(); };
  const onFonts = () => schedule(true);
  const visibility = new MutationObserver(() => { if (!subpage?.inert) schedule(true); });
  if (subpage) visibility.observe(subpage, { attributes: true, attributeFilter: ['inert'] });
  observer.observe(scroll);
  scroll.addEventListener('scroll', onScroll, { passive: true });
  scroll.addEventListener('keydown', keydown);
  host.addEventListener('focusin', onFocus);
  host.addEventListener('focusout', onFocus);
  host.addEventListener('pointerdown', onPointerDown);
  document.addEventListener('pointerup', onPointerEnd);
  document.addEventListener('pointercancel', onPointerEnd);
  document.fonts.addEventListener('loadingdone', onFonts);
  position();
  if (initialAnchor) {
    const index = blocks.findIndex(block => block.first <= initialAnchor.index && block.last >= initialAnchor.index);
    if (index >= 0) { mount(index); restoreSearchAnchor(host, scroll, initialAnchor); }
  }
  render();

  return { focus(rowIndex, selector, preventScroll) {
    const index = blocks.findIndex(block => block.first <= rowIndex && block.last >= rowIndex);
    if (index >= 0) {
      mount(index).querySelector<HTMLElement>(`[data-sr-index="${rowIndex}"] ${selector}`)?.focus({ preventScroll });
      schedule();
    }
  }, destroy() {
    destroyed = true;
    cancelAnimationFrame(frame);
    observer.disconnect();
    visibility.disconnect();
    scroll.removeEventListener('scroll', onScroll);
    scroll.removeEventListener('keydown', keydown);
    host.removeEventListener('focusin', onFocus);
    host.removeEventListener('focusout', onFocus);
    host.removeEventListener('pointerdown', onPointerDown);
    document.removeEventListener('pointerup', onPointerEnd);
    document.removeEventListener('pointercancel', onPointerEnd);
    document.fonts.removeEventListener('loadingdone', onFonts);
  } };
}
