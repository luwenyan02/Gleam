import { describe, expect, it } from 'vitest';
import type { Entry } from '../src/core/types';
import { homeMonthSummaries, homeTimelineWindow, visibleHomeMonth } from '../src/features/home/homeTimeline';

describe('首页按完整财务月加载', () => {
  it('默认三期，跨年及自定义起始日沿用同一边界，每次只增加一期', () => {
    const first = homeTimelineWindow('2026-01', 5, 3);
    expect(first.periods.map(row => row.month)).toEqual(['2026-01', '2025-12', '2025-11']);
    expect(first.from).toBe(new Date(2025, 10, 5).getTime());
    expect(first.to).toBe(new Date(2026, 1, 5).getTime());
    const next = homeTimelineWindow('2026-01', 5, 4);
    expect(next.periods.slice(0, 3)).toEqual(first.periods);
    expect(next.from).toBe(new Date(2025, 9, 5).getTime());
    expect(next.to).toBe(first.to);
  });
  it('整月汇总包含退款、正确处理报销，转账和借贷不改变净收支', () => {
    const periods = homeTimelineWindow('2026-10', 5, 3).periods;
    const base: Entry = { id: 1, type: 'expense', amount: 10000, occurredAt: new Date(2026, 9, 5).getTime(), deletedAt: 0, reimburseStatus: 'none', createdAt: 1, updatedAt: 1 };
    const rows = [base, { ...base, id: 2, amount: 2000, refundFlag: true },
      { ...base, id: 3, amount: 3000, reimburseStatus: 'done' as const, reimbursedAmount: 1000 },
      { ...base, id: 4, type: 'income' as const, amount: 20000 },
      { ...base, id: 5, type: 'transfer' as const, amount: 80000 },
      { ...base, id: 6, type: 'loan' as const, loanKind: 'collect' as const, amount: 90000 },
      { ...base, id: 7, deletedAt: 2 },
      { ...base, id: 8, occurredAt: new Date(2026, 9, 4, 23, 59, 59, 999).getTime() }];
    const summaries = homeMonthSummaries(rows, periods, 5, { reimburseMode: 'offset' });
    expect(summaries[0]).toMatchObject({ expense: 10000, income: 20000, balance: 10000 });
    expect(summaries[1]).toMatchObject({ expense: 10000, income: 0, balance: -10000 });
    expect(summaries[2]).toMatchObject({ expense: 0, income: 0, balance: 0 });
    expect(homeMonthSummaries(rows, periods, 5, { reimburseMode: 'income' })[0].expense).toBe(11000);
  });
  it('月份随可见流水切换，空白间距和自定义排列不会选错月份', () => {
    const rows = [{ month: '2026-09', top: 200, bottom: 700 }, { month: '2026-10', top: -200, bottom: 100 }];
    expect(visibleHomeMonth(rows, 80, '')).toBe('2026-10');
    expect(visibleHomeMonth(rows, 110, '')).toBe('2026-09');
    expect(visibleHomeMonth(rows, 800, '')).toBe('2026-09');
    expect(visibleHomeMonth([], 80, '2026-10')).toBe('2026-10');
  });
});
