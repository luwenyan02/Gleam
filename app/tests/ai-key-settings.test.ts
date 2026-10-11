import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const mocks = vi.hoisted(() => ({ set: vi.fn(), remove: vi.fn(), emit: vi.fn(), toast: vi.fn() }));
vi.mock('../src/core/secretStore', () => ({ secretStore: { kind: 'android-keystore', set: mocks.set, remove: mocks.remove } }));
vi.mock('../src/core/store', () => ({ emit: mocks.emit }));
vi.mock('../src/features/shell/toast', () => ({ showToast: mocks.toast }));
import { maskSecret } from '../src/core/maskSecret';
import { aiKeyInputHtml, getAiKeySettingsEpoch, handleAiKeyChange, handleAiKeyInput, isAiKeyWritePending, preserveAiKeyDraft } from '../src/features/settings/aiKeySettings';

function input(value = '', placeholder = maskSecret('fixture-old-private-main-key')): HTMLInputElement {
  return { id: 'ai-key', value, placeholder, dataset: {}, focus: vi.fn() } as unknown as HTMLInputElement;
}
async function flush(): Promise<void> { for (let i = 0; i < 20; i++) await Promise.resolve(); }
beforeEach(() => { vi.clearAllMocks(); mocks.set.mockResolvedValue(undefined); mocks.remove.mockResolvedValue(undefined); });
afterEach(() => vi.unstubAllGlobals());

