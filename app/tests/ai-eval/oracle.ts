// The oracle intentionally imports NO production executable code (only structural types).
import type { Account, Category, Entry } from '../../src/core/types';

export function oracleRange(month: string, startDay = 1): { from: number; to: number } {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || !Number.isInteger(startDay) || startDay < 1 || startDay > 28) throw new Error('invalid oracle range');
  const [year, number] = month.split('-').map(Number);
  const local = (m: number) => { const d = new Date(0); d.setFullYear(year, m, startDay); d.setHours(0, 0, 0, 0); return d.getTime(); };
  return { from: local(number - 1), to: local(number) };
}
const cents = (value: number) => { if (!Number.isSafeInteger(value)) throw new Error('unsafe oracle cents'); return BigInt(value); };
const number = (value: bigint) => { const n = Number(value); if (!Number.isSafeInteger(n)) throw new Error('oracle sum overflow'); return n; };

export function oracleSummary(entries: readonly Entry[], categories: readonly Category[], range: { from: number; to: number }, mode: 'offset' | 'income', includeIncome: boolean) {
  let gross = 0n, refunds = 0n, offset = 0n, income = 0n, reimbursement = 0n;
  let expenseCount = 0, refundCount = 0, incomeCount = 0;
  const byCategory = new Map<number | undefined, { name: string; amount: bigint; count: number }>();
  const inRange = (at: number) => at >= range.from && at < range.to;
  for (const row of entries) {
    if (row.deletedAt !== 0) continue;
    if (row.type === 'expense' && inRange(row.occurredAt)) {
      const amount = cents(row.amount), paid = mode === 'offset' && row.reimburseStatus === 'done' ? cents(row.reimbursedAmount ?? 0) : 0n;
      const signed = row.refundFlag ? -amount : amount;
      if (row.refundFlag) { refunds += amount; refundCount++; } else { gross += amount; expenseCount++; }
      offset += paid;
      const cat = categories.find(c => c.id === row.categoryId), key = cat?.parentId ?? cat?.id;
      const name = (categories.find(c => c.id === key)?.name ?? '未分类').slice(0, 80);
      const current = byCategory.get(key) ?? { name, amount: 0n, count: 0 };
      current.amount += signed - paid; current.count++; byCategory.set(key, current);
    }
    if (row.type === 'income' && inRange(row.occurredAt)) { income += cents(row.amount); incomeCount++; }
    if (mode === 'income' && row.type === 'expense' && row.reimburseStatus === 'done' && row.reimbursedAt != null && row.reimburseAccountId != null && row.reimbursedAmount && inRange(row.reimbursedAt)) {
      const amount = cents(row.reimbursedAmount); reimbursement += amount; income += amount; incomeCount++;
    }
  }
  const ranked = [...byCategory.values()].map(c => ({ name: c.name, expenseFen: number(c.amount), count: c.count }))
    .sort((a, b) => Math.abs(b.expenseFen) - Math.abs(a.expenseFen) || a.name.localeCompare(b.name));
  const limited = ranked.length <= 12 ? ranked : [...ranked.slice(0, 12), { name: '其他分类（合并）', expenseFen: number(ranked.slice(12).reduce((s, c) => s + cents(c.expenseFen), 0n)), count: ranked.slice(12).reduce((s, c) => s + c.count, 0) }];
  return { totals: { expenseFen: number(gross - refunds - offset), grossExpenseFen: number(gross), refundFen: number(refunds), reimbursementOffsetFen: number(offset), expenseCount, refundCount }, categories: limited,
    ...(includeIncome ? { income: { incomeFen: number(income), reimbursementIncomeFen: number(reimbursement), count: incomeCount } } : {}) };
}

/** Independent signed account postings, evaluated at event dates instead of reporting mode. */
export function oracleBalances(accounts: readonly Account[], entries: readonly Entry[], before = Infinity): Record<number, number> {
  const result = new Map(accounts.map(a => [a.id, cents(a.balance)]));
  const post = (id: number | undefined, amount: bigint) => { if (id == null || !result.has(id)) throw new Error('oracle missing account'); result.set(id, result.get(id)! + amount); };
  for (const row of entries) {
    if (row.deletedAt !== 0) continue;
    const amount = cents(row.amount);
    if (row.occurredAt < before) {
      if (row.type === 'transfer' || row.type === 'loan') { post(row.fromAccountId, -amount); post(row.toAccountId, amount); }
      else post(row.accountId, row.type === 'income' || row.refundFlag ? amount : -amount);
    }
    if (row.type === 'expense' && row.reimburseStatus === 'done' && row.reimbursedAt != null && row.reimbursedAt < before) post(row.reimburseAccountId, cents(row.reimbursedAmount ?? 0));
  }
  return Object.fromEntries([...result].map(([id, value]) => [id, number(value)]));
}
