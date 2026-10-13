/**
 * 拾光 · 账户仓库（accountRepo）
 * 账户 CRUD、隐藏、对账与净资产计算。
 * 硬规则：账户余额由账单驱动增减（见 entryRepo），对账生成「余额调整记录」而非直接改数。
 * 写操作成功后 emit 'accounts-changed'。
 */
import { db, now, stamp } from '../db';
import { ACCOUNT_GROUPS, type Account, type AccountGroup } from '../types';
import { addEntry } from './entryRepo';
import { emitAfterCommit as emit } from './transactionEvents';

/** 新建账户输入 */
export type NewAccount = Omit<Account, 'id' | 'createdAt' | 'updatedAt' | 'hidden' | 'countInNetWorth' | 'sortOrder'> &
  Partial<Pick<Account, 'hidden' | 'countInNetWorth' | 'sortOrder'>>;

/**
 * 新增账户。
 * @param input name/group/balance（初始余额，分）必填
 * @returns 新账户 id
 */
export async function addAccount(input: NewAccount): Promise<number> {
  if (!Number.isSafeInteger(input.balance)) throw new Error('账户余额必须为整数分');
  validateCreditFields(input.group, input.billingDay, input.repayDay, input.creditLimit);
  const sameGroup = await db.accounts.where('group').equals(input.group).toArray();
  const maxSort = sameGroup.reduce((max, account) => Math.max(max, account.sortOrder), 0);
  const id = await db.accounts.add(
    stamp({
      hidden: false, countInNetWorth: true, creditReminderEnabled: true,
      sortOrder: maxSort + 1, ...input,
    }) as Account,
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
  const current = await db.accounts.get(id);
  if (!current) throw new Error(`账户不存在：${id}`);
  validateCreditFields(
    patch.group ?? current.group,
    patch.billingDay ?? current.billingDay,
    patch.repayDay ?? current.repayDay,
    patch.creditLimit ?? current.creditLimit,
  );
  await db.accounts.update(id, { ...patch, updatedAt: now() });
  emit('accounts-changed', { id });
}

/**
 * 删除账户。要求先处理关联账单（存在未删除关联账单时抛错），不进回收站。
 */
export async function deleteAccount(id: number): Promise<void> {
  await db.transaction('rw', [db.accounts, db.entries, db.recurringRules, db.creditStatements, db.quickTemplates], async () => {
    const account = await db.accounts.get(id);
    if (!account) return;
    if (account.balance !== 0) throw new Error('仅余额为 0 的空账户可以删除');
    const historicalEntries = await db.entries
      .filter((entry) => entry.accountId === id || entry.fromAccountId === id || entry.toAccountId === id || entry.reimburseAccountId === id)
      .count();
    if (historicalEntries > 0) throw new Error(`该账户仍有 ${historicalEntries} 笔历史业务引用，不能删除`);
    const recurring = await db.recurringRules.where('accountId').equals(id).count();
    if (recurring > 0) throw new Error(`该账户仍被 ${recurring} 条周期账引用，不能删除`);
    const templates = await db.quickTemplates.filter(template => template.accountId === id).count();
    if (templates > 0) throw new Error(`该账户仍被 ${templates} 个速记模板引用，请先修改模板账户`);
    const statements = await db.creditStatements.where('accountId').equals(id).count();
    if (statements > 0) throw new Error(`该账户仍有 ${statements} 期信用卡账单，不能删除`);
    await db.accounts.delete(id);
  });
  emit('accounts-changed', { id });
}

/** 隐藏 / 恢复显示账户 */
export async function setAccountHidden(id: number, hidden: boolean): Promise<void> {
  await db.accounts.update(id, { hidden, updatedAt: now() });
  emit('accounts-changed', { id });
}

/** 单独设置净资产统计口径，不改变账户显示状态。 */
export async function setAccountCountInNetWorth(id: number, countInNetWorth: boolean): Promise<void> {
  await db.accounts.update(id, { countInNetWorth, updatedAt: now() });
  emit('accounts-changed', { id });
}

/** 账户只在所属分组内上移或下移；其他分组的 sortOrder 不参与交换。 */
export async function reorderAccountWithinGroup(id: number, direction: 'up' | 'down'): Promise<void> {
  await db.transaction('rw', db.accounts, async () => {
    const account = await db.accounts.get(id);
    if (!account) throw new Error(`账户不存在：${id}`);
    const rows = (await db.accounts.where('group').equals(account.group).toArray())
      .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
    const index = rows.findIndex(row => row.id === id);
    const swapIndex = index + (direction === 'up' ? -1 : 1);
    if (index < 0 || swapIndex < 0 || swapIndex >= rows.length) return;
    const slots = rows.map(row => row.sortOrder).sort((a, b) => a - b);
    [rows[index], rows[swapIndex]] = [rows[swapIndex], rows[index]];
    const changedAt = now();
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].sortOrder !== slots[i]) await db.accounts.update(rows[i].id, { sortOrder: slots[i], updatedAt: changedAt });
    }
  });
  emit('accounts-changed', { id });
}

