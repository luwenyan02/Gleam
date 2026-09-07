/** 应收应付账户仓库：全部余额与流水来自 accounts/entries，不使用独立对象。 */
import { db, stamp } from '../db';
import { emit } from '../store';
import type { Account, Entry } from '../types';
import { deleteAccount, updateAccount } from './accountRepo';

export async function listLoanAccounts(includeHidden = true): Promise<Account[]> {
  const rows = await db.accounts.where('group').equals('receivable').toArray();
  return rows.filter(account => includeHidden || !account.hidden).sort((a,b) => a.name.localeCompare(b.name,'zh-CN'));
}

export async function getLoanAccount(id: number): Promise<Account | undefined> {
  const account = await db.accounts.get(id);
  return account?.group === 'receivable' ? account : undefined;
}

/** 同名普通账户不是往来账户；只在应收应付分组内去重。 */
export async function ensureLoanAccount(name: string): Promise<number> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('应收应付账户名不能为空');
  const id = await db.transaction('rw', db.accounts, async () => {
    const matches = await db.accounts.where('group').equals('receivable').filter(account => account.name === trimmed).toArray();
    if (matches.length > 1) throw new Error('存在多个同名应收应付账户，请直接选择具体账户');
    if (matches.length === 1) {
      if (matches[0].hidden) throw new Error('同名应收应付账户已隐藏，请到账户页恢复显示');
      return matches[0].id;
    }
    const sortOrder = ((await db.accounts.orderBy('sortOrder').last())?.sortOrder ?? 0) + 1;
    return db.accounts.add(stamp({name:trimmed,group:'receivable',balance:0,hidden:false,countInNetWorth:true,sortOrder}) as Account);
  });
  emit('accounts-changed', {id});
  return id;
}

export async function renameLoanAccount(id: number, name: string): Promise<void> {
  if (!await getLoanAccount(id)) throw new Error('应收应付账户不存在');
  if (!name.trim()) throw new Error('账户名不能为空');
  await updateAccount(id, {name:name.trim()});
}

export async function deleteLoanAccount(id: number): Promise<void> {
  if (!await getLoanAccount(id)) throw new Error('应收应付账户不存在');
  await deleteAccount(id);
}

export async function listLoanAccountEntries(accountId: number): Promise<Entry[]> {
  const rows = await db.entries.filter(entry => entry.deletedAt === 0
    && [entry.accountId, entry.fromAccountId, entry.toAccountId, entry.reimburseAccountId].includes(accountId)).toArray();
  return rows.sort((a,b)=>b.occurredAt-a.occurredAt);
}
