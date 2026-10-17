import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { db } from '../src/core/db';
import { listInAppReminders, refreshSchedules } from '../src/core/notify';
import { addAccount } from '../src/core/repo/accountRepo';
import { addCreditStatement, createAndLinkCreditPayment } from '../src/core/repo/creditRepo';
import { addRule } from '../src/core/repo/recurringRepo';
import { setSetting } from '../src/core/repo/settingsRepo';

const DAY = 86400000;
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: vi.fn(() => false) } }));
vi.mock('@capacitor/local-notifications', () => ({ LocalNotifications: {
  getPending: vi.fn(), cancel: vi.fn(), schedule: vi.fn(), checkPermissions: vi.fn(),
} }));

beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
  await db.delete();
  await db.open();
});

describe('网页版应用内提醒', () => {
  it('Android 升级后取消遗留备份通知，即使旧开关仍开启也不再排期', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    vi.mocked(LocalNotifications.getPending).mockResolvedValue({ notifications: [{ id: 3001 }, { id: 9999 }] });
    vi.mocked(LocalNotifications.cancel).mockResolvedValue(undefined);
    await setSetting('notification.recurring', false);
    await setSetting('notification.creditCard', false);
    await setSetting('notification.backup', true);
    await setSetting('backup.auto', 'daily');
    await refreshSchedules();
    expect(LocalNotifications.cancel).toHaveBeenCalledWith({ notifications: [{ id: 3001 }] });
    expect(LocalNotifications.schedule).not.toHaveBeenCalled();
  });
  it('旧备份提醒设置不再生效，周期账和信用卡提醒保留', async () => {
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
      .toEqual(['recurring', 'creditCard']);

    await createAndLinkCreditPayment({
      statementId, fromAccountId: cashId, amount: 3_000, occurredAt: now,
    });
    await setSetting('notification.recurring', false);
    expect((await listInAppReminders(now)).map((item) => item.kind)).toEqual([]);
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
