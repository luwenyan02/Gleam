import type { Entry } from './types';

export interface AccountEffect { accountId: number; delta: number }

/** 写入、回滚、账户流水与资产趋势共用的整数分余额影响。 */
export function accountEffects(entry: Pick<Entry, 'type' | 'amount'> & Partial<Entry>): AccountEffect[] {
  const result: AccountEffect[] = [];
  if (entry.type === 'transfer' || (entry.type === 'loan' && entry.fromAccountId != null && entry.toAccountId != null)) {
    if (entry.fromAccountId != null) result.push({ accountId: entry.fromAccountId, delta: -entry.amount });
    if (entry.toAccountId != null) result.push({ accountId: entry.toAccountId, delta: entry.amount });
  } else if (entry.accountId != null) {
    // 仅保留旧测试借贷的资金侧回滚能力；新借贷的写入校验不接受该形态。
    const incoming = entry.type === 'income' || (entry.type === 'expense' && entry.refundFlag)
      || (entry.type === 'loan' && (entry.loanKind === 'borrow' || entry.loanKind === 'collect'));
    result.push({ accountId: entry.accountId, delta: incoming ? entry.amount : -entry.amount });
  }
  if (entry.type === 'expense' && entry.reimburseStatus === 'done' && entry.reimburseAccountId != null && entry.reimbursedAmount) {
    result.push({ accountId: entry.reimburseAccountId, delta: entry.reimbursedAmount });
  }
  return result;
}
