import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/core/db';
import { on } from '../src/core/store';
import { addAccount } from '../src/core/repo/accountRepo';
import { addCategory } from '../src/core/repo/categoryRepo';
import { ensureTag } from '../src/core/repo/tagRepo';
import { setSetting } from '../src/core/repo/settingsRepo';

const stops: (() => void)[] = [];

beforeEach(async () => {
  await db.delete();
  await db.open();
});

afterEach(() => {
  stops.splice(0).forEach((stop) => stop());
});

describe('导入嵌套事务事件', () => {
  it('外层事务回滚时不广播账户、分类、标签或设置的成功事件', async () => {
    const events: string[] = [];
    for (const name of ['accounts-changed', 'categories-changed', 'entries-changed', 'settings-changed'] as const) {
      stops.push(on(name, () => events.push(name)));
    }

    await expect(db.transaction('rw', [db.accounts, db.categories, db.tags, db.settings], async () => {
      await addAccount({ name: '虚构回滚账户', group: 'cash', balance: 0 });
      await addCategory({ name: '虚构回滚分类', icon: 'ic-tag', kind: 'income' });
      await ensureTag('虚构回滚标签');
      await setSetting('ai.pendingItems', []);
      throw new Error('虚构导入故障');
    })).rejects.toThrow('虚构导入故障');

    expect(events).toEqual([]);
    expect(await db.accounts.count()).toBe(0);
    expect(await db.categories.count()).toBe(0);
    expect(await db.tags.count()).toBe(0);
    expect(await db.settings.count()).toBe(0);
  });
});
