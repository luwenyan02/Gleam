import { describe, expect, it } from 'vitest';
import type { Entry } from '../src/core/types';
import { accountFlows, accountMonthRows, accountStatement, accountActiveMonthRows } from '../src/core/ledgerEvents';

const date = (month: number, day: number) => new Date(2026, month - 1, day, 12).getTime();
const entry = (id: number, patch: Partial<Entry>): Entry => ({
  id, type: 'expense', amount: 100, accountId: 1, occurredAt: date(2, id),
  deletedAt: 0, reimburseStatus: 'none', createdAt: id, updatedAt: id, ...patch,
});
const entries = [
  entry(1, { type: 'income', amount: 10000, occurredAt: date(1, 1) }),
  entry(2, { amount: 2500, occurredAt: date(1, 2) }),
  entry(3, { type: 'transfer', amount: 1000, accountId: undefined, fromAccountId: 1, toAccountId: 2 }),
  entry(4, { type: 'loan', loanKind: 'lend', amount: 2000, accountId: undefined, fromAccountId: 1, toAccountId: 3 }),
  entry(5, { type: 'loan', loanKind: 'borrow', amount: 700, accountId: undefined, fromAccountId: 3, toAccountId: 1 }),
  entry(6, { type: 'loan', loanKind: 'repay', amount: 200, accountId: undefined, fromAccountId: 1, toAccountId: 3 }),
  entry(7, { type: 'loan', loanKind: 'collect', amount: 500, accountId: undefined, fromAccountId: 3, toAccountId: 1 }),
  entry(8, { amount: 1000, reimburseStatus: 'done', reimbursedAmount: 400, reimburseAccountId: 1, reimbursedAt: date(2, 9) }),
  entry(9, { amount: 600, refundFlag: true, refundOfEntryId: 2, occurredAt: date(2, 10) }),
  entry(10, { type: 'transfer', amount: 100, accountId: undefined, toAccountId: 1, note: '余额对账调整', occurredAt: date(2, 11) }),
  entry(11, { type: 'income', amount: 999999, deletedAt: 1 }),
];

describe('账户逐笔余额（只读派生）', () => {
  it('跨月覆盖收支、转账、四类借贷、退款、报销及单边余额调整', () => {
    const original = structuredClone(entries);
    const rows = accountStatement(accountFlows(entries, 1), 5600);
    expect(rows.map(row => [row.entry.id, row.entry.kind, row.balanceAfter])).toEqual([
      [10,'entry',5600],[9,'entry',5500],[8,'reimbursement',4900],
      [8,'entry',4500],[7,'entry',5500],[6,'entry',5000],[5,'entry',5200],
      [4,'entry',4500],[3,'entry',6500],[2,'entry',7500],[1,'entry',10000],
    ]);
    expect(entries).toEqual(original);
    expect(rows.every(row => Number.isSafeInteger(row.balanceAfter))).toBe(true);
    const months = accountMonthRows(rows, 5600, date(2, 20), 2);
    expect(months[0].closing).toBe(rows[0].balanceAfter);
    expect(months[1].closing).toBe(7500);
  });

  it('保留未表现为流水的期初余额，最后一笔之前仍能回到期初', () => {
    const rows = accountStatement(accountFlows(entries, 1), 10600);
    const last = rows.at(-1)!;
    expect(rows[0].balanceAfter).toBe(10600);
    expect(last.balanceAfter - last.delta).toBe(5000);
  });

  it('同时间原支出与到账共用 id 时，到账排在支出之后且不覆盖双方余额', () => {
    const sameTime = entry(1, { amount:1000, reimburseStatus:'done', reimbursedAmount:400, reimburseAccountId:1, reimbursedAt:date(2,1) });
    const rows = accountStatement(accountFlows([sameTime],1),-600);
    expect(rows.map(row=>[row.entry.kind,row.balanceAfter])).toEqual([['reimbursement',-600],['entry',-1000]]);
  });

  it('按时间和同时间 id 排序、不依赖来料顺序，其他账户与删除项不进入本账户', () => {
    const flows = accountFlows(entries,1).reverse();
    const first = structuredClone(flows);
    const rows = accountStatement(flows,5600);
    expect(rows[0].entry.id).toBe(10);
    expect(rows.at(-1)!.entry.id).toBe(1);
    expect(flows).toEqual(first);
    expect(accountStatement(accountFlows(entries,2),1000).map(row=>row.balanceAfter)).toEqual([1000]);
    expect(accountStatement([],0)).toEqual([]);
  });
});


describe('账户仅展示有流水的月份', () => {
  it('跨多年空档直接到历史流水，保留零净额月份与期初余额', () => {
    const source = [entry(1, { type: 'income', amount: 1000, occurredAt: new Date(2015, 0, 1).getTime() }),
      entry(2, { amount: 1000, occurredAt: new Date(2015, 0, 2).getTime() }),
      entry(3, { amount: 200, occurredAt: new Date(2020, 5, 1).getTime() })];
    const rows = accountActiveMonthRows(accountStatement(accountFlows(source, 1), 300));
    expect(rows.map(r => [r.key, r.income, r.expense, r.closing])).toEqual([
      ['2020-06', 0, 200, 300], ['2015-01', 1000, 1000, 500],
    ]);
    expect(rows.map(r => r.entries.length)).toEqual([1, 2]);
    expect(accountActiveMonthRows([])).toEqual([]);
  });
  it('零金额导入记录也是流水，不应连同空月份一起隐藏', () => {
    const zero = entry(1, { type: 'income', amount: 0, sourceAdjustment: { source: 'wacai', rowNo: 8 } });
    const rows = accountActiveMonthRows(accountStatement(accountFlows([zero], 1), 500));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ closing: 500, income: 0, expense: 0 });
    expect(rows[0].entries[0].id).toBe(1);
    expect(accountFlows([zero], 2)).toEqual([]);
  });
});
