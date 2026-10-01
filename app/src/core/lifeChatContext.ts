import type { LifeChatMessage } from './types';

/** 仅裁剪出站上下文，完整聊天始终留在本机。 */
export function recentChatContext(messages: LifeChatMessage[]): LifeChatMessage[] {
  let size = 0;
  const recent: LifeChatMessage[] = [];
  for (const message of messages.slice(-30).reverse()) {
    size += message.content.length + 80;
    if (size > 22_000) break;
    recent.unshift(message);
  }
  while (recent[0]?.role === 'assistant') recent.shift();
  return recent;
}