function validateCreditFields(
  group: AccountGroup,
  billingDay?: number,
  repayDay?: number,
  creditLimit?: number,
): void {
  for (const [label, value] of [['账单日', billingDay], ['还款日', repayDay]] as const) {
    if (value != null && (!Number.isInteger(value) || value < 1 || value > 31)) throw new Error(`${label}须为 1-31 的整数`);
  }
  if (creditLimit != null && (!Number.isSafeInteger(creditLimit) || creditLimit <= 0)) {
    throw new Error('信用额度须为大于 0 的整数分');
  }
  if (group !== 'credit' && (billingDay != null || repayDay != null || creditLimit != null)) {
    throw new Error('仅信用卡账户可设置信用额度、账单日和还款日');
  }
}

export interface CreditLimitStatus {
  limit: number;
  remaining: number;
  overLimit: number;
}

/** 信用卡可用额度：信用额度 + 当前余额（信用卡欠款余额为负）。 */
export function creditLimitStatus(account: Account): CreditLimitStatus | undefined {
  if (account.group !== 'credit' || account.creditLimit == null
    || !Number.isSafeInteger(account.creditLimit) || account.creditLimit <= 0) return undefined;
  const available = account.creditLimit + account.balance;
  if (!Number.isSafeInteger(available)) return undefined;
  return {
    limit: account.creditLimit,
    remaining: Math.max(0, available),
    overLimit: Math.max(0, -available),
  };
}

/**
 * 对账：把账户余额调整到 targetBalance。
 * 差额增加生成收入，差额减少生成支出；由账单联动余额并计入收支，而非直接改数。
 * @param id 账户 id
 * @param targetBalance 对账后的余额（分）
 * @returns 生成的调整账单 id；余额无差异时返回 undefined
 */
export async function reconcileAccount(id: number, targetBalance: number): Promise<number | undefined> {
  const preview = await previewReconcileAccount(id, targetBalance);
  if (preview.difference === 0) return undefined;
  return addEntry({
    type: preview.difference > 0 ? 'income' : 'expense',
    amount: Math.abs(preview.difference),
    occurredAt: now(),
    accountId: id,
    note: '余额对账调整',
    reconcileBeforeBalance: preview.currentBalance,
    reconcileTargetBalance: preview.targetBalance,
  });
}

export interface ReconcilePreview {
  accountId: number;
  currentBalance: number;
  targetBalance: number;
  difference: number;
}

/** 对账写入前的稳定预览；确认时 reconcileAccount 会重新读取余额，避免陈旧差额。 */
export async function previewReconcileAccount(id: number, targetBalance: number): Promise<ReconcilePreview> {
  if (!Number.isSafeInteger(targetBalance)) throw new Error('实际余额必须为整数分');
  const account = await db.accounts.get(id);
  if (!account) throw new Error(`账户不存在：${id}`);
  const difference = targetBalance - account.balance;
  if (!Number.isSafeInteger(difference)) throw new Error('对账差额超出安全范围');
  return { accountId: id, currentBalance: account.balance, targetBalance, difference };
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
  const rows = await db.accounts.toArray();
  return rows.filter(account => account.countInNetWorth !== false);
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
