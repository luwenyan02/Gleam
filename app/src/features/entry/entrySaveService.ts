import type { NewEntry } from '../../core/repo/entryRepo';
import { addEntry, updateEntry } from '../../core/repo/entryRepo';
import { touchMerchant } from '../../core/repo/merchantRepo';

export interface PersistEntryRequest {
  editingId?: number;
  entry: NewEntry;
  tagIds: number[];
  originalMerchantId?: number;
}

/** 保存服务只负责事务仓库调用与商家使用次数，不持有界面状态。 */
export async function persistEntry(request: PersistEntryRequest): Promise<'created' | 'updated'> {
  if (request.editingId != null) {
    await updateEntry(request.editingId, request.entry, request.tagIds);
    if (request.entry.merchantId != null && request.entry.merchantId !== request.originalMerchantId) {
      await touchMerchant(request.entry.merchantId);
    }
    return 'updated';
  }
  await addEntry(request.entry, request.tagIds);
  if (request.entry.merchantId != null) await touchMerchant(request.entry.merchantId);
  return 'created';
}
