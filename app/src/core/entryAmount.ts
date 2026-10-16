import type { Entry } from './types';

/** 明细显示的资金方向；挖财带符号金额只翻转一次。转账仍显示原金额。 */
export function entryDisplayAmount(entry: Pick<Entry, 'type' | 'amount' | 'refundFlag' | 'loanKind'>): number {
  const incoming = entry.type === 'income' || entry.refundFlag
    || entry.loanKind === 'borrow' || entry.loanKind === 'collect';
  return entry.type === 'transfer' || incoming ? entry.amount : -entry.amount;
}
