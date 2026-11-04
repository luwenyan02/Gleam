import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { db } from '../src/core/db';
import { addAccount } from '../src/core/repo/accountRepo';
import { addEntry, softDeleteEntry } from '../src/core/repo/entryRepo';
import { exportAll, restoreAll } from '../src/core/repo/backupRepo';
import * as repo from '../src/core/repo/recurringRepo';
import * as scheduler from '../src/core/scheduler';
import type { NewRecurringRule } from '../src/core/repo/recurringRepo';

const at = (month: number, day: number, hour = 9) => new Date(2026, month - 1, day, hour).getTime();
const today = at(11, 4, 12), due = at(11, 2);
let accountId: number;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(today);
  await db.delete(); await db.open();
  accountId = await addAccount({ name: '虚构补记账户', group: 'cash', balance: 100_000 });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
async function legacy(patch: Partial<NewRecurringRule> = {}) {
  const id = await repo.addRule({ name: '虚构旧规则', type: 'expense', amount: 1000, amountConfirm: false,
    freq: 'monthly', days: [2], startDate: at(11, 1), accountId, categoryId: 101, enabled: true, ...patch });
  await db.recurringRules.update(id, { nextRunAt: at(12, 2), initialCatchUpThrough: undefined });
  return id;
}

it('旧规则预览不写账；确认后按原日期补记一次，保留未来下一期', async () => {
  const id = await legacy(), preview = await repo.previewInitialCatchUp(id);
  expect(preview.dates).toEqual([due]); expect(await db.entries.count()).toBe(0);
  expect((await repo.applyInitialCatchUp(preview)).booked).toBe(1);
  expect((await repo.applyInitialCatchUp(preview)).booked).toBe(0);
  expect((await db.entries.toArray()).map(e => e.occurredAt)).toEqual([due]);
  const rule = (await db.recurringRules.get(id))!;
  expect(rule.nextRunAt).toBe(at(12, 2)); expect(repo.hasInitialCatchUp(rule)).toBe(false);
  expect((await db.accounts.get(accountId))?.balance).toBe(99_000);
});
it('并发补记同一预览仅入账一次', async () => {
  const id = await legacy(), preview = await repo.previewInitialCatchUp(id);
  const results = await Promise.all([repo.applyInitialCatchUp(preview), repo.applyInitialCatchUp(preview)]);
  expect(results.reduce((n, r) => n + r.booked, 0)).toBe(1);
  expect(await db.entries.count()).toBe(1);
});
it('已有周期账、同日手动补记和已删除记录均保守跳过', async () => {
  const id = await legacy({ startDate: at(9, 1) });
  await addEntry({ type: 'expense', amount: 1200, accountId, categoryId: 101, occurredAt: at(9, 2), note: '周期账 · 虚构旧规则' });
  await addEntry({ type: 'expense', amount: 1000, accountId, categoryId: 101, occurredAt: at(10, 2, 15), note: '虚构手动补记' });
  const deleted = await addEntry({ type: 'expense', amount: 1000, accountId, categoryId: 101, occurredAt: due, note: '周期账 · 虚构旧规则' });
  await softDeleteEntry(deleted);
  const balance = (await db.accounts.get(accountId))!.balance;
  const preview = await repo.previewInitialCatchUp(id);
  expect(preview.dates).toEqual([]); expect(preview.skipped).toBe(3);
  await repo.applyInitialCatchUp(preview);
  expect(await db.entries.count()).toBe(3);
  expect((await db.accounts.get(accountId))!.balance).toBe(balance);
});
it('预览后手动补记同日账单，提交时重新查重', async () => {
  const id = await legacy(), preview = await repo.previewInitialCatchUp(id);
  await addEntry({ type: 'expense', amount: 1000, accountId, categoryId: 101, occurredAt: at(11, 2, 14), note: '虚构手动补记' });
  expect((await repo.applyInitialCatchUp(preview)).booked).toBe(0);
  expect(await db.entries.count()).toBe(1);
});
it('确认金额补记只生成持久化待确认项，与已有待确认项不重复', async () => {
  const id = await legacy({ amountConfirm: true }), preview = await repo.previewInitialCatchUp(id);
  const result = await repo.applyInitialCatchUp(preview);
  expect(result.booked).toBe(0); expect(result.pending).toHaveLength(1);
  const again = await repo.applyInitialCatchUp(preview);
  expect(again.pending).toHaveLength(0);
  expect(await db.entries.count()).toBe(0);
  expect((await db.settings.get('recurring.pendingConfirms'))?.value).toHaveLength(1);
  await repo.confirmPendingOccurrence(id, due, 1234);
  expect((await db.entries.toArray())[0].amount).toBe(1234);
});
it('已在待确认队列中的漏期不再次入队', async () => {
  const id = await legacy({ amountConfirm: true });
  await db.settings.put({ key: 'recurring.pendingConfirms', value: [{ ruleId: id, name: '虚构旧规则', amount: 1000, dueAt: due, accountId, categoryId: 101 }], updatedAt: today });
  const preview = await repo.previewInitialCatchUp(id);
  expect(preview.dates).toEqual([]); expect(preview.skipped).toBe(1);
  await repo.applyInitialCatchUp(preview);
  expect((await db.settings.get('recurring.pendingConfirms'))?.value).toHaveLength(1);
});
it('用户明确跳过的期次不在漏期补记中恢复', async () => {
  const id = await legacy(); await db.recurringRules.update(id, { nextRunAt: due });
  await repo.skipNextOccurrence(id);
  const preview = await repo.previewInitialCatchUp(id);
  expect(preview.dates).toEqual([]); expect(preview.skipped).toBe(1);
});
it('只补创建规则时漏掉的期次，不重放后来的暂停时段', async () => {
  const id = await legacy(); vi.setSystemTime(at(12, 5));
  await repo.setRuleEnabled(id, false); await repo.setRuleEnabled(id, true);
  const preview = await repo.previewInitialCatchUp(id);
  expect(preview.dates).toEqual([due]);
  await repo.applyInitialCatchUp(preview);
  expect((await db.entries.toArray()).map(e => e.occurredAt)).toEqual([due]);
});
it('预览后修改金额、账户或排期必须重新检查，不使用过期预览入账', async () => {
  const id = await legacy(), preview = await repo.previewInitialCatchUp(id);
  await repo.updateRule(id, { amount: 2000 });
  await expect(repo.applyInitialCatchUp(preview)).rejects.toThrow('规则已变化');
  expect(await db.entries.count()).toBe(0);
});
it('暂停或已删除规则不允许补记', async () => {
  const id = await legacy(), preview = await repo.previewInitialCatchUp(id);
  await repo.setRuleEnabled(id, false);
  await expect(repo.applyInitialCatchUp(preview)).rejects.toThrow('已暂停');
  await repo.deleteRule(id);
  await expect(repo.applyInitialCatchUp(preview)).rejects.toThrow('不存在');
});
it('补记中途失败，账单、余额和核对进度整体回滚', async () => {
  const id = await legacy({ startDate: at(9, 1) }), preview = await repo.previewInitialCatchUp(id);
  let count = 0;
  const fail = () => { if (++count === 2) throw new Error('虚构第二笔失败'); };
  db.entries.hook('creating', fail);
  try { await expect(repo.applyInitialCatchUp(preview)).rejects.toThrow('虚构第二笔失败'); }
  finally { db.entries.hook('creating').unsubscribe(fail); }
  expect(await db.entries.count()).toBe(0);
  expect((await db.accounts.get(accountId))?.balance).toBe(100_000);
  expect((await db.recurringRules.get(id))?.initialCatchUpThrough).toBeUndefined();
});
it('补记进度和跳过信息随备份恢复保留，不再次补账', async () => {
  const id = await legacy(); await repo.applyInitialCatchUp(await repo.previewInitialCatchUp(id));
  const skipped = await legacy({ name: '虚构跳过备份' });
  await db.recurringRules.update(skipped, { nextRunAt: due }); await repo.skipNextOccurrence(skipped);
  const dump = JSON.parse(JSON.stringify(await exportAll())); await restoreAll(dump);
  expect((await repo.previewInitialCatchUp(skipped)).dates).toEqual([]);
  expect((await db.recurringRules.get(skipped))?.skippedOccurrences).toEqual([due]);
  expect(repo.hasInitialCatchUp((await db.recurringRules.get(id))!)).toBe(false);
  expect((await repo.runDueRules()).booked).toBe(0); expect(await db.entries.count()).toBe(1);
});
it('超过400期分批核对并持久化进度，每期仅生成一次', async () => {
  const start = new Date(2026, 10, 4 - 400, 9).getTime();
  const id = await legacy({ freq: 'daily', days: [], startDate: start });
  const first = await repo.previewInitialCatchUp(id);
  expect(first.dates).toHaveLength(400); expect(first.more).toBe(true);
  await repo.applyInitialCatchUp(first);
  const second = await repo.previewInitialCatchUp(id);
  expect(second.dates).toHaveLength(1); expect(second.more).toBe(false);
  await repo.applyInitialCatchUp(second);
  expect(await db.entries.count()).toBe(401);
  expect(repo.hasInitialCatchUp((await db.recurringRules.get(id))!)).toBe(false);
}, 15_000);
it('新规则无需旧账补记；保存补跑可在其他调度期间执行并只通知一次待确认', async () => {
  const id = await legacy({ amountConfirm: true });
  await db.recurringRules.update(id, { initialCatchUpThrough: today, nextRunAt: due });
  expect(repo.hasInitialCatchUp((await db.recurringRules.get(id))!)).toBe(false);
  const received: number[] = [], stop = scheduler.onPendingConfirm(items => received.push(...items.map(i => i.dueAt)));
  try { await Promise.all([scheduler.catchUp(), scheduler.catchUpRecurringRules(), scheduler.catchUpRecurringRules()]); }
  finally { stop(); }
  expect(received).toEqual([due]); expect(await db.entries.count()).toBe(0);
});

