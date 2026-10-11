import { summarizeLedgerEntries } from '../ledgerQuery';
import { dayKey } from './entryRepo';
import { getSetting } from './settingsRepo';
import { ledgerEntriesInRange } from './statsRepo';

/** Local calendar days, not seven fixed 24-hour periods (DST may change day length). */
export function spendingRhythmDays(now: number) {
  const today = new Date(now);
  return Array.from({ length: 7 }, (_, index) => {
    const from = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6 + index).getTime();
    const to = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 5 + index).getTime();
    return { key: dayKey(from), from, to };
  });
}

/** Read-only, integer-fen aggregation using the same events and policy as reports. */
export async function getSpendingRhythm(now = Date.now()) {
  const bounds = spendingRhythmDays(now);
  const from = bounds[0].from;
  const to = bounds[6].to;
  const countAsIncome = await getSetting('reimburse.countAsIncome');
  const entries = await ledgerEntriesInRange(from, to, countAsIncome);
  const days = bounds.map(day => {
    const rows = entries.filter(entry => entry.occurredAt >= day.from && entry.occurredAt < day.to);
    const { expense, expenseCount } = summarizeLedgerEntries(rows, {
      reimburseMode: countAsIncome ? 'income' : 'offset',
    });
    // A recorded spending day remains recorded after a refund/reimbursement offsets it.
    // A refund alone is not a new spending day. Imports/backfills use occurredAt, never createdAt.
    const spendingCount = rows.filter(entry => entry.type === 'expense' && !entry.refundFlag).length;
    return { ...day, expense, expenseCount, spendingCount };
  });
  return { from, to, days, countAsIncome,
    expense: days.reduce((sum, day) => sum + day.expense, 0),
    expenseCount: days.reduce((sum, day) => sum + day.expenseCount, 0),
    spendingDays: days.filter(day => day.spendingCount > 0).length,
  };
}
