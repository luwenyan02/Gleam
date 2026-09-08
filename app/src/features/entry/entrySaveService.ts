import { saveEntryWithContext, type EntrySaveRequest } from '../../core/repo/entrySaveRepo';
export type PersistEntryRequest = EntrySaveRequest;

/** 保持调用方式兼容；复合写入交由仓库在同一事务内完成。 */
export async function persistEntry(request: PersistEntryRequest): Promise<'created' | 'updated'> {
  return saveEntryWithContext(request);
}
