/**
 * 拾光 · 账户仓库（accountRepo）
 * 账户 CRUD、隐藏、对账与净资产计算。
 * 硬规则：账户余额由账单驱动增减（见 entryRepo），对账生成「余额调整记录」而非直接改数。
 * 写操作成功后 emit 'accounts-changed'。
 */
import { db, now, stamp } from '../db';
import { emit } from '../store';
import { ACCOUNT_GROUPS, type Account, type AccountGroup } from '../types';
import { addEntry } from './entryRepo';
import { getSetting } from './settingsRepo';

/** 新建账户输入 */
export type NewAccount = Omit<Account, 'id' | 'createdAt' | 'updatedAt' | 'hidden' | 'countInNetWorth' | 'sortOrder'> &
  Partial<Pick<Account, 'hidden' | 'countInNetWorth' | 'sortOrder'>>;

/**
 * 新增账户。
 * @param input name/group/balance（初始余额，分）必填
 * @returns 新账户 id
 */
export async function addAccount(input: NewAccount): Promise<number> {
  const maxSort = (await db.accounts.orderBy('sortOrder').last())?.sortOrder ?? 0;
  const id = await db.accounts.add(
    stamp({ hidden: false, countInNetWorth: true, sortOrder: maxSort + 1, ...input }) as Account,
  );
  emit('accounts-changed', { id });
  return id;
}

/**
 * 更新账户基本信息（名称/备注/还款日/排序等）。
 * 注意：不允许经此改 balance——余额只能由账单或对账驱动。
 */
export async function updateAccount(
  id: number,
  patch: Partial<Omit<Account, 'id' | 'balance' | 'createdAt' | 'updatedAt'>>,
): Promise<void> {
  await db.accounts.update(id, { ...patch, updatedAt: now() });
  emit('accounts-changed', { id });
}

/**
 * 删除账户。要求先处理关联账单（存在未删除关联账单时抛错），不进回收站。
 */
export async function deleteAccount(id: number): Promise<void> {
  const used = await db.entries
    .filter((e) => e.deletedAt === 0 && (e.accountId === id || e.fromAccountId === id || e.toAccountId === id || e.reimburseAccountId === id))
    .count();
  if (used > 0) throw new Error(`该账户仍有 ${used} 笔关联账单，请先转移或删除`);
  await db.accounts.delete(id);
  emit('accounts-changed', { id });
}

/** 隐藏 / 恢复显示账户 */
export async function setAccountHidden(id: number, hidden: boolean): Promise<void> {
  await db.accounts.update(id, { hidden, updatedAt: now() });
  emit('accounts-changed', { id });
}

/**
 * 对账：把账户余额调整到 targetBalance。
 * 生成一条「余额对账调整」转账账单（单边，不计收支），由账单联动余额，而非直接改数。
 * @param id 账户 id
 * @param targetBalance 对账后的余额（分）
 * @returns 生成的调整账单 id；余额无差异时返回 undefined
 */
export async function reconcileAccount(id: number, targetBalance: number): Promise<number | undefined> {
  const acct = await db.accounts.get(id);
  if (!acct) throw new Error(`账户不存在：${id}`);
  const diff = targetBalance - acct.balance;
  if (diff === 0) return undefined;
  return addEntry({
    type: 'transfer',
    amount: Math.abs(diff),
    occurredAt: now(),
    fromAccountId: diff < 0 ? id : undefined,
    toAccountId: diff > 0 ? id : undefined,
    note: '余额对账调整',
  });
}

/** 单个账户 */
export async function getAccount(id: number): Promise<Account | undefined> {
  return db.accounts.get(id);
}

/**
 * 账户列表，按 sortOrder 排序。
 * @param includeHidden 是否包含隐藏账户（默认包含，UI 自行分区）
 */
export async function listAccounts(includeHidden = true): Promise<Account[]> {
  const rows = await db.accounts.orderBy('sortOrder').toArray();
  return includeHidden ? rows : rows.filter((a) => !a.hidden);
}

/** 按分组返回账户（保持组内 sortOrder），供账户页分组渲染 */
export async function listAccountsByGroup(): Promise<Record<AccountGroup, Account[]>> {
  const rows = await listAccounts();
  const grouped = {} as Record<AccountGroup, Account[]>;
  for (const group of ACCOUNT_GROUPS) grouped[group] = [];
  for (const a of rows) grouped[a.group].push(a);
  return grouped;
}

/**
 * 净资产计算：总资产（正余额和）、总负债（负余额和，返回正数）、净资产。
 * 隐藏账户按「设置 + 账户级 countInNetWorth」双重口径过滤：
 * 设置关闭时，隐藏且 countInNetWorth=false 的账户不计入。
 */
export async function listNetWorthAccounts(): Promise<Account[]> {
  const includeHidden = await getSetting('netWorth.includeHidden');
  const rows = await db.accounts.toArray();
  return rows.filter(account => !(account.hidden && !includeHidden && !account.countInNetWorth));
}

export async function getNetWorth(): Promise<{ assets: number; debts: number; net: number }> {
  const rows = await listNetWorthAccounts();
  let assets = 0;
  let debts = 0;
  for (const a of rows) {
    if (a.balance >= 0) assets += a.balance;
    else debts += -a.balance;
  }
  return { assets, debts, net: assets - debts };
}
