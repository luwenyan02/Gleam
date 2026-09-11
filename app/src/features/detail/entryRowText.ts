import { LOAN_KIND_META, type Entry } from '../../core/types';
import type { LedgerItem } from '../../core/ledgerEvents';

/** 共用的两行明细文案；只做展示，不修改实体或计算账务金额。 */
export function entryRowText(
  entry: Entry & { kind?: LedgerItem['kind'] },
  categories: ReadonlyMap<number, { name: string; icon: string }>,
  accounts: ReadonlyMap<number, string>,
) {
  const category = categories.get(entry.categoryId ?? -1);
  let title = category?.name ?? (entry.type === 'income' ? '收入' : '支出');
  let icon = category?.icon ?? 'ic-coin';
  const reconciliation = entry.reconcileBeforeBalance != null && entry.reconcileTargetBalance != null;
  if (entry.kind === 'reimbursement') {
    title = '报销到账'; icon = 'ic-file';
  } else if (reconciliation) {
    title = '余额对账调整'; icon = 'ic-swap';
  } else if (entry.type === 'transfer') {
    title = entry.note === '余额对账调整' ? '余额对账调整' : '转账'; icon = 'ic-swap';
  } else if (entry.type === 'loan') {
    const kind = LOAN_KIND_META[entry.loanKind ?? 'borrow'];
    title = kind.name; icon = kind.icon;
  } else if (entry.refundFlag) {
    title += '退款';
  }
  const date = new Date(entry.occurredAt);
  const time = `${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  const account = entry.type === 'loan' || entry.type === 'transfer'
    ? `${accounts.get(entry.fromAccountId ?? -1) ?? '—'} → ${accounts.get(entry.toAccountId ?? -1) ?? '—'}`
    : accounts.get(entry.accountId ?? -1) ?? '账户';
  const hasReceipt = entry.reimbursedAmount != null
    && entry.reimbursedAt != null
    && entry.reimburseAccountId != null;
  const status = entry.reimburseStatus === 'pending' ? '待报销'
    : entry.reimburseStatus === 'done'
      ? hasReceipt ? '已报销' : '已报销（到账资料缺失）'
      : '';
  const note = entry.note?.trim();
  return {
    title, icon,
    note: note && note !== title && note !== '余额对账调整' ? note : '',
    meta: `${time} · ${account}${status ? ` · ${status}` : ''}`,
    neutral: entry.type !== 'expense' || entry.refundFlag === true,
  };
}
