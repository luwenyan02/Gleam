import { afterEach, beforeEach, expect, it, vi } from 'vitest';

let api: typeof import('../src/shared/layerHistory');
let entries: Record<string, unknown>[], index: number, pendingBack: number, pendingForward: number;
function pop(delta: number) {
  index += delta;
  if (index < 0 || index >= entries.length) throw new Error('Invalid mock history movement');
  return api.handleLayerHistory(entries[index]);
}
function settle() { while (pendingBack > 0 || pendingForward > 0) { if (pendingBack > 0) { pendingBack--; pop(-1); } else { pendingForward--; pop(1); } } }
function layer() {
  const cancelled = vi.fn(() => release());
  const release = api.trackHistoryLayer(cancelled);
  return { cancelled, release, id: entries[index].gleamLayer };
}
beforeEach(async () => {
  vi.resetModules(); entries = [{ gleamDepth: 0 }]; index = 0; pendingBack = 0; pendingForward = 0;
  vi.stubGlobal('window', { history: {
    get state() { return entries[index]; },
    pushState(state: Record<string, unknown>) { entries.splice(index + 1); entries.push(state); index++; },
    replaceState(state: Record<string, unknown>) { entries[index] = state; },
    back() { pendingBack++; },
    forward() { pendingForward++; },
  } });
  api = await import('../src/shared/layerHistory');
});
afterEach(() => { vi.unstubAllGlobals(); });

it('Back closes only voice; Forward to its destroyed marker preserves the underlying draft layer', () => {
  const entry = layer(), voice = layer();
  pop(-1); expect(voice.cancelled).toHaveBeenCalledOnce(); expect(entry.cancelled).not.toHaveBeenCalled();
  pop(1); settle();
  expect(voice.cancelled).toHaveBeenCalledOnce(); expect(entry.cancelled).not.toHaveBeenCalled();
  expect(entries[index].gleamLayer).toBe(entry.id);
  // The next Back still closes the one remaining layer, without an extra dead history stop.
  pop(-1); expect(entry.cancelled).toHaveBeenCalledOnce(); expect(index).toBe(0);
});
it('repeated Forward cannot restart a dismissed overlay or discard a live lower layer', () => {
  const lower = layer(), upper = layer(); pop(-1);
  for (let i = 0; i < 3; i++) { pop(1); settle(); }
  expect(upper.cancelled).toHaveBeenCalledOnce(); expect(lower.cancelled).not.toHaveBeenCalled();
  expect(index).toBe(1);
});
it('manual close and multi-layer cleanup still return to the live history point', () => {
  const lower = layer(), upper = layer(); upper.release(); lower.release(); settle();
  expect(index).toBe(0); expect(lower.cancelled).not.toHaveBeenCalled(); expect(upper.cancelled).not.toHaveBeenCalled();
  expect(pop(1)).toBe(false); settle(); expect(entries[index].gleamLayer).toBeUndefined();
});
it('a valid Back can still dismiss multiple current layers to reach the actual page', () => {
  const lower = layer(), upper = layer(); pop(-2);
  expect(upper.cancelled).toHaveBeenCalledOnce(); expect(lower.cancelled).toHaveBeenCalledOnce(); expect(index).toBe(0);
});
it('newer page writes queued during dismissal wait for history to settle', () => {
  const lower = layer(), upper = layer(); upper.release(); lower.release();
  api.pushPageHistory({ gleamDepth: 1 }); settle();
  expect(index).toBe(1); expect(entries[index]).toEqual({ gleamDepth: 1 });
});
it('unknown markers keep prior routing behavior instead of invoking the owned stale-Forward branch', () => {
  const lower = layer(), upper = layer();
  entries.push({ gleamDepth: 0, gleamLayer: 'unknown-history-marker' }); pop(1);
  expect(upper.cancelled).toHaveBeenCalledOnce(); expect(lower.cancelled).toHaveBeenCalledOnce();
  expect(pendingBack).toBe(0); expect(entries[index].gleamLayer).toBeUndefined();
});
it('a stale marker with no live layers permits the router to reconcile its subpage depth', () => {
  entries[0] = { gleamDepth: 2, extra: 'preserved' }; const upper = layer(); upper.release(); settle();
  expect(pop(1)).toBe(false);
  expect(entries[index]).toEqual({ gleamDepth: 2, extra: 'preserved' });
});
it('manual closing after rejected Forward preserves queued navigation and performs no extra cancellation', () => {
  const lower = layer(), upper = layer(); pop(-1); pop(1);
  lower.release(); api.pushPageHistory({ gleamDepth: 1 }); settle();
  expect(upper.cancelled).toHaveBeenCalledOnce(); expect(lower.cancelled).not.toHaveBeenCalled();
  expect(entries[index]).toEqual({ gleamDepth: 1 }); expect(index).toBe(1);
});
it('Back through a removed non-top marker closes newer live layers before keeping the surviving lower layer', () => {
  const lower = layer(), middle = layer(), upper = layer(); middle.release();
  expect(pendingBack).toBe(0); pop(-1); settle();
  expect(upper.cancelled).toHaveBeenCalledOnce(); expect(lower.cancelled).not.toHaveBeenCalled();
  expect(middle.cancelled).not.toHaveBeenCalled(); expect(entries[index].gleamLayer).toBe(lower.id);
  pop(-1); expect(lower.cancelled).toHaveBeenCalledOnce();
});

it('a blocking restore layer restores its history point after each browser Back', () => {
  api.pushPageHistory({ gleamDepth: 1 });
  const cancel = vi.fn();
  const release = api.trackHistoryLayer(cancel, { blockBack: true });
  const marker = entries[index].gleamLayer;
  for (let i = 0; i < 3; i++) {
    expect(pop(-1)).toBe(true); settle();
    expect(index).toBe(2); expect(entries[index].gleamLayer).toBe(marker);
  }
  release(); settle();
  expect(index).toBe(1); expect(entries[index]).toEqual({ gleamDepth: 1 });
});
it('finishing restore while Back is being rejected cleans up before the result layer opens', () => {
  api.pushPageHistory({ gleamDepth: 1 });
  const release = api.trackHistoryLayer(() => {}, { blockBack: true });
  pop(-1); release();
  const result = layer(); settle();
  expect(index).toBe(2);
  result.release(); settle();
  expect(index).toBe(1); expect(entries[index]).toEqual({ gleamDepth: 1 });
});
