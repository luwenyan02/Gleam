/** 使用设备本地时区；旧消息不伪造时间。 */
export function formatChatReplyTime(repliedAt?: number): string {
  if (repliedAt == null || !Number.isFinite(repliedAt) || repliedAt <= 0) return '';
  const date = new Date(repliedAt);
  if (!Number.isFinite(date.getTime())) return '';
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
