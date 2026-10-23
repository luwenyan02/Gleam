/** 设备侧状态不进入账本备份；恢复别处的账本不能替这台设备标记成功。 */
const LAST_BACKUP = 'gleam.backup.lastLocalSuccess';
const DISMISSED_AT = 'gleam.backup.reminderDismissedAt';
const WEEK = 7 * 86400000;
const memory = new Map<string, number>();

function readTime(key: string): number {
  let value = 0;
  try { value = Number(localStorage.getItem(key)); } catch { /* 禁用存储时沿用本次会话。 */ }
  return Math.max(memory.get(key) ?? 0, Number.isFinite(value) && value > 0 ? value : 0);
}

function writeTime(key: string, at: number): void {
  if (!Number.isFinite(at) || at <= 0) return;
  memory.set(key, at);
  try { localStorage.setItem(key, String(at)); } catch { /* 满额或不可用不阻断已成功的备份。 */ }
}

export function rememberLocalBackup(at = Date.now()): void { writeTime(LAST_BACKUP, at); }
export function getRememberedLocalBackup(): number { return readTime(LAST_BACKUP); }
export function dismissBackupReminder(at = Date.now()): void { writeTime(DISMISSED_AT, at); }

export function shouldRemindBackup(lastAt: number, hasData: boolean, now = Date.now()): boolean {
  const dismissedAt = readTime(DISMISSED_AT);
  return hasData && (!lastAt || now - lastAt >= WEEK) && (!dismissedAt || now - dismissedAt >= WEEK);
}