it('确认金额的周期转账先待确认，确认后才改变双边余额', async () => {
  const target = await addAccount({ name: '虚构转入账户', group: 'debit', balance: 0 });
  const id = await repo.addRule({ name: '虚构待确认转账', type: 'expense', amount: 1000, amountConfirm: true,
    freq: 'monthly', days: [2], startDate: at(11, 1), accountId, transferToAccountId: target, categoryId: 101, enabled: true });
  const result = await repo.runDueRules();
  expect(result.booked).toBe(0);
  expect(result.pending).toEqual([expect.objectContaining({ ruleId: id, dueAt: due, transferToAccountId: target })]);
  expect((await db.accounts.get(accountId))?.balance).toBe(100_000);
  await repo.confirmPendingOccurrence(id, due, 1200);
  const entry = (await db.entries.toArray())[0];
  expect(entry.type).toBe('transfer'); expect(entry.fromAccountId).toBe(accountId); expect(entry.toAccountId).toBe(target);
  expect((await db.accounts.get(accountId))?.balance).toBe(98_800);
  expect((await db.accounts.get(target))?.balance).toBe(1200);
});
it('保存补跑自动续批超过400期，新规则不留下已到期的下一期', async () => {
  await repo.addRule({ name: '虚构长历史规则', amount: 100, amountConfirm: false, freq: 'daily', days: [],
    startDate: new Date(2026, 10, 4 - 400, 9).getTime(), accountId, categoryId: 101, enabled: true });
  expect((await scheduler.catchUpRecurringRules()).booked).toBe(401);
  expect(await db.entries.count()).toBe(401);
  expect((await scheduler.catchUpRecurringRules()).booked).toBe(0);
}, 15_000);
