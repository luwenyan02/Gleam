/** Compact home-only navigation. The surrounding list retains native touch scrolling. */
export function bindHomeFastScroll(page: HTMLElement) {
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
  let frame = 0, settling = 0, hideTimer = 0;
  let revealed = false, held = false, keyboardFocus = false, userScroll = false;
  let lastY = page.scrollTop, lastAt = 0, fastSince = 0, lastFastAt = 0;
  let drag: { id: number; y: number; fraction: number; travel: number } | undefined;
  const range = () => Math.max(0, page.scrollHeight - page.clientHeight);
  const active = () => page.isConnected && !page.inert && page.classList.contains('is-active');
  const fraction = () => range() ? page.scrollTop / range() : 0;

  function hideLater() {
    window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => {
      userScroll = false; fastSince = 0;
      if (held || drag || (keyboardFocus && control.contains(document.activeElement))) return;
      revealed = false;
      update();
    }, 800);
  }
  function wake() {
    revealed = true;
    hideLater();
    schedule();
  }
  function update() {
    frame = 0;
    const extent = range();
    control.hidden = !revealed || !active() || extent < page.clientHeight * .8;
    top.disabled = page.scrollTop < 2;
    bottom.disabled = extent - page.scrollTop < 3;
    grip.setAttribute('aria-valuenow', String(Math.round(fraction() * 100)));
    grip.setAttribute('aria-valuetext', `${Math.round(fraction() * 100)}%，当前已加载的流水`);
  }
  function schedule() { if (!frame) frame = requestAnimationFrame(update); }
  function cancel() {
    cancelAnimationFrame(settling);
    settling = 0;
  }
  function move(value: number) {
    userScroll = false; fastSince = 0;
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
  bottom.addEventListener('click', () => { cancel(); userScroll = false; wake(); end(); });
  control.addEventListener('pointerdown', () => { held = true; keyboardFocus = false; });
  for (const event of ['pointerup', 'pointercancel']) window.addEventListener(event, () => {
    if (held) { held = false; hideLater(); }
  }, { passive: true });
  control.addEventListener('keydown', () => { keyboardFocus = true; wake(); });
  control.addEventListener('focusout', hideLater);
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
    event.preventDefault(); event.stopPropagation(); keyboardFocus = true; cancel(); wake();
    if (event.key === 'End') end();
    else move(event.key === 'Home' ? 0 : fraction() + step!);
  });
  // Cancel a pending jump as soon as the user resumes normal navigation.
  for (const event of ['pointerdown', 'touchstart', 'wheel', 'keydown']) {
    page.addEventListener(event, e => {
      if (!control.contains(e.target as Node)) {
        cancel();
        if (event === 'wheel' || event === 'touchstart' || (event === 'keydown' && ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes((e as KeyboardEvent).key))) {
          userScroll = true;
          if (!lastAt || performance.now() - lastAt > 200) { lastAt = performance.now(); lastY = page.scrollTop; fastSince = 0; }
        }
      }
    }, { passive: true });
  }
  page.addEventListener('scroll', () => {
    const now = performance.now(), elapsed = now - lastAt, distance = Math.abs(page.scrollTop - lastY);
    if (userScroll && active()) {
      if (elapsed > 0 && elapsed < 200 && distance / elapsed >= .5) {
        // Brief lift/re-touch gaps are still one sustained browsing gesture.
        if (!fastSince || now - lastFastAt > 250) fastSince = lastAt;
        lastFastAt = now;
        if (now - fastSince >= 1000) revealed = true;
      } else if (now - lastFastAt > 250) fastSince = 0;
      hideLater();
    }
    lastAt = now; lastY = page.scrollTop;
    schedule();
  }, { passive: true });
  new ResizeObserver(schedule).observe(page);
  new MutationObserver(() => {
    if (!active()) { cancel(); finishDrag(); revealed = false; userScroll = false; fastSince = 0; keyboardFocus = false; window.clearTimeout(hideTimer); }
    schedule();
  }).observe(page, { attributes: true, attributeFilter: ['class', 'inert'] });
  update();
  function end() {
    userScroll = false; fastSince = 0;
    // Only settle layout within the loaded list; never query or expand its date range.
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
  }
  return { refresh: schedule };
}
