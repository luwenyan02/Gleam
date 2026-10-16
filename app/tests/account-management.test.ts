import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/core/db';
import {
  addAccount, creditLimitStatus, deleteAccount, getNetWorth, listAccountsByGroup, previewReconcileAccount,
  reconcileAccount, reorderAccountWithinGroup, setAccountCountInNetWorth, setAccountHidden, updateAccount,
} from '../src/core/repo/accountRepo';
import { getEntry, restoreEntry, softDeleteEntry } from '../src/core/repo/entryRepo';
import { rangeSummary } from '../src/core/repo/statsRepo';
import { exportAll, restoreAll } from '../src/core/repo/backupRepo';

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

  it('对账差额增加记收入、减少记支出，并保留账内与实际余额', async () => {
    const id = await addAccount({ name: '虚构现金', group: 'cash', balance: 10_000 });
    expect(await previewReconcileAccount(id, 12_300)).toEqual({
      accountId: id, currentBalance: 10_000, targetBalance: 12_300, difference: 2_300,
    });

    const incomeId = await reconcileAccount(id, 12_300);
    expect(await getEntry(incomeId!)).toMatchObject({
      type: 'income', amount: 2_300, accountId: id, note: '余额对账调整',
      reconcileBeforeBalance: 10_000, reconcileTargetBalance: 12_300,
    });
    const expenseId = await reconcileAccount(id, 11_000);
    expect(await getEntry(expenseId!)).toMatchObject({
      type: 'expense', amount: 1_300, accountId: id, note: '余额对账调整',
      reconcileBeforeBalance: 12_300, reconcileTargetBalance: 11_000,
    });
    expect((await db.accounts.get(id))?.balance).toBe(11_000);
    expect(await rangeSummary(new Date(2000, 0, 1).getTime(), new Date(2100, 0, 1).getTime()))
      .toEqual({ expense: 1_300, income: 2_300, balance: 1_000 });
    await softDeleteEntry(expenseId!);
    expect((await db.accounts.get(id))?.balance).toBe(12_300);
    await restoreEntry(expenseId!);
    expect((await db.accounts.get(id))?.balance).toBe(11_000);
  });

  it('信用卡保存信用额度并按当前欠款计算剩余或超额', async () => {
    const id = await addAccount({
      name: '虚构信用卡', group: 'credit', balance: -3_000, creditLimit: 10_000,
    });
    expect(creditLimitStatus((await db.accounts.get(id))!)).toEqual({
      limit: 10_000, remaining: 7_000, overLimit: 0,
    });

    await updateAccount(id, { creditLimit: 2_000 });
    expect(creditLimitStatus((await db.accounts.get(id))!)).toEqual({
      limit: 2_000, remaining: 0, overLimit: 1_000,
    });
    await expect(updateAccount(id, { creditLimit: -1 })).rejects.toThrow('信用额度');
    await expect(addAccount({
      name: '虚构储蓄卡', group: 'debit', balance: 0, creditLimit: 10_000,
    })).rejects.toThrow('仅信用卡账户');

    const dump = await exportAll();
    await db.accounts.clear();
    await restoreAll(dump);
    expect((await db.accounts.get(id))?.creditLimit).toBe(2_000);
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


describe('账户类型修正', () => {
  it('改类型只重分组，保留余额、隐藏和所有流水', async () => {
    const id = await addAccount({ name: '虚构钱包', group: 'other', balance: 550, hidden: true });
    await db.entries.add({ id: 1, type: 'income', amount: 550, accountId: id, occurredAt: 1,
      reimburseStatus: 'none', deletedAt: 0, createdAt: 1, updatedAt: 1 });
    const entries = await db.entries.toArray();
    await updateAccount(id, { group: 'cash' });
    expect(await db.accounts.get(id)).toMatchObject({ group: 'cash', balance: 550, hidden: true });
    expect(await db.entries.toArray()).toEqual(entries);
  });
  it('改出信用卡分组清除专属配置，保留负余额', async () => {
    const id = await addAccount({ name: '虚构月付', group: 'credit', balance: -500, creditLimit: 10000, billingDay: 2, repayDay: 8 });
    await updateAccount(id, { group: 'online' });
    const result = await db.accounts.get(id);
    expect(result).toMatchObject({ group: 'online', balance: -500 });
    expect(result?.creditLimit).toBeUndefined();
    expect(result?.billingDay).toBeUndefined();
    expect(result?.repayDay).toBeUndefined();
  });
  it('历史借贷角色不可通过改分组破坏，已删除流水也需可恢复', async () => {
    const fund = await addAccount({ name: '虚构资金', group: 'other', balance: 0 });
    const loan = await addAccount({ name: '虚构往来', group: 'receivable', balance: 0 });
    await db.entries.add({ id: 1, type: 'loan', loanKind: 'lend', amount: 100, fromAccountId: fund, toAccountId: loan,
      occurredAt: 1, reimburseStatus: 'none', deletedAt: 2, createdAt: 1, updatedAt: 1 });
    await expect(updateAccount(fund, { group: 'receivable' })).rejects.toThrow('借贷');
    await expect(updateAccount(loan, { group: 'cash' })).rejects.toThrow('借贷');
    await updateAccount(fund, { group: 'cash' });
    expect((await db.accounts.get(loan))?.group).toBe('receivable');
  });
  it('已有信用卡账单的账户不能改出信用卡类型', async () => {
    const id = await addAccount({ name: '虚构信用卡', group: 'credit', balance: 0 });
    await db.creditStatements.put({ id: 1, accountId: id } as never);
    await expect(updateAccount(id, { group: 'online' })).rejects.toThrow('信用卡账单');
    expect((await db.accounts.get(id))?.group).toBe('credit');
  });
});
