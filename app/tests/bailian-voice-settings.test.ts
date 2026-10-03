import { expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ setKey: vi.fn(), clearKey: vi.fn(), emit: vi.fn(), toast: vi.fn() }));
vi.mock('../src/core/nativeSpeech', () => ({ nativeSpeech: { setKey: mocks.setKey, clearKey: mocks.clearKey } }));
vi.mock('../src/core/store', () => ({ emit: mocks.emit }));
vi.mock('../src/features/shell/toast', () => ({ showToast: mocks.toast }));
import { handleVoiceSettingsClick, isVoiceKeyWritePending } from '../src/features/settings/bailianVoiceSettings';

it('保存Key前立即清空输入，刷新后也不能恢复秘密或并发再次保存', async () => {
  let resolve!: (value: unknown) => void;
  mocks.setKey.mockImplementation(() => new Promise(done => { resolve = done; }));
  const oldInput = { value: 'synthetic-private-key', disabled: false };
  let current = oldInput;
  const button = { disabled: false };
  const target = { closest: (selector: string) => selector === '[data-voice-save-key]' ? button : null } as unknown as HTMLElement;
  const container = { querySelector: () => current } as unknown as HTMLElement;
  expect(handleVoiceSettingsClick(target, container)).toBe(true);
  expect(isVoiceKeyWritePending()).toBe(true);
  expect(oldInput).toEqual({ value: '', disabled: true });
  current = { value: 'unwanted-rerender-copy', disabled: false };
  const newButton = { disabled: false };
  const newTarget = { closest: (selector: string) => selector === '[data-voice-save-key]' ? newButton : null } as unknown as HTMLElement;
  handleVoiceSettingsClick(newTarget, container);
  expect(mocks.setKey).toHaveBeenCalledOnce();
  resolve({ supported: true, hasKey: true, credentialRevision: 'new' });
  await vi.waitFor(() => expect(isVoiceKeyWritePending()).toBe(false));
  expect(current.value).toBe(''); expect(oldInput.value).toBe('');
  expect(mocks.emit).toHaveBeenCalledWith('settings-changed');
  expect(JSON.stringify(mocks.toast.mock.calls)).not.toContain('synthetic-private-key');
});
