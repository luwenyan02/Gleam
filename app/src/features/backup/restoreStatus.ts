/** 只保留两个时间边界，避免大账本展开参数或复制整组日期。 */
export function restoredEntryRange(entries: ReadonlyArray<{ occurredAt: number; deletedAt: number }>): string {
  let from = Infinity, to = -Infinity;
  for (const entry of entries) {
    if (entry.deletedAt !== 0 || !Number.isFinite(entry.occurredAt)
      || Math.abs(entry.occurredAt) > 8640000000000000) continue;
    from = Math.min(from, entry.occurredAt);
    to = Math.max(to, entry.occurredAt);
  }
  if (from === Infinity) return '无账单';
  const format = (time: number) => {
    const date = new Date(time);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  };
  return `${format(from)} ~ ${format(to)}`;
}

export function restoreFailureMessage(committed: boolean): { title: string; message: string } {
  return committed
    ? { title: '数据已恢复', message: '结果页面未能显示，请重新打开账本检查，请勿重复恢复。' }
    : { title: '恢复未完成', message: '原数据未被替换，可以检查备份文件后重试。' };
}
