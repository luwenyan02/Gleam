import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../src/core/db';
import { addAccount } from '../src/core/repo/accountRepo';
import { addRule, computeNextRunAt, runDueRules, updateRule } from '../src/core/repo/recurringRepo';
import type { RecurFreq } from '../src/core/types';

const at = (month: number, day: number, hour = 9, year = 2026) => new Date(year, month - 1, day, hour).getTime();
let accountId: number;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(at(11, 4, 12));
  await db.delete(); await db.open();
  accountId = await addAccount({ name: '虚构周期账户', group: 'cash', balance: 100_000 });
});
afterEach(() => vi.useRealTimers());
const input = (patch = {}) => ({ name: '虚构每月账单', type: 'expense' as const, amount: 1000, amountConfirm: false,
  freq: 'monthly' as const, days: [2], startDate: at(11, 1), accountId, categoryId: 101, enabled: true, ...patch });

describe('从开始日期计算首期', () => {
  it('11月4日创建11月1日开始的每月2日规则，补记11月2日后推进到12月2日', async () => {
    const id = await addRule(input());
    expect((await db.recurringRules.get(id))?.nextRunAt).toBe(at(11, 2));
    expect((await runDueRules()).booked).toBe(1);
    const entry = (await db.entries.toArray())[0];
    expect(entry.occurredAt).toBe(at(11, 2)); expect(entry.amount).toBe(1000);
    expect((await db.accounts.get(accountId))?.balance).toBe(99_000);
    expect((await db.recurringRules.get(id))?.nextRunAt).toBe(at(12, 2));
    expect((await runDueRules()).booked).toBe(0);
  });
  it('确认金额规则生成一个11月2日待确认项，重复补跑不重复生成', async () => {
    const id = await addRule(input({ amountConfirm: true }));
    const first = await runDueRules(), second = await runDueRules();
    expect(first.pending).toEqual([expect.objectContaining({ ruleId: id, dueAt: at(11, 2) })]);
    expect(second.pending).toEqual([]); expect(await db.entries.count()).toBe(0);
    expect((await db.accounts.get(accountId))?.balance).toBe(100_000);
  });
  it('保存相同配置或只改金额不会把未处理的首期跳过', async () => {
    const data = input(), id = await addRule(data);
    await updateRule(id, { ...data, amount: 1200 });
    expect((await db.recurringRules.get(id))?.nextRunAt).toBe(at(11, 2));
    expect((await runDueRules()).booked).toBe(1);
    await updateRule(id, data);
    expect((await runDueRules()).booked).toBe(0);
    expect(await db.entries.count()).toBe(1);
  });
  it('未来开始日期和默认立即生效都不生成开始前的账单', async () => {
    const future = await addRule(input({ startDate: at(11, 5) }));
    const immediate = await addRule(input({ startDate: undefined }));
    expect((await db.recurringRules.get(future))?.nextRunAt).toBe(at(12, 2));
    expect((await db.recurringRules.get(immediate))?.nextRunAt).toBe(at(12, 2));
    expect((await runDueRules()).booked).toBe(0);
  });
  it('多月漏期、多个入账日按原日期处理，结束日期限制补跑范围', async () => {
    await addRule(input({ startDate: at(9, 1), endDate: at(10, 15), days: [2, 15] }));
    expect((await runDueRules()).booked).toBe(4);
    expect((await db.entries.orderBy('occurredAt').toArray()).map(e => e.occurredAt))
      .toEqual([at(9, 2), at(9, 15), at(10, 2), at(10, 15)]);
  });
  it('并发补跑只改变一次余额', async () => {
    await addRule(input());
    const result = await Promise.all([runDueRules(), runDueRules()]);
    expect(result.reduce((n, r) => n + r.booked, 0)).toBe(1);
    expect(await db.entries.count()).toBe(1);
    expect((await db.accounts.get(accountId))?.balance).toBe(99_000);
  });
});

describe('补跑时的日历推进', () => {
  it.each([
    ['daily', [], 3, at(11, 1), at(11, 1), at(11, 4)],
    ['weekly', [1], 1, at(11, 1), at(11, 2), at(11, 9)],
    ['weekly', [1], 2, at(11, 1), at(11, 2), at(11, 16)],
    ['monthly', [2], 99, at(11, 1), at(11, 2), at(2, 2, 9, 2035)],
    ['yearly', [1102], 5, at(11, 1), at(11, 2), at(11, 2, 9, 2031)],
  ] as [RecurFreq, number[], number, number, number, number][])
  ('频率%s、入账日%j、间隔%d的下一期正确', (freq, days, interval, startDate, due, next) => {
    expect(computeNextRunAt({ freq, days, interval, startDate }, due)).toBe(next);
  });
  it('间隔以开始日期的日历周期为锚点，不随检查时间漂移', () => {
    expect(computeNextRunAt({ freq: 'monthly', days: [2], interval: 2, startDate: at(9, 1) }, at(10, 4)))
      .toBe(at(11, 2));
  });
  it('月末折算与多个入账日不重复生成同一天', () => {
    const rule = { freq: 'monthly' as const, days: [30, 31], startDate: at(1, 1) };
    expect(computeNextRunAt(rule, at(2, 28))).toBe(at(3, 30));
  });
});

it('保存修改与到期补跑并发时，不能把已推进的下一期回写成旧日期', async () => {
  const data = input(), id = await addRule(data);
  await Promise.all([updateRule(id, { amount: 1100 }), runDueRules()]);
  await runDueRules();
  expect(await db.entries.count()).toBe(1);
  expect((await db.recurringRules.get(id))?.nextRunAt).toBe(at(12, 2));
});

it('数值启用标志的已结束旧规则不能挡住正常规则补跑', async () => {
  const old = await addRule(input({ startDate: at(9, 1), endDate: at(9, 2) }));
  await db.recurringRules.update(old, { enabled: 1 as unknown as boolean, nextRunAt: at(10, 2) });
  await addRule(input());
  expect((await runDueRules()).booked).toBe(1);
  expect((await db.entries.toArray()).map(e => e.occurredAt)).toEqual([at(11, 2)]);
});
it('跨夏令时仍按本地日历每两天09:00推进', () => {
  expect(computeNextRunAt({ freq: 'daily', days: [], interval: 2, startDate: at(10, 31) }, at(10, 31))).toBe(at(11, 2));
});
it('闰年二月29日规则在平年按月底执行', () => {
  expect(computeNextRunAt({ freq: 'yearly', days: [229], startDate: at(2, 29, 9, 2024) }, at(2, 29, 9, 2024))).toBe(at(2, 28, 9, 2025));
});
