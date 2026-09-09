import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/core/db';
import { addAccount } from '../src/core/repo/accountRepo';
import {
  addCreditStatement, createAndLinkCreditPayment, getCreditStatementSummary,
  linkExistingCreditPayment, listCreditStatementSummaries,
} from '../src/core/repo/creditRepo';
import { addEntry, restoreEntry, softDeleteEntry, updateEntry } from '../src/core/repo/entryRepo';

let cash: number;
let card: number;
const day = (month: number, date: number) => new Date(2026, month - 1, date, 12).getTime();

beforeEach(async () => {
  await db.delete(); await db.open();
  cash = await addAccount({ name: '虚构现金', group: 'cash', balance: 10_000 });
  card = await addAccount({ name: '虚构信用卡', group: 'credit', balance: -3_000, billingDay: 20, repayDay: 10 });
});

async function statement(amountDue = 3_000): Promise<number> {
  return addCreditStatement({
    accountId: card, periodStart: day(8, 21), periodEnd: day(9, 20), dueAt: day(10, 10),
    amountDue, note: '虚构九月账单', reminderEnabled: true,
  });
}

describe('信用卡账单与分次还款', () => {
  it('3000 分两次还 1000/2000，删除和恢复第二笔实时重算', async () => {
    const statementId = await statement();
    const first = await createAndLinkCreditPayment({ statementId, fromAccountId: cash, amount: 1_000, occurredAt: day(9, 25) });
    const second = await createAndLinkCreditPayment({ statementId, fromAccountId: cash, amount: 2_000, occurredAt: day(10, 1) });

    expect(await getCreditStatementSummary(statementId)).toMatchObject({ amountDue: 3_000, paid: 3_000, remaining: 0 });
    expect((await db.accounts.get(cash))?.balance).toBe(7_000);
    expect((await db.accounts.get(card))?.balance).toBe(0);

    await softDeleteEntry(second.entryId);
    expect(await getCreditStatementSummary(statementId)).toMatchObject({ paid: 1_000, remaining: 2_000 });
    expect((await db.accounts.get(cash))?.balance).toBe(9_000);
    expect((await db.accounts.get(card))?.balance).toBe(-2_000);

    await restoreEntry(second.entryId);
    expect(await getCreditStatementSummary(statementId)).toMatchObject({ paid: 3_000, remaining: 0 });
    expect((await db.accounts.get(cash))?.balance).toBe(7_000);
    expect(first.allocatedAmount).toBe(1_000);
    expect(second.allocatedAmount).toBe(2_000);
  });

  it('已有转账只能关联一次，修改金额后按有效金额重算', async () => {
    const statementId = await statement();
    const entryId = await addEntry({
      type: 'transfer', amount: 2_000, occurredAt: day(9, 28), fromAccountId: cash, toAccountId: card,
      note: '虚构手工还款',
    });
    await linkExistingCreditPayment({ statementId, entryId, allocatedAmount: 2_000 });
    await expect(linkExistingCreditPayment({ statementId, entryId, allocatedAmount: 1_000 })).rejects.toThrow('已关联');

    await updateEntry(entryId, { amount: 500 });
    expect(await getCreditStatementSummary(statementId)).toMatchObject({ paid: 500, remaining: 2_500 });
  });

  it('超出本期的真实转账保留未分配金额，旧转账不会自动认领', async () => {
    const priorEntryId = await addEntry({
      type: 'transfer', amount: 600, occurredAt: day(9, 19), fromAccountId: cash, toAccountId: card,
    });
    const statementId = await statement(1_500);
    expect(await getCreditStatementSummary(statementId)).toMatchObject({ paid: 0, remaining: 1_500 });

    const payment = await createAndLinkCreditPayment({
      statementId, fromAccountId: cash, amount: 2_000, occurredAt: day(9, 25),
    });
    expect(payment).toMatchObject({ allocatedAmount: 1_500, unallocatedAmount: 500 });
    expect(await getCreditStatementSummary(statementId)).toMatchObject({ paid: 1_500, remaining: 0 });
    expect((await db.creditPayments.where('entryId').equals(priorEntryId).count())).toBe(0);
  });

  it('拒绝非整数分、重叠区间和超出流水或本期剩余的关联金额', async () => {
    const statementId = await statement();
    await expect(addCreditStatement({
      accountId: card, periodStart: day(9, 1), periodEnd: day(10, 1), dueAt: day(10, 10),
      amountDue: 100, reminderEnabled: true,
    })).rejects.toThrow('重叠');
    await expect(createAndLinkCreditPayment({
      statementId, fromAccountId: cash, amount: 1.5, occurredAt: day(9, 25),
    })).rejects.toThrow('整数');

    const entryId = await addEntry({ type: 'transfer', amount: 1_000, occurredAt: day(9, 25), fromAccountId: cash, toAccountId: card });
    await expect(linkExistingCreditPayment({ statementId, entryId, allocatedAmount: 1_001 })).rejects.toThrow('流水金额');
    await expect(linkExistingCreditPayment({ statementId, entryId, allocatedAmount: 3_001 })).rejects.toThrow();
  });

  it('总欠款与本期应还、已还、剩余分别派生', async () => {
    const older = await statement(2_000);
    await createAndLinkCreditPayment({ statementId: older, fromAccountId: cash, amount: 1_000, occurredAt: day(9, 25) });
    const summaries = await listCreditStatementSummaries(card);
    expect(summaries[0]).toMatchObject({ amountDue: 2_000, paid: 1_000, remaining: 1_000, totalDebt: 2_000 });
  });
});
