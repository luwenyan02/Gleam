import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../src/core/db';
import { on } from '../src/core/store';
import type { Entry } from '../src/core/types';
import { addAccount } from '../src/core/repo/accountRepo';
import { addCategory } from '../src/core/repo/categoryRepo';
import { addEntry, getEntryTagIds, softDeleteEntry } from '../src/core/repo/entryRepo';
import { ensureTag } from '../src/core/repo/tagRepo';
import {
  applyBatchEntries,
  previewBatchEntries,
} from '../src/core/repo/batchEntryRepo';

let cash: number;
let bank: number;
let receivable: number;
let expenseOne: number;
let expenseTwo: number;
let incomeOne: number;
let incomeTwo: number;
const stops: (() => void)[] = [];

beforeEach(async () => {
  await db.delete();
  await db.open();
  cash = await addAccount({ name: '虚构现金账户', group: 'cash', balance: 10_000 });
  bank = await addAccount({ name: '虚构银行卡', group: 'debit', balance: 10_000 });
  receivable = await addAccount({ name: '虚构往来账户', group: 'receivable', balance: 0 });
  expenseOne = await addCategory({ name: '虚构餐饮', icon: 'ic-bowl', kind: 'expense' });
  expenseTwo = await addCategory({ name: '虚构交通', icon: 'ic-bus', kind: 'expense' });
  incomeOne = await addCategory({ name: '虚构工资', icon: 'ic-coin', kind: 'income' });
  incomeTwo = await addCategory({ name: '虚构奖金', icon: 'ic-coin', kind: 'income' });
});

afterEach(() => {
  stops.splice(0).forEach((stop) => stop());
  vi.restoreAllMocks();
});

async function seedMixedEntries(): Promise<{
  expenseId: number;
  incomeId: number;
  transferId: number;
  loanId: number;
}> {
  const expenseId = await addEntry({
    type: 'expense', amount: 1_000, occurredAt: 1, categoryId: expenseOne, accountId: cash,
  });
  const incomeId = await addEntry({
    type: 'income', amount: 500, occurredAt: 2, categoryId: incomeOne, accountId: cash,
  });
  const transferId = await addEntry({
    type: 'transfer', amount: 200, occurredAt: 3, fromAccountId: cash, toAccountId: bank,
  });
  const loanId = await addEntry({
    type: 'loan', loanKind: 'lend', amount: 300, occurredAt: 4,
    fromAccountId: bank, toAccountId: receivable,
  });
  return { expenseId, incomeId, transferId, loanId };
}

