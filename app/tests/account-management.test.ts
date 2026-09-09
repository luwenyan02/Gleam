import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/core/db';
import {
  addAccount, deleteAccount, getNetWorth, listAccountsByGroup, previewReconcileAccount,
  reconcileAccount, reorderAccountWithinGroup, setAccountCountInNetWorth, setAccountHidden,
} from '../src/core/repo/accountRepo';
import { getEntry } from '../src/core/repo/entryRepo';

beforeEach(async () => { await db.delete(); await db.open(); });

describe('账户管理边界', () => {
  it('只在账户所属组内排序，不改动其他分组顺序', async () => {
    const cashA = await addAccount({ name: '虚构现金甲', group: 'cash', balance: 0 });
    const bank = await addAccount({ name: '虚构储蓄卡', group: 'debit', balance: 0 });
    const cashB = await addAccount({ name: '虚构现金乙', group: 'cash', balance: 0 });

    await reorderAccountWithinGroup(cashB, 'up');

    const groups = await listAccountsByGroup();
    expect(groups.cash.map(account => account.id)).toEqual([cashB, cashA]);
    expect(groups.debit.map(account => account.id)).toEqual([bank]);
  });

  it('隐藏和净资产计入是两个独立选择', async () => {
    const id = await addAccount({ name: '虚构储蓄卡', group: 'debit', balance: 12_300 });
    await setAccountHidden(id, true);
    expect((await db.accounts.get(id))?.countInNetWorth).toBe(true);
    expect((await getNetWorth()).net).toBe(12_300);

    await setAccountCountInNetWorth(id, false);
    expect((await db.accounts.get(id))?.hidden).toBe(true);
    expect((await getNetWorth()).net).toBe(0);

    await setAccountHidden(id, false);
    expect((await db.accounts.get(id))?.countInNetWorth).toBe(false);
    expect((await getNetWorth()).net).toBe(0);
  });

  it('对账先给出差额预览，生成的单边流水保留账内与实际余额', async () => {
    const id = await addAccount({ name: '虚构现金', group: 'cash', balance: 10_000 });
    expect(await previewReconcileAccount(id, 12_300)).toEqual({
      accountId: id, currentBalance: 10_000, targetBalance: 12_300, difference: 2_300,
    });

    const entryId = await reconcileAccount(id, 12_300);
    expect(await getEntry(entryId!)).toMatchObject({
      type: 'transfer', amount: 2_300, toAccountId: id,
      reconcileBeforeBalance: 10_000, reconcileTargetBalance: 12_300,
    });
  });

  it('仅余额为零且从未被业务引用的账户可以删除', async () => {
    const nonzero = await addAccount({ name: '非零账户', group: 'cash', balance: 1 });
    await expect(deleteAccount(nonzero)).rejects.toThrow('余额');

    const historical = await addAccount({ name: '历史账户', group: 'cash', balance: 0 });
    await db.entries.add({
      id: 91, type: 'expense', amount: 100, occurredAt: 1, accountId: historical,
      reimburseStatus: 'none', deletedAt: 2, createdAt: 1, updatedAt: 2,
    });
    await expect(deleteAccount(historical)).rejects.toThrow('历史');

    const scheduled = await addAccount({ name: '周期账户', group: 'cash', balance: 0 });
    await db.recurringRules.add({
      id: 92, name: '虚构周期账', amount: 100, amountConfirm: false, freq: 'monthly', days: [1],
      accountId: scheduled, categoryId: 1, enabled: false, nextRunAt: 1, createdAt: 1, updatedAt: 1,
    });
    await expect(deleteAccount(scheduled)).rejects.toThrow('周期');

    const empty = await addAccount({ name: '空账户', group: 'cash', balance: 0 });
    await deleteAccount(empty);
    expect(await db.accounts.get(empty)).toBeUndefined();
  });
});
