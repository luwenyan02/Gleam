/**
 * 导入保存的最外层事务边界。
 * 前置快照由调用方在事务外完成；映射创建、查重、入账、商家计数与 AI 队列消费共用此事务。
 */
import { db } from '../db';
import Dexie from 'dexie';
import { collectUnreferencedAttachments } from './entryAttachmentRepo';
import { emitAfterCommit } from './transactionEvents';
import { accountEffects } from '../entryEffects';
import type { Account, Entry } from '../types';

export interface ImportBalanceCheck { name: string; before: number; change: number; after: number }
export async function verifyImportBalances(before: Account[], entries: Entry[]): Promise<ImportBalanceCheck[]> {
  const deltas = new Map<number, number>();
  for (const entry of entries) for (const effect of accountEffects(entry)) {
    deltas.set(effect.accountId, (deltas.get(effect.accountId) ?? 0) + effect.delta);
  }
  const initial = new Map(before.map(account => [account.id, account.balance]));
  const accounts = await db.accounts.bulkGet([...deltas.keys()]);
  return accounts.map(account => {
    if (!account || !initial.has(account.id)) throw new Error('账户核对缺少导入前余额');
    const start = initial.get(account.id)!;
    const change = deltas.get(account.id)!;
    if (account.balance !== start + change) throw new Error('导入后账户余额核对不一致');
    return { name: account.name, before: start, change, after: account.balance };
  });
}

const LEDGER_TABLES = [
  'entries', 'accounts', 'categories', 'entryTags', 'entryAttachments', 'importBatches',
  'loanContacts', 'budgets', 'categoryBudgets', 'recurringRules', 'quickTemplates',
  'tags', 'merchants', 'creditStatements', 'creditPayments',
] as const;

/** 仅在带快照的导入写事务中调用；生活正文/照片、偏好与凭据均保留。 */
export async function clearLedgerForImport(): Promise<void> {
  if (!Dexie.currentTransaction) throw new Error('替换账本必须在导入事务内执行');
  const attachmentIds = await db.attachments.toCollection().primaryKeys();
  for (const name of LEDGER_TABLES) await db.table(name).clear();
  // 这些是旧账本引用或待入账数据，不是用户偏好/密钥。
  await db.settings.bulkDelete(['entry.lastUsed', 'entry.recentTemplates', 'recurring.pendingConfirms', 'ai.pendingItems']);
  await db.lifeDrafts.toCollection().modify((draft) => { delete draft.entryId; });
  await collectUnreferencedAttachments(attachmentIds);
  for (const event of ['entries-changed', 'accounts-changed', 'categories-changed', 'budgets-changed', 'templates-changed', 'credit-changed', 'settings-changed'] as const) {
    emitAfterCommit(event);
  }
}

export async function saveImportAtomically<T>(operation: () => Promise<T>): Promise<T> {
  return db.transaction(
    'rw',
    [
      ...LEDGER_TABLES.map(name => db.table(name)), db.settings, db.attachments,
      db.lifeNotes, db.lifeDrafts, db.lifeEditions,
    ],
    operation,
  );
}
