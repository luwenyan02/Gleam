import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/core/db';
import { listInAppReminders } from '../src/core/notify';
import { addAccount } from '../src/core/repo/accountRepo';
import { addCreditStatement, createAndLinkCreditPayment } from '../src/core/repo/creditRepo';
import { addRule } from '../src/core/repo/recurringRepo';
import { setSetting } from '../src/core/repo/settingsRepo';

const DAY = 86400000;

beforeEach(async () => {
  await db.delete();
  await db.open();
});

describe('网页版应用内提醒', () => {
  it('只列出已开启且需要处理的周期账、信用卡账单和备份', async () => {
    const now = new Date(2026, 8, 10, 12).getTime();
    const cashId = await addAccount({ name: '虚构现金', group: 'cash', balance: 10_000 });
    const cardId = await addAccount({ name: '虚构信用卡', group: 'credit', balance: -3_000 });
    await addRule({
      name: '虚构房租', type: 'expense', amount: 1_200, amountConfirm: true,
      freq: 'monthly', days: [11], accountId: cashId, categoryId: 101,
      enabled: true, nextRunAt: now + DAY,
    });
    const statementId = await addCreditStatement({
      accountId: cardId,
      periodStart: now - 20 * DAY,
      periodEnd: now,
      dueAt: now + 2 * DAY,
      amountDue: 3_000,
      note: '虚构账单',
      reminderEnabled: true,
    });
    await Promise.all([
      setSetting('notification.recurring', true),
      setSetting('notification.creditCard', true),
      setSetting('notification.backup', true),
      setSetting('backup.auto', 'daily'),
      setSetting('backup.lastBackupAt', now - 2 * DAY),
    ]);

    expect((await listInAppReminders(now)).map((item) => item.kind))
      .toEqual(['backup', 'recurring', 'creditCard']);

    await createAndLinkCreditPayment({
      statementId, fromAccountId: cashId, amount: 3_000, occurredAt: now,
    });
    await setSetting('notification.recurring', false);
    expect((await listInAppReminders(now)).map((item) => item.kind)).toEqual(['backup']);
  });

  it('信用卡仅在到期前三天内提示，周期账显示未来七天', async () => {
    const now = new Date(2026, 8, 10, 12).getTime();
    const cashId = await addAccount({ name: '虚构现金', group: 'cash', balance: 10_000 });
    const cardId = await addAccount({ name: '虚构信用卡', group: 'credit', balance: -3_000 });
    await addRule({
      name: '虚构周期账', type: 'expense', amount: 500, amountConfirm: false,
      freq: 'weekly', days: [3], accountId: cashId, categoryId: 101,
      enabled: true, nextRunAt: now + 7 * DAY,
    });
    await addCreditStatement({
      accountId: cardId,
      periodStart: now - 20 * DAY,
      periodEnd: now,
      dueAt: now + 4 * DAY,
      amountDue: 3_000,
      note: '',
      reminderEnabled: true,
    });
    await setSetting('notification.recurring', true);
    await setSetting('notification.creditCard', true);

    expect((await listInAppReminders(now)).map((item) => item.kind)).toEqual(['recurring']);
  });
});
