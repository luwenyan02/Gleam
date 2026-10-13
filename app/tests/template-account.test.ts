import 'fake-indexeddb/auto';
import { beforeEach, expect, it } from 'vitest';
import { db } from '../src/core/db';
import { addAccount, deleteAccount } from '../src/core/repo/accountRepo';
import { addTemplate, listTemplates, updateTemplate } from '../src/core/repo/templateRepo';
import { exportAll, restoreAll } from '../src/core/repo/backupRepo';

beforeEach(async () => { await db.delete(); await db.open(); });
const template = { name: '虚构午餐', amount: 2800, categoryId: 1 };

it('模板账户预设和旧版无账户模板均可备份恢复、编辑与清除预设', async () => {
  const accountId = await addAccount({ name: '虚构银行卡', group: 'debit', balance: 0 });
  const old = await addTemplate(template);
  const current = await addTemplate({ ...template, accountId });
  const dump = await exportAll();
  await restoreAll(dump);
  expect(await db.quickTemplates.get(old)).not.toHaveProperty('accountId');
  expect(await db.quickTemplates.get(current)).toMatchObject({ accountId, amount: 2800 });
  await updateTemplate(old, { accountId });
  expect(await db.quickTemplates.get(old)).toMatchObject({ accountId });
  await updateTemplate(current, { accountId: undefined });
  expect((await db.quickTemplates.get(current))?.accountId).toBeUndefined();
});

it('无效账户或应收应付账户不能作为支出模板账户，拒绝操作不改模板', async () => {
  const accountId = await addAccount({ name: '虚构现金', group: 'cash', balance: 0 });
  const loan = await addAccount({ name: '虚构应收', group: 'receivable', balance: 0 });
  const id = await addTemplate({ ...template, accountId });
  const before = await listTemplates();
  await expect(addTemplate({ ...template, accountId: 99999 })).rejects.toThrow('账户');
  await expect(updateTemplate(id, { accountId: loan })).rejects.toThrow('账户');
  expect(await listTemplates()).toEqual(before);
});

it('账户仍被模板引用时不能删除，清除模板预设后可删除空账户', async () => {
  const accountId = await addAccount({ name: '虚构空账户', group: 'cash', balance: 0 });
  const id = await addTemplate({ ...template, accountId });
  await expect(deleteAccount(accountId)).rejects.toThrow('模板');
  expect(await db.accounts.get(accountId)).toBeDefined();
  await updateTemplate(id, { accountId: undefined });
  await deleteAccount(accountId);
  expect(await db.accounts.get(accountId)).toBeUndefined();
});
