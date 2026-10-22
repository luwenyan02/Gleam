/** Long histories keep lightweight slots; only nearby rows become interactive DOM. */
export function bindTimelineRows(page: HTMLElement) {
  const blocks = new Map<string, { render(): string; height: number; mounted: boolean }>();
  let nextId = 0;
  const sizes = new ResizeObserver(entries => {
    for (const entry of entries) {
      const block = blocks.get((entry.target as HTMLElement).dataset.homeRows!);
      if (block?.mounted && entry.contentRect.height > 0) block.height = entry.contentRect.height;
    }
  });
  const visibility = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const node = entry.target as HTMLElement;
      const block = blocks.get(node.dataset.homeRows!);
      if (!block || !node.isConnected) continue;
      if (entry.isIntersecting) {
        if (block.mounted) continue;
        block.height = entry.boundingClientRect.height;
        block.mounted = true;
        node.innerHTML = block.render();
        node.style.height = '';
        sizes.observe(node);
      } else if (block.mounted && !node.contains(document.activeElement) && !node.querySelector('.swipe-open')) {
        sizes.unobserve(node);
        // Use the last measured height, even when the whole home page is hidden.
        node.style.height = `${block.height}px`;
        node.replaceChildren();
        block.mounted = false;
      }
    }
  }, { root: page, rootMargin: '700px 0px' });
  return {
    reset() { visibility.disconnect(); sizes.disconnect(); blocks.clear(); nextId = 0; },
    slot(count: number, render: () => string, hasEntries: boolean): string {
      const id = String(nextId++);
      blocks.set(id, { render, height: 0, mounted: false });
      return `<div class="hm-row-block" data-home-rows="${id}"${hasEntries ? ' data-has-bill' : ''} style="height:calc(${count} * (44px * var(--seed-type) + 24px * var(--seed-density)))"></div>`;
    },
    observe() {
      for (const node of page.querySelectorAll<HTMLElement>('[data-home-rows]')) visibility.observe(node);
    },
  };
}
