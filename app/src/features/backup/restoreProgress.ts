import { manageOverlay } from '../../shared/overlay';
import type { RestoreProgress } from '../../core/repo/backupRepo';

/** 恢复写入时阻止重复操作和返回，事务结束后恢复原页面焦点。 */
export function openRestoreProgress(label: string) {
  const root = document.createElement('div');
  root.className = 'dialog-scrim show restore-progress';
  root.setAttribute('aria-label', '恢复备份');
  root.innerHTML = '<div class="dialog"><h3>恢复备份</h3><p class="sub" role="status" aria-live="polite" data-restore-stage></p><progress aria-label="恢复进度"></progress><p class="sub num" data-restore-count></p><p class="tiny">请保持应用打开，完成后会显示结果。</p></div>';
  document.querySelector('.app')!.appendChild(root);
  const stage = root.querySelector<HTMLElement>('[data-restore-stage]')!;
  const count = root.querySelector<HTMLElement>('[data-restore-count]')!;
  const progress = root.querySelector('progress')!;
  const release = manageOverlay(root, () => {}, { blockBack: true });
  const update = (text: string, values?: RestoreProgress) => {
    if (stage.textContent !== text) stage.textContent = text;
    if (values) {
      progress.max = Math.max(1, values.total);
      progress.value = values.completed;
      count.textContent = `${values.completed.toLocaleString('zh-CN')} / ${values.total.toLocaleString('zh-CN')} 条数据`;
    } else {
      progress.removeAttribute('value'); count.textContent = '';
    }
  };
  update(label);
  let closed = false;
  return { update, close() { if (!closed) { closed = true; release(); root.remove(); } } };
}
