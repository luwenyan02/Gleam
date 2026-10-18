import { describe, expect, it } from 'vitest';
import type { Entry } from '../src/core/types';
import { summarizeLedgerEntries } from '../src/core/ledgerQuery';
import { filterSearchSummary, searchExtraSummaries } from '../src/features/search/searchSummary';

const row = (id: number, patch: Partial<Entry>): Entry => ({ id, type: 'expense', amount: 1000, occurredAt: 1, createdAt: 1, updatedAt: 1, deletedAt: 0, reimburseStatus: 'none', ...patch });

describe('附加搜索汇总', () => {
  const entries = [
    row(1, {}), row(2, { refundFlag: true, amount: 200 }), row(3, { amount: -300 }),
    row(4, { type: 'transfer', amount: 5000, fromAccountId: 1, toAccountId: 2 }),
    row(5, { type: 'loan', loanKind: 'collect', amount: 700 }),
    row(6, { type: 'loan', loanKind: 'borrow', amount: 800 }),
    row(7, { type: 'income', amount: 2000 }), row(8, { refundFlag: true, deletedAt: 2 }),
  ];
  it('退款支持关联退款与导入负支出，转账按单笔计数，收款只统计借贷收款', () => {
    expect(searchExtraSummaries(entries)).toEqual([
      { filter: 'refund', label: '支出退款', amount: 500, count: 2 },
      { filter: 'transfer', label: '转账', amount: 5000, count: 1 },
      { filter: 'collect', label: '收款', amount: 700, count: 1 },
    ]);
  });
  it('无记录时不生成附加卡片，金额抵消为零但有记录时仍显示', () => {
    expect(searchExtraSummaries([entries[0], entries[6]])).toEqual([]);
    expect(searchExtraSummaries([row(1, { type: 'transfer' }), row(2, { type: 'transfer', amount: -1000 })]))
      .toEqual([{ filter: 'transfer', label: '转账', amount: 0, count: 2 }]);
  });
  it('各卡片只筛选对应记录，退款仍属于支出，不重复计入收入或结余', () => {
    expect(filterSearchSummary(entries, 'refund').map(e => e.id)).toEqual([2, 3]);
    expect(filterSearchSummary(entries, 'transfer').map(e => e.id)).toEqual([4]);
    expect(filterSearchSummary(entries, 'collect').map(e => e.id)).toEqual([5]);
    expect(filterSearchSummary(entries, 'expense').map(e => e.id)).toEqual([1, 2, 3]);
    expect(filterSearchSummary(entries, 'income').map(e => e.id)).toEqual([7]);
    expect(summarizeLedgerEntries(filterSearchSummary(entries, 'all'))).toMatchObject({ expense: 500, income: 2000, balance: 1500 });
  });
  it('退款冲回不误判为收到退款，借贷还款和报销到账收入不误判为收款', () => {
    expect(searchExtraSummaries([
      row(1, { refundFlag: true, amount: -100 }), row(2, { type: 'loan', loanKind: 'repay' }),
      row(3, { type: 'income', reimburseStatus: 'none' }),
    ])).toEqual([]);
  });
});
