import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/core/db';
import { addAccount } from '../src/core/repo/accountRepo';
import { catchUp, onPendingConfirm } from '../src/core/scheduler';
import {
  addRule,
  confirmPendingOccurrence,
  deleteRule,
  listRules,
  ruleSummary,
  runDueRules,
  setRuleEnabled,
  skipNextOccurrence,
  updateRule,
} from '../src/core/repo/recurringRepo';
import type { CategoryKind } from '../src/core/types';

const at = (year: number, month: number, day: number, hour = 9): number =>
  new Date(year, month - 1, day, hour, 0, 0, 0).getTime();

async function seedRule(
  amount: number,
  dueAt: number,
  amountConfirm = false,
  type?: CategoryKind,
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
    type,
  });
  return { accountId, ruleId };
}

beforeEach(async () => {
  await db.delete();
  await db.open();
});

describe('周期账并发与原子性', () => {
  it('自动入账按收入规则增加账户余额', async () => {
    const dueAt = at(2026, 1, 1);
    const { accountId } = await seedRule(1_000, dueAt, false, 'income');

    await expect(runDueRules(dueAt)).resolves.toMatchObject({ booked: 1, pending: [] });

    const entry = await db.entries.where('occurredAt').equals(dueAt).first();
    expect(entry?.type).toBe('income');
    expect((await db.accounts.get(accountId))?.balance).toBe(101_000);
  });

  it('待确认入账保留收入类型并增加余额', async () => {
    const dueAt = at(2026, 1, 1);
    const { accountId, ruleId } = await seedRule(1_234, dueAt, true, 'income');

    const due = await runDueRules(dueAt);
    expect(due.pending).toEqual([
      expect.objectContaining({ ruleId, dueAt, type: 'income' }),
    ]);

    await updateRule(ruleId, { type: 'expense' });
    await confirmPendingOccurrence(ruleId, dueAt, 1_234);
    const entry = await db.entries.where('occurredAt').equals(dueAt).first();
    expect(entry?.type).toBe('income');
    expect((await db.accounts.get(accountId))?.balance).toBe(101_234);
  });

  it('旧规则缺少 type 时读取为支出', async () => {
    const dueAt = at(2026, 1, 1);
    const { ruleId } = await seedRule(1_000, dueAt);
    await db.recurringRules.update(ruleId, { type: undefined });

    expect((await listRules()).find((rule) => rule.id === ruleId)?.type).toBe('expense');
  });

  it('旧待确认项缺少 type 时按支出入账', async () => {
    const dueAt = at(2026, 1, 1);
    const { accountId, ruleId } = await seedRule(1_000, dueAt, true);
    await db.settings.put({
      key: 'recurring.pendingConfirms',
      value: [{
        ruleId, name: '虚构旧待确认项', amount: 1_000, dueAt, accountId, categoryId: 101,
      }],
      updatedAt: Date.now(),
    });

    await confirmPendingOccurrence(ruleId, dueAt, 1_000);

    expect((await db.entries.where('occurredAt').equals(dueAt).first())?.type).toBe('expense');
    expect((await db.accounts.get(accountId))?.balance).toBe(99_000);
  });

  it('每月固定支出汇总不累加收入规则', async () => {
    const dueAt = at(2026, 1, 1);
    const { accountId } = await seedRule(1_000, dueAt);
    await updateRule(1, { freq: 'monthly', days: [1, 15], type: 'expense' });
    await addRule({
      name: '虚构工资', amount: 7_000, amountConfirm: false, freq: 'monthly', days: [1],
      accountId, categoryId: 201, enabled: true, nextRunAt: dueAt, type: 'income',
    });

    await expect(ruleSummary()).resolves.toEqual({
      monthlyTotal: 2_000,
      monthlyIncomeTotal: 7_000,
      enabledCount: 2,
    });
  });

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

  it('删除规则时取消未入账待确认项并保留历史账单', async () => {
    const firstDueAt = at(2026, 1, 1);
    const secondDueAt = at(2026, 1, 2);
    const { accountId, ruleId } = await seedRule(1_000, firstDueAt);
    await runDueRules(firstDueAt);
    await updateRule(ruleId, { amountConfirm: true });
    await runDueRules(secondDueAt);

    await deleteRule(ruleId);

    expect(await db.recurringRules.get(ruleId)).toBeUndefined();
    expect((await db.settings.get('recurring.pendingConfirms'))?.value).toEqual([]);
    const entries = await db.entries.toArray();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      type: 'expense', amount: 1_000, occurredAt: firstDueAt, accountId, categoryId: 101,
    });
    expect((await db.accounts.get(accountId))?.balance).toBe(99_000);
  });

  it('删除规则后确认页面缓存的待确认项会明确拒绝入账', async () => {
    const dueAt = at(2026, 1, 1);
    const { accountId, ruleId } = await seedRule(1_234, dueAt, true);
    await runDueRules(dueAt);
    await deleteRule(ruleId);

    await expect(confirmPendingOccurrence(ruleId, dueAt, 1_234))
      .rejects.toThrow('周期账规则已删除，无法入账');

    expect(await db.entries.count()).toBe(0);
    expect((await db.accounts.get(accountId))?.balance).toBe(100_000);
  });

  it('停用规则的待确认项会明确拒绝入账并保留队列', async () => {
    const dueAt = at(2026, 1, 1);
    const { accountId, ruleId } = await seedRule(1_234, dueAt, true);
    await runDueRules(dueAt);
    await setRuleEnabled(ruleId, false);

    await expect(confirmPendingOccurrence(ruleId, dueAt, 1_234))
      .rejects.toThrow('周期账已暂停，启用后才能入账');

    expect(await db.entries.count()).toBe(0);
    expect((await db.accounts.get(accountId))?.balance).toBe(100_000);
    expect((await db.settings.get('recurring.pendingConfirms'))?.value).toEqual([
      expect.objectContaining({ ruleId, dueAt }),
    ]);
  });

  it('编辑规则不会追溯改写已入账历史', async () => {
    const dueAt = at(2026, 1, 1);
    const { ruleId } = await seedRule(1_000, dueAt);
    await runDueRules(dueAt);
    const before = await db.entries.where('occurredAt').equals(dueAt).first();

    await updateRule(ruleId, {
      name: '虚构新规则名', type: 'income', amount: 8_888, categoryId: 201,
    });

    expect(await db.entries.where('occurredAt').equals(dueAt).first()).toEqual(before);
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

describe('周期账间隔、起止与跳过', () => {
  async function twoAccounts(): Promise<[number, number]> {
    const a = await addAccount({ name: '虚构周期现金', group: 'cash', balance: 100_000 });
    const b = await addAccount({ name: '虚构周期储蓄', group: 'debit', balance: 0 });
    return [a, b];
  }
  it('每 2 月规则只生成间隔期次', async () => {
    const [acct] = await twoAccounts();
    await addRule({ name: '虚构双月', amount: 100, amountConfirm: false, freq: 'monthly', days: [31], accountId: acct, categoryId: 1, enabled: true, interval: 2, nextRunAt: new Date(2026, 0, 31, 9).getTime() });
    const { booked } = await runDueRules(new Date(2026, 4, 1, 9).getTime());
    expect(booked).toBe(2);
    const days = (await db.entries.toArray()).map(e => new Date(e.occurredAt).getMonth()).sort((a, b) => a - b);
    expect(days).toEqual([0, 2]);
  });
  it('月底不存在日期按月末执行', async () => {
    const [acct] = await twoAccounts();
    await addRule({ name: '虚构月末', amount: 100, amountConfirm: false, freq: 'monthly', days: [31], accountId: acct, categoryId: 1, enabled: true, nextRunAt: new Date(2026, 0, 31, 9).getTime() });
    const { booked } = await runDueRules(new Date(2026, 4, 1, 9).getTime());
    expect(booked).toBe(4);
    const days = (await db.entries.toArray()).map(e => new Date(e.occurredAt).getDate()).sort((a, b) => a - b);
    expect(days).toEqual([28, 30, 31, 31]);
  });
  it('结束日期后不再生成新期次', async () => {
    const [acct] = await twoAccounts();
    await addRule({ name: '虚构限期', amount: 100, amountConfirm: false, freq: 'monthly', days: [1], accountId: acct, categoryId: 1, enabled: true, endDate: new Date(2026, 1, 1, 9).getTime(), nextRunAt: new Date(2026, 0, 1, 9).getTime() });
    const { booked } = await runDueRules(new Date(2026, 5, 1, 9).getTime());
    expect(booked).toBe(2);
  });
  it('跳过本期顺延到再下一期并清除该期待确认项', async () => {
    const [acct] = await twoAccounts();
    const id = await addRule({ name: '虚构跳过', amount: 100, amountConfirm: true, freq: 'monthly', days: [5], accountId: acct, categoryId: 1, enabled: true, nextRunAt: new Date(2026, 0, 5, 9).getTime() });
    await runDueRules(new Date(2026, 0, 6, 9).getTime());
    let pending = (await db.settings.get('recurring.pendingConfirms'))?.value as { ruleId: number; dueAt: number }[];
    expect(pending).toHaveLength(1);
    await skipNextOccurrence(id);
    pending = (await db.settings.get('recurring.pendingConfirms'))?.value as { ruleId: number; dueAt: number }[];
    expect(pending).toHaveLength(0);
    expect((await db.recurringRules.get(id))?.nextRunAt).toBe(new Date(2026, 1, 5, 9).getTime());
    await skipNextOccurrence(id);
    expect((await db.recurringRules.get(id))?.nextRunAt).toBe(new Date(2026, 2, 5, 9).getTime());
  });
  it('周期转账生成双边流水且不重复记支出', async () => {
    const [acct, target] = await twoAccounts();
    await addRule({ name: '虚构转账', amount: 500, amountConfirm: false, freq: 'monthly', days: [1], accountId: acct, categoryId: 1, enabled: true, transferToAccountId: target, nextRunAt: new Date(2026, 0, 1, 9).getTime() });
    await runDueRules(new Date(2026, 0, 2, 9).getTime());
    const entry = (await db.entries.toArray())[0];
    expect(entry.type).toBe('transfer');
    expect(entry.fromAccountId).not.toBe(entry.toAccountId);
  });
});
