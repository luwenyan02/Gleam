import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/core/db';
import { addAccount } from '../src/core/repo/accountRepo';
import { catchUp, onPendingConfirm } from '../src/core/scheduler';
import {
  addRule,
  confirmPendingOccurrence,
  runDueRules,
  updateRule,
} from '../src/core/repo/recurringRepo';

const at = (year: number, month: number, day: number, hour = 9): number =>
  new Date(year, month - 1, day, hour, 0, 0, 0).getTime();

async function seedRule(
  amount: number,
  dueAt: number,
  amountConfirm = false,
): Promise<{ accountId: number; ruleId: number }> {
  const accountId = await addAccount({ name: '虚构周期账户', group: 'cash', balance: 100_000 });
  const ruleId = await addRule({
    name: '虚构周期账',
    amount,
    amountConfirm,
    freq: 'daily',
    days: [],
    accountId,
    categoryId: 101,
    enabled: true,
    nextRunAt: dueAt,
  });
  return { accountId, ruleId };
}

beforeEach(async () => {
  await db.delete();
  await db.open();
});

describe('周期账并发与原子性', () => {
  it('并发补跑同一期时只入账一次', async () => {
    const dueAt = at(2026, 1, 1);
    const { accountId } = await seedRule(1_000, dueAt);

    const results = await Promise.all([
      runDueRules(dueAt),
      runDueRules(dueAt),
    ]);

    expect(results.reduce((sum, result) => sum + result.booked, 0)).toBe(1);
    expect(await db.entries.where('occurredAt').equals(dueAt).count()).toBe(1);
    expect((await db.accounts.get(accountId))?.balance).toBe(99_000);
  });

  it('后续规则入账失败时回滚已入账流水和 nextRunAt', async () => {
    const dueAt = at(2026, 1, 1);
    const first = await seedRule(1_000, dueAt);
    const secondRuleId = await addRule({
      name: '虚构无效周期账',
      amount: 0,
      amountConfirm: false,
      freq: 'daily',
      days: [],
      accountId: first.accountId,
      categoryId: 101,
      enabled: true,
      nextRunAt: dueAt,
    });

    await expect(runDueRules(dueAt)).rejects.toThrow('金额须为正整数');

    expect(await db.entries.count()).toBe(0);
    expect((await db.accounts.get(first.accountId))?.balance).toBe(100_000);
    expect((await db.recurringRules.get(first.ruleId))?.nextRunAt).toBe(dueAt);
    expect((await db.recurringRules.get(secondRuleId))?.nextRunAt).toBe(dueAt);

    await updateRule(secondRuleId, { amount: 2_000 });
    expect(await runDueRules(dueAt)).toMatchObject({ booked: 2, pending: [] });
    expect(await db.entries.count()).toBe(2);
    expect((await db.accounts.get(first.accountId))?.balance).toBe(97_000);
  });

  it('并发补跑待确认规则时原子持久化一个队列项', async () => {
    const dueAt = at(2026, 1, 1);
    const { ruleId } = await seedRule(1_234, dueAt, true);

    const results = await Promise.all([
      runDueRules(dueAt),
      runDueRules(dueAt),
    ]);
    const saved = await db.settings.get('recurring.pendingConfirms');

    expect(results.flatMap((result) => result.pending)).toHaveLength(1);
    expect(saved?.value).toEqual([
      expect.objectContaining({ ruleId, dueAt, amount: 1_234 }),
    ]);
    expect(await db.entries.count()).toBe(0);
  });

  it('同一待确认项并发入账时只有一次领取成功', async () => {
    const dueAt = at(2026, 1, 1);
    const { accountId, ruleId } = await seedRule(1_234, dueAt, true);
    await runDueRules(dueAt);

    const results = await Promise.all([
      confirmPendingOccurrence(ruleId, dueAt, 1_234),
      confirmPendingOccurrence(ruleId, dueAt, 1_234),
    ]);

    expect(results.filter((result) => result.booked)).toHaveLength(1);
    expect(results.every((result) => result.pending.length === 0)).toBe(true);
    expect(await db.entries.where('occurredAt').equals(dueAt).count()).toBe(1);
    expect((await db.accounts.get(accountId))?.balance).toBe(98_766);
    expect((await db.settings.get('recurring.pendingConfirms'))?.value).toEqual([]);
  });

  it('待确认入账失败时保留队列项并可重试', async () => {
    const dueAt = at(2026, 1, 1);
    const { accountId, ruleId } = await seedRule(1_234, dueAt, true);
    await runDueRules(dueAt);

    await expect(confirmPendingOccurrence(ruleId, dueAt, 0)).rejects.toThrow('金额须为正整数');

    expect(await db.entries.count()).toBe(0);
    expect((await db.accounts.get(accountId))?.balance).toBe(100_000);
    expect((await db.settings.get('recurring.pendingConfirms'))?.value).toEqual([
      expect.objectContaining({ ruleId, dueAt }),
    ]);

    const retried = await confirmPendingOccurrence(ruleId, dueAt, 1_234);
    expect(retried).toEqual({ booked: true, pending: [] });
    expect(await db.entries.count()).toBe(1);
    expect((await db.accounts.get(accountId))?.balance).toBe(98_766);
  });
});

describe('周期账待确认队列分发', () => {
  it('首次回放已存队列后仍分发后续新产生的待确认项', async () => {
    const received: string[] = [];
    const stop = onPendingConfirm((items) => {
      received.push(...items.map((item) => `${item.ruleId}@${item.dueAt}`));
    });
    await db.settings.put({
      key: 'recurring.pendingConfirms',
      value: [{
        ruleId: 900,
        name: '虚构已存待确认项',
        amount: 500,
        dueAt: at(2025, 12, 31),
        accountId: 1,
        categoryId: 101,
      }],
      updatedAt: Date.now(),
    });

    await catchUp();
    const dueAt = Date.now() - 1_000;
    const { ruleId } = await seedRule(1_234, dueAt, true);
    await catchUp();
    stop();

    expect(received).toEqual([
      `900@${at(2025, 12, 31)}`,
      `${ruleId}@${dueAt}`,
    ]);
  });
});
