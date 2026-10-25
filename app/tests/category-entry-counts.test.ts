import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../src/core/db';
import type { Entry } from '../src/core/types';
import { countCategoryEntries, moveCategory } from '../src/core/repo/categoryRepo';
import { addEntry, restoreEntry, softDeleteEntry, updateEntry } from '../src/core/repo/entryRepo';
import { mergeCategories } from '../src/core/repo/categoryMergeRepo';

const row = (id: number, patch: Partial<Entry> = {}): Entry => ({ id, type: 'expense', categoryId: 3, accountId: 1, amount: 100, occurredAt: 1, deletedAt: 0, reimburseStatus: 'none', createdAt: 1, updatedAt: 1, ...patch });
beforeEach(async () => {
  await db.delete(); await db.open();
  await db.categories.bulkPut([
    { id: 1, name: '交通', kind: 'expense' }, { id: 2, name: '餐饮', kind: 'expense' },
    { id: 3, name: '公交', kind: 'expense', parentId: 1 }, { id: 4, name: '停车', kind: 'expense', parentId: 1 },
    { id: 5, name: '工资', kind: 'income' }, { id: 6, name: '未使用', kind: 'expense' },
  ].map((category, sortOrder) => ({ ...category, kind: category.kind as 'expense' | 'income', icon: 'ic-tag', sortOrder, createdAt: 1, updatedAt: 1 })));
  await db.accounts.add({ id: 1, name: '虚构现金', group: 'cash', balance: 100000, hidden: false, sortOrder: 1, createdAt: 1, updatedAt: 1 });
});

describe('分类管理账单笔数', () => {
  it('统计全部时间的未删除收支，退款及零金额各计一笔，大类包含自身与小类且只读', async () => {
    await db.entries.bulkPut([
      row(1, { categoryId: 1 }), row(2), row(3, { refundFlag: true }),
      row(4, { categoryId: 4, amount: -10 }), row(5, { categoryId: 4, amount: 0 }),
      row(6, { deletedAt: 2 }), row(7, { categoryId: 5, type: 'income', occurredAt: new Date(2000, 0, 1).getTime() }),
      row(8, { categoryId: 5, type: 'income', occurredAt: new Date(2060, 0, 1).getTime() }),
      row(9, { type: 'transfer' }), row(10, { type: 'loan', loanKind: 'collect' }),
      row(11, { categoryId: undefined }), row(12, { categoryId: 9999 }), row(13, { categoryId: 5 }),
    ]);
    const before = await Promise.all([db.entries.toArray(), db.accounts.toArray(), db.categories.toArray()]);
    expect(await countCategoryEntries()).toEqual(new Map([[1, 5], [2, 0], [3, 2], [4, 2], [5, 2], [6, 0]]));
    expect(await Promise.all([db.entries.toArray(), db.accounts.toArray(), db.categories.toArray()])).toEqual(before);
  });
  it('改分类、删除和恢复后重新统计，不重复计算报销到账', async () => {
    const id = await addEntry({ type: 'expense', amount: 100, occurredAt: 1, categoryId: 3, accountId: 1, reimburseStatus: 'done', reimbursedAmount: 50, reimburseAccountId: 1, reimbursedAt: 2 });
    expect((await countCategoryEntries()).get(3)).toBe(1);
    await updateEntry(id, { categoryId: 4 });
    expect(await countCategoryEntries()).toEqual(new Map([[1, 1], [2, 0], [3, 0], [4, 1], [5, 0], [6, 0]]));
    await softDeleteEntry(id);
    expect((await countCategoryEntries()).get(1)).toBe(0);
    await restoreEntry(id);
    expect((await countCategoryEntries()).get(1)).toBe(1);
  });
  it('移动小类或升为大类时，合计跟随新层级且不重复计算', async () => {
    await db.entries.bulkPut([row(1, { categoryId: 1 }), row(2)]);
    await moveCategory(3, 2);
    let counts = await countCategoryEntries();
    expect([counts.get(1), counts.get(2), counts.get(3)]).toEqual([1, 1, 1]);
    await moveCategory(3, undefined);
    counts = await countCategoryEntries();
    expect([counts.get(1), counts.get(2), counts.get(3)]).toEqual([1, 0, 1]);
  });
  it('合并后原分类消失，目标分类相加，回收站记录继续排除', async () => {
    await db.entries.bulkPut([row(1), row(2, { categoryId: 4 }), row(3, { deletedAt: 2 })]);
    await mergeCategories(3, 4);
    const counts = await countCategoryEntries();
    expect(counts.has(3)).toBe(false);
    expect([counts.get(1), counts.get(4)]).toEqual([2, 2]);
  });
});

it('只读取分类索引的主键，不载入账单正文；不同类型与删除状态仍按原口径排除', async () => {
  await db.entries.bulkPut([row(1), row(2, { type: 'income' }), row(3, { deletedAt: 1 })]);
  const read = vi.spyOn(IDBObjectStore.prototype, 'getAll');
  const cursor = vi.spyOn(IDBIndex.prototype, 'openCursor');
  const indexRead = vi.spyOn(IDBIndex.prototype, 'getAll');
  try {
    expect((await countCategoryEntries()).get(3)).toBe(1);
    expect(read.mock.contexts.filter(store => store.name === 'entries')).toHaveLength(0);
    expect(indexRead.mock.contexts.filter(index => index.objectStore.name === 'entries')).toHaveLength(0);
    expect(cursor.mock.contexts.filter(index => index.objectStore.name === 'entries')).toHaveLength(0);
  } finally { read.mockRestore(); cursor.mockRestore(); indexRead.mockRestore(); }
});
