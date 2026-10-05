import type { AiPendingItem } from './types';
import type { AiParsedBill } from './repo/aiRepo';

/** 语音来源的人工确认边界独立于模型置信度及用户自动阈值。 */
export function canAutoConfirmAiItem(item: AiPendingItem, threshold: number): boolean {
  return item.source !== 'voice' && item.status === 'ready' && (item.confidence ?? 0) >= threshold;
}

export function voiceDraftItem(bill: AiParsedBill, rawText: string): AiPendingItem {
  return { ...bill, tempId: crypto.randomUUID(), status: 'ready', source: 'voice', rawText, createdAt: Date.now() };
}
