import { LOAN_KINDS, type Account, type Entry, type LoanKind } from './types';

type LoanFields = Pick<Entry, 'type' | 'loanKind' | 'fromAccountId' | 'toAccountId'>;

export function loanDirection(kind: LoanKind, fundId: number, loanId: number) {
  return kind === 'lend' || kind === 'repay'
    ? { fromAccountId: fundId, toAccountId: loanId }
    : { fromAccountId: loanId, toAccountId: fundId };
}

export function loanAccountId(entry: LoanFields): number | undefined {
  if (entry.type !== 'loan') return undefined;
  return entry.loanKind === 'lend' || entry.loanKind === 'repay' ? entry.toAccountId : entry.fromAccountId;
}

export function loanFundAccountId(entry: LoanFields): number | undefined {
  if (entry.type !== 'loan') return undefined;
  return entry.loanKind === 'lend' || entry.loanKind === 'repay' ? entry.fromAccountId : entry.toAccountId;
}

/** 借贷必须是一个真实资金账户与一个应收应付账户，方向和业务标签一致。 */
export function validateLoanAccounts(entry: LoanFields, accounts: ReadonlyMap<number, Account>): void {
  if (!entry.loanKind || !LOAN_KINDS.includes(entry.loanKind)) throw new Error('请选择正确的借贷类型');
  if (entry.fromAccountId == null || entry.toAccountId == null) throw new Error('请选择资金账户和应收应付账户');
  if (entry.fromAccountId === entry.toAccountId) throw new Error('转出与转入账户不能相同');
  const fund = accounts.get(loanFundAccountId(entry)!);
  const loan = accounts.get(loanAccountId(entry)!);
  if (!fund || !loan) throw new Error('借贷关联账户不存在，请重新选择');
  if (fund.group === 'receivable') throw new Error('资金账户不能使用应收应付分组');
  if (loan.group !== 'receivable') throw new Error('借贷对方必须是应收应付账户');
}
