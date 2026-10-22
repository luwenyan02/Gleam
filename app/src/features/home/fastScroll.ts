/** Compact home-only navigation. The surrounding list retains native touch scrolling. */
export function bindHomeFastScroll(page: HTMLElement, actions: { bottom(): void; cancel(): void }) {
  const anchor = document.createElement('div');
  anchor.className = 'hm-fast-anchor';
  anchor.innerHTML = `<div class="hm-fast-scroll" role="group" aria-label="快速浏览流水" hidden>
    <button type="button" data-fast-top aria-label="回到顶部" title="回到顶部"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 14 5-5 5 5M7 6h10"/></svg></button>
    <div class="hm-fast-grip" role="slider" tabindex="0" aria-label="拖动快速浏览流水" aria-orientation="vertical" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" title="上下拖动快速浏览">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 7h.01M15 7h.01M9 12h.01M15 12h.01M9 17h.01M15 17h.01"/></svg>
    </div>
    <button type="button" data-fast-bottom aria-label="直达底部" title="直达底部"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5M7 18h10"/></svg></button>
  </div>`;
  page.append(anchor);
  const control = anchor.firstElementChild as HTMLElement;
  const top = control.querySelector<HTMLButtonElement>('[data-fast-top]')!;
  const bottom = control.querySelector<HTMLButtonElement>('[data-fast-bottom]')!;
  const grip = control.querySelector<HTMLElement>('[role="slider"]')!;
  let exhausted = false, busy = false, frame = 0, settling = 0, fadeTimer = 0;
  let drag: { id: number; y: number; fraction: number; travel: number } | undefined;
  const range = () => Math.max(0, page.scrollHeight - page.clientHeight);
  const active = () => page.isConnected && !page.inert && page.classList.contains('is-active');
  const fraction = () => range() ? page.scrollTop / range() : 0;

  function wake() {
    control.classList.add('is-awake');
    window.clearTimeout(fadeTimer);
    fadeTimer = window.setTimeout(() => control.classList.remove('is-awake'), 1400);
  }
  function update() {
    frame = 0;
    control.hidden = !active() || (range() < page.clientHeight * .8 && exhausted);
    top.disabled = page.scrollTop < 2;
    bottom.disabled = busy || (exhausted && range() - page.scrollTop < 3);
    bottom.setAttribute('aria-busy', String(busy));
    grip.setAttribute('aria-valuenow', String(Math.round(fraction() * 100)));
    grip.setAttribute('aria-valuetext', `${Math.round(fraction() * 100)}%，当前已展开的流水`);
    control.classList.toggle('is-loading', busy);
  }
  function schedule() { if (!frame) frame = requestAnimationFrame(update); }
  function cancel() {
    cancelAnimationFrame(settling);
    settling = 0;
    actions.cancel();
  }
  function move(value: number) {
    cancelAnimationFrame(settling);
    const target = Math.max(0, Math.min(1, value));
    page.scrollTop = range() * target;
    update();
  }
  function finishDrag() {
    if (!drag) return;
    const id = drag.id;
    drag = undefined;
    if (grip.hasPointerCapture(id)) grip.releasePointerCapture(id);
    control.classList.remove('is-dragging');
    wake();
  }
  top.addEventListener('click', () => { cancel(); move(0); wake(); });
  bottom.addEventListener('click', () => { cancel(); wake(); actions.bottom(); });
  grip.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0) return;
    event.preventDefault(); cancel();
    grip.focus({ preventScroll: true });
    drag = { id: event.pointerId, y: event.clientY, fraction: fraction(), travel: Math.max(160, page.clientHeight * .6) };
    grip.setPointerCapture(event.pointerId);
    control.classList.add('is-dragging'); wake();
  });
  grip.addEventListener('pointermove', event => {
    if (!drag || drag.id !== event.pointerId) return;
    move(drag.fraction + (event.clientY - drag.y) / drag.travel);
  });
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) grip.addEventListener(event, finishDrag);
  grip.addEventListener('keydown', event => {
    const step = { ArrowUp: -.05, ArrowDown: .05, PageUp: -.2, PageDown: .2 }[event.key];
    if (step === undefined && !['Home', 'End'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation(); cancel(); wake();
    if (event.key === 'End') actions.bottom();
    else move(event.key === 'Home' ? 0 : fraction() + step!);
  });
  // Cancel a pending jump as soon as the user resumes normal navigation.
  for (const event of ['pointerdown', 'touchstart', 'wheel', 'keydown']) {
    page.addEventListener(event, e => {
      if (!control.contains(e.target as Node)) cancel();
    }, { passive: true });
  }
  page.addEventListener('scroll', () => { schedule(); wake(); }, { passive: true });
  new ResizeObserver(schedule).observe(page);
  new MutationObserver(() => {
    if (!active()) { cancel(); finishDrag(); }
    schedule();
  }).observe(page, { attributes: true, attributeFilter: ['class', 'inert'] });
  update();
  return {
    refresh(done: boolean, loading = false) { exhausted = done; busy = loading; schedule(); },
    end() {
      // Deferred offscreen row layout can change scrollHeight when jumping to old records.
      let previous = -1, stable = 0, frames = 0;
      const settle = () => {
        if (!active()) return;
        const height = range();
        page.scrollTop = height;
        stable = Math.abs(height - previous) < 1 ? stable + 1 : 0;
        previous = height; update();
        if (stable < 3 && ++frames < 30) settling = requestAnimationFrame(settle);
      };
      cancelAnimationFrame(settling); settle();
    },
  };
}
