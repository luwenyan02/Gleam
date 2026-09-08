import Dexie from 'dexie';
import { emit, type AppEvent } from '../store';

/** 嵌套仓库写入仅在最外层事务提交后通知 UI，回滚时不发布成功事件。 */
export function emitAfterCommit(event: AppEvent, payload?: unknown): void {
  let transaction = Dexie.currentTransaction;
  if (!transaction) { emit(event, payload); return; }
  while (transaction.parent) transaction = transaction.parent;
  transaction.on('complete', () => Dexie.ignoreTransaction(() => emit(event, payload)));
}
