import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, stamp } from '../src/core/db';
import type { Category, Entry } from '../src/core/types';
import {
  accountingMonthForTimestamp,
  accountingMonthRangeForStartDay,
  formatAccountingRange,
} from '../src/core/period';
import {
  accountingMonthRange,
  getAccountingMonth,
  setAccountingMonthStartDay,
} from '../src/core/repo/periodRepo';
import { budgetUsage, monthRange, monthSummary } from '../src/core/repo/statsRepo';

const at = (year: number, month: number, day: number, hour = 12): number =>
  new Date(year, month - 1, day, hour, 0, 0, 0).getTime();

beforeEach(async () => {
  await db.delete();
  await db.open();
});

describe('财务月纯计算', () => {
  it('起始日前归上个财务月，起始日当天归新财务月，跨年不出错', () => {
    expect(accountingMonthForTimestamp(at(2026, 9, 4), 5)).toBe('2026-08');
    expect(accountingMonthForTimestamp(at(2026, 9, 5, 0), 5)).toBe('2026-09');
    expect(accountingMonthForTimestamp(at(2026, 1, 2), 5)).toBe('2025-12');
  });

  it('范围是起始日到下月同日前一毫秒，并显示实际日期', () => {
    const range = accountingMonthRangeForStartDay('2026-09', 28);
    expect(range).toEqual({
      from: new Date(2026, 8, 28).getTime(),
      to: new Date(2026, 9, 28).getTime(),
    });
    expect(formatAccountingRange(range)).toBe('2026/9/28 – 2026/10/27');
  });

  it('只接受 1–28 的整数起始日及合法月份', () => {
    expect(() => accountingMonthRangeForStartDay('2026-09', 0)).toThrow('1–28');
    expect(() => accountingMonthRangeForStartDay('2026-13', 1)).toThrow('月份无效');
  });
});

describe('全局财务月统计口径', () => {
  it('默认 1 号时与自然月完全兼容', async () => {
    expect(await getAccountingMonth(at(2026, 9, 15))).toBe('2026-09');
    expect(await accountingMonthRange('2026-09')).toEqual(monthRange('2026-09'));
  });

  it('月汇总和月预算已用共享自定义财务月范围，日历自然月仍不变', async () => {
    await setAccountingMonthStartDay(28);
    await db.categories.put(stamp({
      id: 1, name: '虚构餐饮', icon: 'ic-bowl', kind: 'expense', sortOrder: 1,
    }) as Category);
    await db.entries.bulkPut([
      stamp({ id: 1, type: 'expense', amount: 1_000, occurredAt: at(2026, 9, 27), categoryId: 1, accountId: 1, reimburseStatus: 'none', deletedAt: 0 }) as Entry,
      stamp({ id: 2, type: 'expense', amount: 2_000, occurredAt: at(2026, 9, 28), categoryId: 1, accountId: 1, reimburseStatus: 'none', deletedAt: 0 }) as Entry,
      stamp({ id: 3, type: 'income', amount: 5_000, occurredAt: at(2026, 10, 27), categoryId: 2, accountId: 1, reimburseStatus: 'none', deletedAt: 0 }) as Entry,
      stamp({ id: 4, type: 'expense', amount: 4_000, occurredAt: at(2026, 10, 28), categoryId: 1, accountId: 1, reimburseStatus: 'none', deletedAt: 0 }) as Entry,
    ]);

    expect(await getAccountingMonth(at(2026, 9, 27))).toBe('2026-08');
    expect(await getAccountingMonth(at(2026, 9, 28))).toBe('2026-09');
    expect(await monthSummary('2026-09')).toEqual({ expense: 2_000, income: 5_000, balance: 3_000 });
    expect((await budgetUsage('2026-09')).totalUsed).toBe(2_000);
    expect(monthRange('2026-09')).toEqual({
      from: new Date(2026, 8, 1).getTime(),
      to: new Date(2026, 9, 1).getTime(),
    });
  });
});
