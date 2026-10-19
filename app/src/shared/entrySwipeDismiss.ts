import { trackHistoryLayer } from './layerHistory';

let opened: HTMLElement | undefined;
let releaseHistory: (() => void) | undefined;
let observer: MutationObserver | undefined;
let initialized = false;

/** 收起操作栏只消费当前临时状态，不关闭流水页或退出应用。 */
export function dismissEntrySwipe(): boolean {
  if (!opened) return false;
  const visible = opened.isConnected && opened.classList.contains('swipe-open');
  opened.classList.remove('swipe-open');
  opened = undefined;
  observer?.disconnect();
  const release = releaseHistory;
  releaseHistory = undefined;
  release?.();
  return visible;
}

export function revealEntrySwipe(row: HTMLElement): void {
  if (opened === row) return;
  dismissEntrySwipe();
  opened = row;
  row.classList.add('swipe-open');
  releaseHistory = trackHistoryLayer(dismissEntrySwipe);
  observer ??= new MutationObserver(() => {
    if (opened && !opened.isConnected) dismissEntrySwipe();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  if (initialized) return;
  initialized = true;
  const outside = (event: Event) => {
    if (opened && event.target instanceof Node && !opened.contains(event.target)) dismissEntrySwipe();
  };
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('click', event => {
    // 指针点击已在按下时处理；横滑捕获会把松手后的 click 派发到列表容器。
    if (event.detail === 0) outside(event);
  }, true);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && dismissEntrySwipe()) event.preventDefault();
  });
}