it.each([undefined, null, ''])('does not invent a saved-key summary for %s', value => expect(maskSecret(value)).toBe(''));
it.each(['a', '1234567890', '123456789012345', '🔑🔑🔑🔑🔑🔑🔑🔑🔑🔑'])('fully masks a short secret without length disclosure', value => {
  expect(maskSecret(value)).toBe('••••••');
  expect(maskSecret(value)).not.toContain(value);
});
it('shows exactly five Unicode code points at each end only for long keys', () => {
  expect(maskSecret('1234567890123456')).toBe('12345••••••23456');
  expect(maskSecret('12345-middle-hidden-67890')).toBe('12345••••••67890');
  expect(maskSecret('🔑甲乙丙丁-hidden-middle-戊己庚辛🔒')).toBe('🔑甲乙丙丁••••••戊己庚辛🔒');
});
it('renders only an empty password value and an escaped display-only summary', () => {
  const secret = '<&"\'a-middle-secret-z"\'&>';
  const html = aiKeyInputHtml(secret);
  expect(html).toContain('type="password" value=""');
  expect(html).toContain('placeholder="&lt;&amp;&quot;&#39;a••••••z&quot;&#39;&amp;&gt;"');
  expect(html).not.toContain(secret);
  expect(html).not.toContain('middle-secret');
});
it('untouched change or blur never deletes a saved key or persists a placeholder', async () => {
  const field = input();
  expect(handleAiKeyChange(field)).toBe(true);
  await flush();
  expect(mocks.set).not.toHaveBeenCalled(); expect(mocks.remove).not.toHaveBeenCalled();
  expect(field.value).toBe('');
});
it('clears typed credentials immediately when saving and only emits the setting name', async () => {
  let resolve!: () => void;
  mocks.set.mockImplementationOnce(() => new Promise<void>(done => { resolve = done; }));
  const secret = 'fixture-new-private-main-key';
  const field = input(secret); const epoch = getAiKeySettingsEpoch();
  expect(handleAiKeyInput(field)).toBe(true);
  expect(getAiKeySettingsEpoch()).toBeGreaterThan(epoch);
  handleAiKeyChange(field);
  expect(field.value).toBe(''); expect(isAiKeyWritePending()).toBe(true);
  expect(aiKeyInputHtml(secret)).not.toContain(secret);
  await flush(); expect(mocks.set).toHaveBeenCalledExactlyOnceWith('ai.apiKey', secret);
  resolve(); await flush();
  expect(isAiKeyWritePending()).toBe(false);
  expect(field.value).toBe(''); expect(field.placeholder).toBe(maskSecret(secret));
  expect(mocks.emit).toHaveBeenCalledWith('settings-changed', { key: 'ai.apiKey' });
  expect(JSON.stringify(mocks.toast.mock.calls)).not.toContain(secret);
});
it('never stores a displayed mask even if it is pasted or assigned into the input', async () => {
  const field = input(maskSecret('fixture-old-private-main-key'));
  handleAiKeyInput(field); handleAiKeyChange(field); await flush();
  expect(mocks.set).not.toHaveBeenCalled(); expect(mocks.remove).not.toHaveBeenCalled();
  expect(field.value).toBe('');
  expect(mocks.toast).toHaveBeenCalledWith('请输入完整的 API Key');
});
it('an explicitly edited empty value removes the key without saving a mask', async () => {
  const field = input(); handleAiKeyInput(field); handleAiKeyChange(field); await flush();
  expect(mocks.remove).toHaveBeenCalledExactlyOnceWith('ai.apiKey'); expect(mocks.set).not.toHaveBeenCalled();
  expect(field.placeholder).toBe('sk-...');
});
it('serializes superseded writes and only reports the newest successful save', async () => {
  const releases: (() => void)[] = [];
  mocks.set.mockImplementation(() => new Promise<void>(done => { releases.push(done); }));
  const field = input('fixture-first-private-key'); handleAiKeyInput(field); handleAiKeyChange(field); await flush();
  field.value = 'fixture-second-private-key'; handleAiKeyInput(field); handleAiKeyChange(field); await flush();
  expect(mocks.set).toHaveBeenCalledTimes(1);
  releases[0](); await flush(); expect(mocks.set).toHaveBeenCalledTimes(2);
  expect(isAiKeyWritePending()).toBe(true); expect(mocks.toast).not.toHaveBeenCalled();
  releases[1](); await flush();
  expect(mocks.set.mock.calls.map(call => call[1])).toEqual(['fixture-first-private-key', 'fixture-second-private-key']);
  expect(mocks.toast).toHaveBeenCalledExactlyOnceWith('API Key 已安全保存');
  expect(field.placeholder).toBe(maskSecret('fixture-second-private-key')); expect(field.value).toBe('');
});
it('a superseded save cannot clear or falsely report an unsaved newer draft', async () => {
  let resolve!: () => void;
  mocks.set.mockImplementationOnce(() => new Promise<void>(done => { resolve = done; }));
  const field = input('fixture-first-private-key'); handleAiKeyInput(field); handleAiKeyChange(field); await flush();
  field.value = 'fixture-unsaved-newer-key'; handleAiKeyInput(field);
  resolve(); await flush();
  expect(field.value).toBe('fixture-unsaved-newer-key'); expect(mocks.toast).not.toHaveBeenCalled();
  handleAiKeyChange(field); await flush();
});
it('failed writes sanitize errors, preserve the saved summary, and do not block a later save', async () => {
  const field = input('fixture-rejected-private-key'); const oldSummary = field.placeholder;
  mocks.set.mockRejectedValueOnce(new Error('fixture-rejected-private-key remote sensitive body'));
  handleAiKeyInput(field); handleAiKeyChange(field); await flush();
  expect(field.value).toBe(''); expect(field.placeholder).toBe(oldSummary); expect(isAiKeyWritePending()).toBe(false);
  expect(mocks.toast).toHaveBeenCalledExactlyOnceWith('API Key 保存失败，请重新输入');
  field.value = 'fixture-retry-private-key'; handleAiKeyInput(field); handleAiKeyChange(field); await flush();
  expect(field.placeholder).toBe(maskSecret('fixture-retry-private-key'));
});
it('rerender keeps only a user-edited input node, never reconstructing a raw saved-key value', () => {
  const field = input('fixture-unsaved-draft'); handleAiKeyInput(field);
  let current = field;
  const container = { isConnected: true, querySelector: () => current } as unknown as HTMLElement;
  const restore = preserveAiKeyDraft(container);
  const replacement = input('', 'replacement-masked-summary');
  replacement.replaceWith = vi.fn(node => { current = node as HTMLInputElement; });
  current = replacement; restore();
  expect(current).toBe(field); expect(current.value).toBe('fixture-unsaved-draft');
  expect(current.placeholder).toBe('replacement-masked-summary');
});
it('a focused empty editor survives the previous save refresh so the next masked paste is rejected', async () => {
  const secret = 'fixture-previously-saved-main-key';
  const field = input(secret); handleAiKeyInput(field); handleAiKeyChange(field); await flush();
  expect(field.value).toBe('');
  expect(mocks.toast).toHaveBeenLastCalledWith('API Key 已安全保存');
  // The next edit can focus the cleared field before the previous save's async
  // full-page render finishes, with text insertion still waiting for that focus.
  vi.stubGlobal('document', { activeElement: field });
  let current = field;
  const container = { isConnected: true, querySelector: () => current } as unknown as HTMLElement;
  const restore = preserveAiKeyDraft(container);
  handleAiKeyChange(field); // Render-induced focusout must not delete the saved key.
  const replacement = input('', maskSecret(secret));
  replacement.replaceWith = vi.fn(node => { current = node as HTMLInputElement; });
  current = replacement; restore();
  expect(current).toBe(field); expect(field.focus).toHaveBeenCalledWith({ preventScroll: true });
  expect(current.value).toBe('');
  current.value = maskSecret(secret);
  handleAiKeyInput(current); handleAiKeyChange(current); await flush();
  expect(mocks.set).toHaveBeenCalledExactlyOnceWith('ai.apiKey', secret);
  expect(mocks.remove).not.toHaveBeenCalled(); expect(current.value).toBe('');
  expect(mocks.toast).toHaveBeenLastCalledWith('请输入完整的 API Key');
});
it('preserving an empty focused editor does not make an untouched real blur delete its saved key', async () => {
  const field = input(); vi.stubGlobal('document', { activeElement: field });
  let current = field;
  const container = { isConnected: true, querySelector: () => current } as unknown as HTMLElement;
  const restore = preserveAiKeyDraft(container);
  const replacement = input(); replacement.replaceWith = vi.fn(node => { current = node as HTMLInputElement; });
  current = replacement; restore();
  expect(current).toBe(field);
  handleAiKeyChange(field); await flush();
  expect(mocks.set).not.toHaveBeenCalled(); expect(mocks.remove).not.toHaveBeenCalled();
  expect(mocks.toast).not.toHaveBeenCalled(); expect(field.value).toBe('');
});
it('render detachment change and focusout do not save a draft, but the later real blur saves exactly once', async () => {
  const draft = 'fixture-unsubmitted-main-key';
  const field = input(draft); handleAiKeyInput(field);
  vi.stubGlobal('document', { activeElement: field });
  let current = field;
  const container = { isConnected: true, querySelector: () => current } as unknown as HTMLElement;
  const restore = preserveAiKeyDraft(container);
  // Chromium commits native input editing when a full rerender removes the focused node.
  // Both change and focusout must remain inert throughout that render transaction.
  handleAiKeyChange(field); handleAiKeyChange(field);
  expect(field.value).toBe(draft); expect(isAiKeyWritePending()).toBe(false);
  const replacement = input(); replacement.replaceWith = vi.fn(node => { current = node as HTMLInputElement; });
  current = replacement; restore();
  expect(current).toBe(field); expect(field.focus).toHaveBeenCalledWith({ preventScroll: true });
  await flush(); expect(mocks.set).not.toHaveBeenCalled(); expect(mocks.remove).not.toHaveBeenCalled();
  // The native change flag may have been consumed by detachment. A real focusout must
  // still save the dirty draft, and a duplicate change must not produce another write.
  handleAiKeyChange(field); handleAiKeyChange(field); await flush();
  expect(mocks.set).toHaveBeenCalledExactlyOnceWith('ai.apiKey', draft);
  expect(field.value).toBe(''); expect(field.placeholder).toBe(maskSecret(draft));
});
it('repeated unrelated renders preserve a dirty draft until intentional blur', async () => {
  const draft = 'fixture-draft-through-refreshes';
  const field = input(draft); handleAiKeyInput(field);
  let current = field;
  const container = { isConnected: true, querySelector: () => current } as unknown as HTMLElement;
  for (let i = 0; i < 3; i++) {
    const restore = preserveAiKeyDraft(container);
    handleAiKeyChange(field);
    const replacement = input(); replacement.replaceWith = vi.fn(node => { current = node as HTMLInputElement; });
    current = replacement; restore();
    expect(current.value).toBe(draft);
  }
  await flush(); expect(mocks.set).not.toHaveBeenCalled();
  handleAiKeyChange(field); await flush();
  expect(mocks.set).toHaveBeenCalledExactlyOnceWith('ai.apiKey', draft);
});
it('a missing replacement ends render suppression instead of leaving the editor permanently blocked', async () => {
  const field = input('fixture-missing-replacement'); handleAiKeyInput(field);
  let current: HTMLInputElement | null = field;
  const container = { querySelector: () => current } as unknown as HTMLElement;
  const restore = preserveAiKeyDraft(container);
  handleAiKeyChange(field);
  current = null; restore();
  expect(mocks.set).not.toHaveBeenCalled();
  handleAiKeyChange(field); await flush();
  expect(mocks.set).toHaveBeenCalledExactlyOnceWith('ai.apiKey', 'fixture-missing-replacement');
});
it('rerender does not preserve an unfocused untouched input or reinsert a previously submitted key', async () => {
  const field = input('fixture-submitted-main-key');
  handleAiKeyInput(field); handleAiKeyChange(field); await flush();
  let current = field;
  const container = { querySelector: () => current } as unknown as HTMLElement;
  const restore = preserveAiKeyDraft(container);
  const replacement = input(); replacement.replaceWith = vi.fn(); current = replacement; restore();
  expect(replacement.replaceWith).not.toHaveBeenCalled(); expect(current.value).toBe('');
});
it('the settings surface uses the empty key editor, refresh epoch guard and raw-input invalidation', () => {
  const source = readFileSync('src/features/settings/settings.ts', 'utf8');
  expect(source).toContain('aiKeyInputHtml(aiKey)');
  expect(source).toContain('aiKeyEpoch !== getAiKeySettingsEpoch()');
  expect(source).toContain('preserveAiKeyDraft(el)');
  expect(source).toMatch(/addEventListener\('focusout',[\s\S]*?handleAiKeyChange\(/);
  expect(source).toMatch(/handleAiKeyInput\(t\)[\s\S]*?invalidateVoiceConnectionTest\(/);
  expect(source).not.toContain('value="${esc(aiKey');
});