describe('共享批量账单事务', () => {
  async function seedCategoryBatch(count: number): Promise<number[]> {
    const rows: Entry[] = Array.from({ length: count }, (_, index) => ({
      id: 40_000 + index, type: 'expense', amount: 100, accountId: cash,
      categoryId: expenseOne, occurredAt: index + 1, reimburseStatus: 'none',
      deletedAt: 0, createdAt: 1, updatedAt: 1,
    }));
    await db.entries.bulkAdd(rows);
    return rows.map(row => row.id).reverse();
  }

  it('大批改分类限制单次写入队列，保持全部结果顺序且仅提交一次事件', async () => {
    const ids = await seedCategoryBatch(1001);
    const writes = vi.spyOn(db.entries, 'bulkPut');
    const events: string[] = [];
    stops.push(on('entries-changed', () => events.push('entries-changed')));
    const result = await applyBatchEntries(ids, { kind: 'category', categoryId: expenseTwo });
    expect(writes.mock.calls.map(([rows]) => rows.length)).toEqual([500, 500, 1]);
    expect(result.appliedIds).toEqual(ids);
    expect(await db.entries.where('categoryId').equals(expenseTwo).count()).toBe(1001);
    expect((await db.accounts.get(cash))?.balance).toBe(10_000);
    expect(events).toEqual(['entries-changed']);
  }, 15_000);

  it('后续写入块中途失败时，之前的所有块仍在同一事务内回滚', async () => {
    const ids = await seedCategoryBatch(1001);
    const original = db.entries.bulkPut.bind(db.entries);
    let calls = 0;
    vi.spyOn(db.entries, 'bulkPut').mockImplementation((async (rows: readonly Entry[]) => {
      calls++;
      if (calls === 2) { await original([rows[0]!]); throw new Error('虚构后续块失败'); }
      return original(rows);
    }) as typeof db.entries.bulkPut);
    const events: string[] = [];
    stops.push(on('entries-changed', () => events.push('entries-changed')));
    await expect(applyBatchEntries(ids, { kind: 'category', categoryId: expenseTwo })).rejects.toThrow('虚构后续块失败');
    expect(await db.entries.where('categoryId').equals(expenseOne).count()).toBe(1001);
    expect(await db.entries.where('categoryId').equals(expenseTwo).count()).toBe(0);
    expect(events).toEqual([]);
  }, 15_000);

  it('改分类复用当前写事务内已预检的账单，不重复批量读取', async () => {
    const ids = await seedMixedEntries();
    const before = await db.entries.get(ids.expenseId);
    const read = vi.spyOn(db.entries, 'bulkGet');
    const result = await applyBatchEntries(Object.values(ids), { kind: 'category', categoryId: expenseTwo });
    expect(read).toHaveBeenCalledTimes(1);
    expect(result.appliedIds).toEqual([ids.expenseId]);
    expect(await db.entries.get(ids.expenseId)).toEqual({
      ...before, categoryId: expenseTwo, updatedAt: expect.any(Number),
    });
    expect((await db.entries.get(ids.incomeId))?.categoryId).toBe(incomeOne);
  });

  it('改分类预览按目标分类类型筛选，并说明类型不符及不支持原因', async () => {
    const ids = await seedMixedEntries();

    const preview = await previewBatchEntries(Object.values(ids), {
      kind: 'category', categoryId: expenseTwo,
    });

    expect(preview.processableIds).toEqual([ids.expenseId]);
    expect(preview.skipped).toEqual([
      expect.objectContaining({ entryId: ids.incomeId, code: 'category-type-mismatch' }),
      expect.objectContaining({ entryId: ids.transferId, code: 'unsupported-entry-type' }),
      expect.objectContaining({ entryId: ids.loanId, code: 'unsupported-entry-type' }),
    ]);
    expect(preview.skipped.map((item) => item.reason).every(Boolean)).toBe(true);
  });

  it('改账户只处理收支账单，转账和借贷保持双边账户及余额不变', async () => {
    const ids = await seedMixedEntries();

    const result = await applyBatchEntries(Object.values(ids), { kind: 'account', accountId: bank });

    expect(result.appliedIds).toEqual([ids.expenseId, ids.incomeId]);
    expect(result.skipped.map((item) => item.entryId)).toEqual([ids.transferId, ids.loanId]);
    expect((await db.entries.get(ids.expenseId))?.accountId).toBe(bank);
    expect((await db.entries.get(ids.incomeId))?.accountId).toBe(bank);
    expect(await db.entries.get(ids.transferId)).toEqual(expect.objectContaining({
      fromAccountId: cash, toAccountId: bank,
    }));
    expect(await db.entries.get(ids.loanId)).toEqual(expect.objectContaining({
      fromAccountId: bank, toAccountId: receivable,
    }));
    expect((await db.accounts.get(cash))?.balance).toBe(9_800);
    expect((await db.accounts.get(bank))?.balance).toBe(9_400);
    expect((await db.accounts.get(receivable))?.balance).toBe(300);
  });

  it('批内后续写入失败时回滚此前账单和账户余额，且不广播成功事件', async () => {
    const first = await addEntry({
      type: 'expense', amount: 1_000, occurredAt: 1, categoryId: expenseOne, accountId: cash,
    });
    const second = await addEntry({
      type: 'expense', amount: 2_000, occurredAt: 2, categoryId: expenseOne, accountId: cash,
    });
    const balanceBefore = (await db.accounts.get(cash))?.balance;
    const originalPut = db.entries.put.bind(db.entries);
    let putCount = 0;
    vi.spyOn(db.entries, 'put').mockImplementation((async (entry: Entry) => {
      putCount += 1;
      if (putCount === 2) throw new Error('虚构批量写入失败');
      return originalPut(entry);
    }) as typeof db.entries.put);
    const events: string[] = [];
    stops.push(on('entries-changed', () => events.push('entries-changed')));
    stops.push(on('accounts-changed', () => events.push('accounts-changed')));

    await expect(applyBatchEntries([first, second], { kind: 'account', accountId: bank }))
      .rejects.toThrow('虚构批量写入失败');

    expect((await db.entries.get(first))?.accountId).toBe(cash);
    expect((await db.entries.get(second))?.accountId).toBe(cash);
    expect((await db.accounts.get(cash))?.balance).toBe(balanceBefore);
    expect((await db.accounts.get(bank))?.balance).toBe(10_000);
    expect(events).toEqual([]);
  });

  it('批量改分类的高速写入中途失败时仍整批回滚，且不广播成功事件', async () => {
    const first = await addEntry({
      type: 'expense', amount: 1_000, occurredAt: 1, categoryId: expenseOne, accountId: cash,
    });
    const second = await addEntry({
      type: 'expense', amount: 2_000, occurredAt: 2, categoryId: expenseOne, accountId: cash,
    });
    const originalBulkPut = db.entries.bulkPut.bind(db.entries);
    vi.spyOn(db.entries, 'bulkPut').mockImplementation((async (entries: readonly Entry[]) => {
      await originalBulkPut([entries[0]!]);
      throw new Error('虚构批量分类写入失败');
    }) as typeof db.entries.bulkPut);
    const events: string[] = [];
    stops.push(on('entries-changed', () => events.push('entries-changed')));

    await expect(applyBatchEntries([first, second], { kind: 'category', categoryId: expenseTwo }))
      .rejects.toThrow('虚构批量分类写入失败');

    expect((await db.entries.get(first))?.categoryId).toBe(expenseOne);
    expect((await db.entries.get(second))?.categoryId).toBe(expenseOne);
    expect(events).toEqual([]);
  });

  it('批量删除在一个事务中软删除可处理账单，已删除和不存在项给出跳过原因', async () => {
    const active = await addEntry({
      type: 'income', amount: 800, occurredAt: 1, categoryId: incomeTwo, accountId: cash,
    });
    const deleted = await addEntry({
      type: 'expense', amount: 300, occurredAt: 2, categoryId: expenseOne, accountId: cash,
    });
    await softDeleteEntry(deleted);

    const result = await applyBatchEntries([active, deleted, 999_999], { kind: 'delete' });

    expect(result.appliedIds).toEqual([active]);
    expect(result.skipped).toEqual([
      expect.objectContaining({ entryId: deleted, code: 'already-deleted' }),
      expect.objectContaining({ entryId: 999_999, code: 'missing-entry' }),
    ]);
    expect((await db.entries.get(active))?.deletedAt).not.toBe(0);
    expect((await db.accounts.get(cash))?.balance).toBe(10_000);
  });

  it('批量增减标签覆盖全部账单类型，保留原标签并对无变化项说明跳过原因', async () => {
    const ids = await seedMixedEntries();
    const originalTag = await ensureTag('虚构原标签');
    const batchTag = await ensureTag('虚构批量标签');
    await db.entryTags.bulkAdd([
      { entryId: ids.expenseId, tagId: originalTag },
      { entryId: ids.expenseId, tagId: batchTag },
    ]);

    const addPreview = await previewBatchEntries(Object.values(ids), {
      kind: 'tags', mode: 'add', tagIds: [batchTag],
    });
    expect(addPreview.processableIds).toEqual([ids.incomeId, ids.transferId, ids.loanId]);
    expect(addPreview.skipped).toEqual([
      expect.objectContaining({ entryId: ids.expenseId, code: 'tags-unchanged', reason: '账单已包含所选标签' }),
    ]);

    await applyBatchEntries(Object.values(ids), { kind: 'tags', mode: 'add', tagIds: [batchTag] });
    expect(new Set(await getEntryTagIds(ids.expenseId))).toEqual(new Set([originalTag, batchTag]));
    expect(await getEntryTagIds(ids.transferId)).toEqual([batchTag]);
    expect(await getEntryTagIds(ids.loanId)).toEqual([batchTag]);

    const removeResult = await applyBatchEntries(Object.values(ids), {
      kind: 'tags', mode: 'remove', tagIds: [originalTag],
    });
    expect(removeResult.appliedIds).toEqual([ids.expenseId]);
    expect(removeResult.skipped).toHaveLength(3);
    expect(removeResult.skipped.every((item) => item.code === 'tags-unchanged')).toBe(true);
    expect(await getEntryTagIds(ids.expenseId)).toEqual([batchTag]);
  });

  it('分类和账户已是目标值时预检跳过，避免无意义余额回滚重放', async () => {
    const expenseId = await addEntry({
      type: 'expense', amount: 1_000, occurredAt: 1, categoryId: expenseOne, accountId: cash,
    });

    await expect(previewBatchEntries([expenseId], { kind: 'category', categoryId: expenseOne }))
      .resolves.toEqual(expect.objectContaining({
        processableIds: [],
        skipped: [expect.objectContaining({ code: 'already-target-category', reason: '账单已属于目标分类' })],
      }));
    await expect(previewBatchEntries([expenseId], { kind: 'account', accountId: cash }))
      .resolves.toEqual(expect.objectContaining({
        processableIds: [],
        skipped: [expect.objectContaining({ code: 'already-target-account', reason: '账单已使用目标账户' })],
      }));
  });
});
