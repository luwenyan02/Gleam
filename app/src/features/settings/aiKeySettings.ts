import { esc } from '../../core/esc';
import { maskSecret, SECRET_MASK } from '../../core/maskSecret';
import { secretStore } from '../../core/secretStore';
import { emit } from '../../core/store';
import { showToast } from '../shell/toast';

const dirtyInputs = new WeakSet<HTMLInputElement>();
const renderingInputs = new WeakSet<HTMLInputElement>();
let epoch = 0;
let editRevision = 0;
let writeRevision = 0;
let pendingWrites = 0;
let writeQueue: Promise<void> = Promise.resolve();

export function getAiKeySettingsEpoch(): number { return epoch; }
export function isAiKeyWritePending(): boolean { return pendingWrites > 0; }

/** Stored keys are summarized only in the placeholder, never in value or dataset. */
export function aiKeyInputHtml(savedKey: string | null): string {
  const placeholder = pendingWrites ? 'API Key 保存中…' : maskSecret(savedKey) || 'sk-...';
  return `<input id="ai-key" type="password" value="" placeholder="${esc(placeholder)}" autocomplete="new-password" autocapitalize="off" spellcheck="false">`;
}

export function handleAiKeyInput(input: HTMLInputElement): boolean {
  if (input.id !== 'ai-key') return false;
  dirtyInputs.add(input);
  editRevision++; epoch++;
  return true;
}

/** Preserve the user's focused editor or live draft through full-page settings refreshes. */
export function preserveAiKeyDraft(container: HTMLElement): () => void {
  const input = container.querySelector<HTMLInputElement>('#ai-key');
  if (!input) return () => {};
  const focused = typeof document !== 'undefined' && document.activeElement === input;
  // A new edit may have focused the empty field before its first input event.
  // Keep that node too, or a pending save refresh can steal focus before typing/paste.
  if (!focused && !dirtyInputs.has(input)) return () => {};
  // Removing a focused input may synchronously dispatch change/focusout. This is
  // a render transaction, not the user's decision to finish editing their key.
  renderingInputs.add(input);
  return () => {
    try {
      const replacement = container.querySelector<HTMLInputElement>('#ai-key');
      if (!replacement || (!focused && !dirtyInputs.has(input))) return;
      input.placeholder = replacement.placeholder;
      replacement.replaceWith(input);
      if (focused && container.isConnected) input.focus({ preventScroll: true });
    } finally {
      renderingInputs.delete(input);
    }
  };
}

/** Main credentials still auto-save on change/blur, but an untouched empty field is inert. */
export function handleAiKeyChange(input: HTMLInputElement): boolean {
  if (input.id !== 'ai-key') return false;
  if (renderingInputs.has(input)) return true;
  if (!dirtyInputs.has(input)) return true;
  dirtyInputs.delete(input);
  const value = input.value.trim();
  // Clear immediately: saved or rejected credentials must not linger in an input value.
  input.value = '';
  epoch++;
  if (value.includes(SECRET_MASK)) {
    showToast('请输入完整的 API Key');
    return true;
  }
  const request = ++writeRevision;
  const edit = editRevision;
  pendingWrites++;
  // Native writes may resolve out of order. Serialize them so the newest requested key wins.
  writeQueue = writeQueue.then(async () => {
    try {
      if (value) await secretStore.set('ai.apiKey', value);
      else await secretStore.remove('ai.apiKey');
      input.placeholder = maskSecret(value) || 'sk-...';
      if (request === writeRevision && edit === editRevision) {
        showToast(value
          ? secretStore.kind === 'session' ? 'API Key 仅在当前会话有效' : 'API Key 已安全保存'
          : 'API Key 已清除');
      }
    } catch {
      if (request === writeRevision && edit === editRevision) showToast('API Key 保存失败，请重新输入');
    } finally {
      pendingWrites--; epoch++;
      // Re-read readiness even on failure; a prior queued write may have succeeded.
      emit('settings-changed', { key: 'ai.apiKey' });
    }
  });
  return true;
}
