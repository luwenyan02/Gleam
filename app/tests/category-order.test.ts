import 'fake-indexeddb/auto';
import { beforeEach, expect, it, vi } from 'vitest';
import { db } from '../src/core/db';
import { addCategory, reorderCategories } from '../src/core/repo/categoryRepo';

beforeEach(async () => { await db.delete(); await db.open(); });
it('分类排序一次写入整组，失败全部回滚', async () => {
  const ids = await Promise.all(['甲', '乙', '丙'].map((name, i) => addCategory({ name, kind: 'income', icon: 'ic-coin', sortOrder: i + 1 })));
  const original = await db.categories.toArray();
  const update = db.categories.update.bind(db.categories);
  const spy = vi.spyOn(db.categories, 'update').mockImplementation(async (...args: Parameters<typeof update>) => {
    if (args[0] === ids[1]) throw new Error('虚构写入失败');
    return update(...args);
  });
  await expect(reorderCategories([...ids].reverse())).rejects.toThrow('虚构');
  spy.mockRestore();
  expect(await db.categories.toArray()).toEqual(original);
  await reorderCategories([...ids].reverse());
  expect((await db.categories.orderBy('sortOrder').toArray()).map(c => c.id)).toEqual([...ids].reverse());
});
