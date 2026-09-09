/**
 * 拾光 · 信用卡账单仓库（creditRepo）
 * 每期账单（用户按银行账单核对的应还额）与真实转账流水的还款关联。
 * 硬规则：资金变化只由 entryRepo 的转账流水驱动；本仓库只维护账单与流水的
 * 分配关系，已还/剩余一律从当前有效流水动态派生（删除、恢复、改额自动重算）。
 */
import { db, now, stamp } from '../db';
import type { CreditPayment, CreditStatement } from '../types';
import { addEntry } from './entryRepo';
import { emitAfterCommit as emit } from './transactionEvents';

export type NewCreditStatement = Omit<CreditStatement, 'id' | 'createdAt' | 'updatedAt'>;

export interface CreditStatementSummary {
  statement: CreditStatement;
  amountDue: number;
  /** 当前有效流水派生的已还（分） */
  paid: number;
  remaining: number;
  /** 账户总欠款（分，取账户余额负值） */
  totalDebt: number;
  payments: Array<CreditPayment & { entryAmount: number; effectiveAmount: number; entryDeleted: boolean }>;
}

function assertFen(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label}必须是非负整数分`);
}

function overlaps(a: { periodStart: number; periodEnd: number }, b: { periodStart: number; periodEnd: number }): boolean {
  return a.periodStart <= b.periodEnd && b.periodStart <= a.periodEnd;
}

/** 新增一期账单；同账户区间重叠拒绝。 */
export async function addCreditStatement(input: NewCreditStatement): Promise<number> {
  assertFen(input.amountDue, '本期应还');
  if (input.periodEnd < input.periodStart) throw new Error('账单区间结束不能早于开始');
  const clash = await db.creditStatements.where('accountId').equals(input.accountId).toArray();
  if (clash.some((row) => overlaps(row, input))) throw new Error('账单区间与已有账单重叠');
  const id = await db.creditStatements.add(stamp({ ...input }) as CreditStatement);
  emit('credit-changed', { statementId: id });
  return id;
}

/** 修改账单字段；区间重叠检查排除自身。 */
export async function updateCreditStatement(id: number, patch: Partial<NewCreditStatement>): Promise<void> {
  const current = await db.creditStatements.get(id);
  if (!current) throw new Error('账单不存在');
  const merged = { ...current, ...patch };
  if (merged.amountDue !== current.amountDue) assertFen(merged.amountDue, '本期应还');
  if (merged.periodEnd < merged.periodStart) throw new Error('账单区间结束不能早于开始');
  const clash = await db.creditStatements.where('accountId').equals(merged.accountId).toArray();
  if (clash.some((row) => row.id !== id && overlaps(row, merged))) throw new Error('账单区间与已有账单重叠');
  await db.creditStatements.update(id, { ...merged, updatedAt: now() });
  emit('credit-changed', { statementId: id });
}

/** 删除账单及其还款关联；转账流水保留。 */
export async function deleteCreditStatement(id: number): Promise<void> {
  await db.transaction('rw', [db.creditStatements, db.creditPayments], async () => {
    await db.creditPayments.where('statementId').equals(id).delete();
    await db.creditStatements.delete(id);
  });
  emit('credit-changed', { statementId: id });
}

async function effectivePayments(statementId: number): Promise<CreditStatementSummary['payments']> {
  const payments = await db.creditPayments.where('statementId').equals(statementId).toArray();
  const entries = await db.entries.bulkGet(payments.map((p) => p.entryId));
  return payments.map((payment, i) => {
    const entry = entries[i];
    const entryDeleted = !entry || entry.deletedAt !== 0;
    const entryAmount = entry?.amount ?? 0;
    return { ...payment, entryAmount, entryDeleted, effectiveAmount: entryDeleted ? 0 : Math.min(payment.allocatedAmount, entryAmount) };
  });
}

/** 单期账单汇总：应还、已还、剩余与账户总欠款。 */
export async function getCreditStatementSummary(statementId: number): Promise<CreditStatementSummary | undefined> {
  const statement = await db.creditStatements.get(statementId);
  if (!statement) return undefined;
  const payments = await effectivePayments(statementId);
  const paid = payments.reduce((sum, p) => sum + p.effectiveAmount, 0);
  const account = await db.accounts.get(statement.accountId);
  return {
    statement,
    amountDue: statement.amountDue,
    paid,
    remaining: Math.max(0, statement.amountDue - paid),
    totalDebt: account ? Math.max(0, -account.balance) : 0,
    payments,
  };
}

/** 某卡全部账单汇总，按周期开始倒序。 */
export async function listCreditStatementSummaries(accountId: number): Promise<CreditStatementSummary[]> {
  const statements = await db.creditStatements.where('accountId').equals(accountId).toArray();
  statements.sort((a, b) => b.periodStart - a.periodStart);
  const account = await db.accounts.get(accountId);
  const totalDebt = account ? Math.max(0, -account.balance) : 0;
  const out: CreditStatementSummary[] = [];
  for (const statement of statements) {
    const payments = await effectivePayments(statement.id!);
    const paid = payments.reduce((sum, p) => sum + p.effectiveAmount, 0);
    out.push({ statement, amountDue: statement.amountDue, paid, remaining: Math.max(0, statement.amountDue - paid), totalDebt, payments });
  }
  return out;
}

/** 把一笔已有转账关联为某期还款；同一流水只允许关联一次。 */
export async function linkExistingCreditPayment(input: { statementId: number; entryId: number; allocatedAmount: number }): Promise<CreditPayment> {
  return db.transaction('rw', [db.creditStatements, db.creditPayments, db.entries, db.accounts], async () => {
    const statement = await db.creditStatements.get(input.statementId);
    if (!statement) throw new Error('账单不存在');
    if (await db.creditPayments.where('entryId').equals(input.entryId).count()) throw new Error('该流水已关联账单');
    const entry = await db.entries.get(input.entryId);
    if (!entry || entry.deletedAt !== 0) throw new Error('流水不存在或已删除');
    if (entry.type !== 'transfer' || entry.toAccountId !== statement.accountId) throw new Error('仅转入该信用卡的转账可关联为还款');
    assertFen(input.allocatedAmount, '关联金额');
    if (input.allocatedAmount > entry.amount) throw new Error('关联金额超出流水金额');
    const paid = (await effectivePayments(statement.id!)).reduce((sum, p) => sum + p.effectiveAmount, 0);
    const remaining = Math.max(0, statement.amountDue - paid);
    if (input.allocatedAmount > remaining) throw new Error('关联金额超出本期剩余应还');
    const id = await db.creditPayments.add(stamp({ statementId: statement.id!, entryId: input.entryId, allocatedAmount: input.allocatedAmount }) as CreditPayment);
    emit('credit-changed', { statementId: statement.id! });
    return (await db.creditPayments.get(id))!;
  });
}

/** 新建一笔转入信用卡的转账并关联为本期还款；超出剩余部分保留为未分配。 */
export async function createAndLinkCreditPayment(input: {
  statementId: number; fromAccountId: number; amount: number; occurredAt: number; note?: string;
}): Promise<CreditPayment & { entryId: number; unallocatedAmount: number }> {
  assertFen(input.amount, '还款金额');
  return db.transaction('rw', [db.creditStatements, db.creditPayments, db.entries, db.accounts, db.entryTags], async () => {
    const statement = await db.creditStatements.get(input.statementId);
    if (!statement) throw new Error('账单不存在');
    const paid = (await effectivePayments(statement.id!)).reduce((sum, p) => sum + p.effectiveAmount, 0);
    const remaining = Math.max(0, statement.amountDue - paid);
    const allocated = Math.min(input.amount, remaining);
    const entryId = await addEntry({
      type: 'transfer', amount: input.amount, occurredAt: input.occurredAt,
      fromAccountId: input.fromAccountId, toAccountId: statement.accountId,
      note: input.note ?? '信用卡还款',
    });
    const id = await db.creditPayments.add(stamp({ statementId: statement.id!, entryId, allocatedAmount: allocated }) as CreditPayment);
    emit('credit-changed', { statementId: statement.id! });
    return { ...(await db.creditPayments.get(id))!, entryId, unallocatedAmount: input.amount - allocated };
  });
}

/** 解除还款关联；转账流水保留。 */
export async function unlinkCreditPayment(paymentId: number): Promise<void> {
  const payment = await db.creditPayments.get(paymentId);
  if (!payment) return;
  await db.creditPayments.delete(paymentId);
  emit('credit-changed', { statementId: payment.statementId });
}
