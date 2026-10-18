import 'fake-indexeddb/auto';
import { beforeEach, expect, it } from 'vitest';
import { db } from '../src/core/db';
import { categoryIcon } from '../src/core/categoryIcons';
import { addCategory, getCategory, updateCategory } from '../src/core/repo/categoryRepo';

beforeEach(async () => { await db.delete(); await db.open(); });

it('主动选通用图标后改名仍保留，未手选的历史分类继续推断', async () => {
  const id = await addCategory({ name: '饮料水果', kind: 'expense', icon: 'ic-tag' });
  expect(categoryIcon((await getCategory(id))!)).toBe('ic-fruit');
  await updateCategory(id, { icon: 'ic-tag', iconOverride: true });
  await updateCategory(id, { name: '水果' });
  const updated = (await getCategory(id))!;
  expect(updated).toMatchObject({ icon: 'ic-tag', iconOverride: true, name: '水果' });
  expect(categoryIcon(updated)).toBe('ic-tag');
  const legacyId = await addCategory({ name: '工资薪水', kind: 'income', icon: 'ic-coin' });
  expect((await getCategory(legacyId))!.iconOverride).toBeUndefined();
  expect(categoryIcon((await getCategory(legacyId))!)).toBe('ic-brief');
});
