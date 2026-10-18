import type { Entry } from '../../core/types';

export const SUMMARY_LABELS = { all: '', expense: '支出', income: '收入', refund: '支出退款', transfer: '转账', collect: '收款' } as const;
export type SearchSummaryFilter = keyof typeof SUMMARY_LABELS;

function isExpenseRefund(entry: Entry): boolean {
  const signed = entry.refundFlag ? -entry.amount : entry.amount;
  return entry.type === 'expense' && (signed < 0 || (entry.refundFlag === true && signed === 0));
}

export function filterSearchSummary<T extends Entry>(entries: readonly T[], filter: SearchSummaryFilter): T[] {
  return entries.filter(entry => entry.deletedAt === 0 && (
    filter === 'all' || (filter === 'refund' ? isExpenseRefund(entry)
      : filter === 'collect' ? entry.type === 'loan' && entry.loanKind === 'collect'
        : entry.type === filter)
  ));
}

/** 附加卡片只描述对应资金事件，不改变净收支及结余。 */
export function searchExtraSummaries(entries: readonly Entry[]): { filter: SearchSummaryFilter; label: string; amount: number; count: number }[] {
  return (['refund', 'transfer', 'collect'] as const).flatMap(filter => {
    const rows = filterSearchSummary(entries, filter);
    return rows.length ? [{ filter, label: SUMMARY_LABELS[filter], count: rows.length,
      amount: rows.reduce((total, entry) => total + (filter === 'refund' ? entry.refundFlag ? entry.amount : -entry.amount : entry.amount), 0),
    }] : [];
  });
}
