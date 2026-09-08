/** 同文档弹层返回点：日期/选择器/抽屉先关闭自己，再返回其所属页面。 */
const KEY = 'gleamLayer';
interface Layer { id: string; cancel: () => void; pushed: boolean }
const layers: Layer[] = [];
const owned = new Set<string>();
const waitingWrites: (() => void)[] = [];
let sequence = 0;
let awaitingBack = false;

export function withoutLayerHistory(state: Record<string, unknown> | null): Record<string, unknown> {
  const next = { ...state };
  delete next[KEY];
  return next;
}

function flushHistoryWrites(): void {
  if (awaitingBack) return;
  while (waitingWrites.length && !awaitingBack) waitingWrites.shift()!();
}

/** 同步关闭抽屉并打开子页时，先完成回退，再写新页面，避免吞掉新历史点。 */
export function pushPageHistory(state: Record<string, unknown>): () => void {
  let active = true;
  waitingWrites.push(() => {
    if (active) window.history.pushState({ ...withoutLayerHistory(window.history.state), ...state }, '');
  });
  flushHistoryWrites();
  return () => { active = false; };
}

/** 关闭按钮/确认/系统返回都调用 release；手动关闭时回收同一个历史点。 */
export function trackHistoryLayer(cancel: () => void): () => void {
  const layer: Layer = { id: `${Date.now()}-${++sequence}`, cancel, pushed: false };
  layers.push(layer);
  waitingWrites.push(() => {
    if (!layers.includes(layer)) return;
    window.history.pushState({ ...window.history.state, [KEY]: layer.id }, '');
    layer.pushed = true;
    owned.add(layer.id);
  });
  flushHistoryWrites();
  return () => {
    const index = layers.indexOf(layer);
    if (index < 0) return;
    layers.splice(index, 1);
    if (layer.pushed && window.history.state?.[KEY] === layer.id && !awaitingBack) {
      awaitingBack = true;
      window.history.back();
    }
  };
}

/** 路由须先消费弹层历史，避免把它当成子页返回并遗留 inert 背景。 */
export function handleLayerHistory(state: Record<string, unknown> | null): boolean {
  const target = state?.[KEY];
  if (awaitingBack) {
    awaitingBack = false;
    // 多层在同一任务中关闭时，跳过已关闭的历史点，再挂载新打开的弹层。
    if (typeof target === 'string' && owned.has(target) && !layers.some(layer => layer.id === target)) {
      awaitingBack = true;
      window.history.back();
    } else {
      flushHistoryWrites();
    }
    return true;
  }
  let handled = false;
  for (let top = layers.at(-1); top?.pushed && top.id !== target; top = layers.at(-1)) {
    top.cancel();
    handled = true;
    if (layers.at(-1) === top) break;
  }
  // 前进到已销毁弹层时不重新打开它，也不保留失效的标记。
  if (target && !layers.some(layer => layer.id === target)) {
    window.history.replaceState(withoutLayerHistory(state), '');
  }
  return handled;
}
