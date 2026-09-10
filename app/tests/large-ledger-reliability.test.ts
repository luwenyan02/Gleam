import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/core/db';
import type { Entry } from '../src/core/types';
import { summarizeLedgerEntries } from '../src/core/ledgerQuery';
import { addAccount } from '../src/core/repo/accountRepo';
import { previewBatchEntries } from '../src/core/repo/batchEntryRepo';
import { addCategory } from '../src/core/repo/categoryRepo';
import { ledgerEntriesInRange } from '../src/core/repo/statsRepo';

const RECORD_COUNT = 10_000;
const RANGE_START = new Date(2026, 0, 1).getTime();

let accountId: number;
let sourceCategoryId: number;
let targetCategoryId: number;

beforeEach(async () => {
  await db.delete();
  await db.open();
  accountId = await addAccount({ name: '虚构可靠性账户', group: 'cash', balance: 0 });
  sourceCategoryId = await addCategory({ name: '虚构原分类', icon: 'ic-bowl', kind: 'expense' });
  targetCategoryId = await addCategory({ name: '虚构目标分类', icon: 'ic-bus', kind: 'expense' });

  const createdAt = Date.now();
  const rows: Entry[] = Array.from({ length: RECORD_COUNT }, (_, index) => ({
    id: index + 1,
    type: 'expense',
    amount: (index % 100 + 1) * 100,
    occurredAt: RANGE_START + index * 60_000,
    categoryId: sourceCategoryId,
    accountId,
    note: `虚构批量账单 ${index + 1}`,
    reimburseStatus: 'none',
    deletedAt: 0,
    createdAt,
    updatedAt: createdAt,
  }));
  await db.entries.bulkAdd(rows);
});

afterEach(async () => {
  await db.delete();
});

describe('一万笔虚构账单可靠性', () => {
  it('统一查询和汇总返回完整精确结果，且不会长时间阻塞', async () => {
    const startedAt = performance.now();
    const items = await ledgerEntriesInRange(RANGE_START, RANGE_START + RECORD_COUNT * 60_000, false);
    const summary = summarizeLedgerEntries(items, { reimburseMode: 'offset' });
    const elapsed = performance.now() - startedAt;

    expect(items).toHaveLength(RECORD_COUNT);
    expect(summary.expenseCount).toBe(RECORD_COUNT);
    expect(summary.expense).toBe(50_500_000);
    expect(summary.income).toBe(0);
    expect(elapsed).toBeLessThan(5_000);
  }, 15_000);

  it('批量预检覆盖全部查询结果，而不是只处理首屏', async () => {
    const ids = Array.from({ length: RECORD_COUNT }, (_, index) => index + 1);
    const startedAt = performance.now();
    const preview = await previewBatchEntries(ids, { kind: 'category', categoryId: targetCategoryId });
    const elapsed = performance.now() - startedAt;

    expect(preview.processableIds).toHaveLength(RECORD_COUNT);
    expect(preview.skipped).toEqual([]);
    expect(preview.processableIds[0]).toBe(1);
    expect(preview.processableIds.at(-1)).toBe(RECORD_COUNT);
    expect(elapsed).toBeLessThan(5_000);
  }, 15_000);
});
