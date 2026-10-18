/**
 * 拾光 · 账单仓库（entryRepo）
 * 所有账单读写的唯一入口。写操作在 Dexie 事务内完成账单 + 双边账户余额的
 * 一致性联动（PRD「数据一致性硬规则」），成功后 emit 'entries-changed' 与 'accounts-changed'。
 *
 * 余额联动规则：
 * - 支出：accountId 余额 −amount；收入：+amount；
 * - 转账：fromAccountId −amount，toAccountId +amount（不计收支）；
 * - 借贷（不计收支）：借出 lend → 资金账户−、应收应付账户+；借入 borrow 反向；
 *   还款 repay 同借出方向；收款 collect 同借入方向；
 * - 报销到账：reimburseAccountId 余额 +reimbursedAmount（随账单一起回滚/重放）。
 * 编辑 = 回滚旧账单影响 + 重放新账单影响；软删除回滚影响，恢复重放影响。
 */
import { db, now, stamp } from '../db';
import { on } from '../store';
import { emitAfterCommit as emit } from './transactionEvents';
import { accountEffects } from '../entryEffects';
import { validateLoanAccounts } from '../loanLedger';
import { removeEntryAttachmentLinks } from './entryAttachmentRepo';
import type { Entry, EntryType, ImportBatch, LoanKind, ReimburseStatus } from '../types';

/** 新建账单输入（id/时间戳/软删除字段由仓库补齐） */
export type NewEntry = Omit<Entry, 'id' | 'createdAt' | 'updatedAt' | 'deletedAt' | 'reimburseStatus'> & {
  reimburseStatus?: ReimburseStatus;
};

/** 列表查询筛选条件 */
export interface EntryFilter {
  /** occurredAt 起（含），毫秒时间戳 */
  from?: number;
  /** occurredAt 止（不含），毫秒时间戳 */
  to?: number;
  type?: EntryType;
  categoryIds?: number[];
  accountIds?: number[];
  reimburseStatus?: ReimburseStatus;
  /** 返回条数上限（按 occurredAt 倒序截断） */
  limit?: number;
}

/** 在事务内按 sign（+1 重放 / −1 回滚）应用余额影响 */
async function applyEffects(e: Entry, sign: 1 | -1): Promise<void> {
  for (const { accountId, delta } of accountEffects(e)) {
    const acct = await db.accounts.get(accountId);
    if (!acct) throw new Error(e.type === 'loan' ? '借贷关联账户不存在' : '账单关联账户不存在');
    const balance = acct.balance + sign * delta;
    if (!Number.isSafeInteger(balance)) throw new Error('账户余额必须为安全整数（分）');
    await db.accounts.update(accountId, { balance, updatedAt: now() });
  }
}

/** 字段合法性校验，非法时抛错 */
function validate(e: NewEntry | Entry, allowSourceAdjustment = false): void {
  if (e.sourceAdjustment && (!allowSourceAdjustment || e.sourceAdjustment.source !== 'wacai'
    || !Number.isSafeInteger(e.sourceAdjustment.rowNo) || e.sourceAdjustment.rowNo < 2
    || !['expense', 'income'].includes(e.type) || e.amount > 0 || e.refundFlag || e.refundOfEntryId != null
    || (e.reimburseStatus != null && e.reimburseStatus !== 'none') || e.reimbursedAmount != null
    || e.reimburseAccountId != null || e.reimbursedAt != null)) {
    throw new Error('挖财原始冲回/零额记录仅支持原样导入，不支持编辑');
  }
  if (!Number.isSafeInteger(e.amount) || (e.amount <= 0 && !e.sourceAdjustment)) throw new Error('金额须为正整数（分）');
  if (!Number.isFinite(e.occurredAt)) throw new Error('occurredAt 非法');
  if (e.refundFlag && e.type !== 'expense') throw new Error('退款记录必须归属支出类型');
  if (e.refundFlag && ((e.reimburseStatus != null && e.reimburseStatus !== 'none')
    || e.reimbursedAmount != null || e.reimburseAccountId != null || e.reimbursedAt != null)) {
    throw new Error('退款记录不能同时报销');
  }
  if (e.reimbursedAmount != null) {
    if (e.type !== 'expense' || e.reimburseStatus !== 'done'
      || !Number.isSafeInteger(e.reimbursedAmount) || e.reimbursedAmount <= 0 || e.reimbursedAmount > e.amount) {
      throw new Error('报销到账金额须为正整数（分），且不能超过原支出');
    }
    if (e.reimburseAccountId == null || !Number.isFinite(e.reimbursedAt)) throw new Error('报销到账缺少有效账户或日期');
  }
  switch (e.type) {
    case 'expense':
    case 'income':
      if (e.accountId == null) throw new Error(`${e.type} 账单必须指定 accountId`);
      break;
    case 'transfer':
      // 对账调整仅豁免恰有一侧的情况，备注不能放行无账户/同账户转账。
      if (e.note === '余额对账调整' && (e.fromAccountId == null) !== (e.toAccountId == null)) break;
      if (e.fromAccountId == null || e.toAccountId == null) throw new Error('转账必须指定 from/to 账户');
      if (e.fromAccountId === e.toAccountId) throw new Error('转出与转入账户不能相同');
      break;
    case 'loan':
      if (!e.loanKind) throw new Error('借贷必须指定 loanKind');
      if (e.fromAccountId == null || e.toAccountId == null) throw new Error('请选择资金账户和应收应付账户');
      if (e.accountId != null || e.loanContactId != null) throw new Error('借贷请重新选择双账户，不再使用独立对象');
      break;
  }
}

/** 在写事务内读取两侧账户，账户错误时不得写入半笔流水。 */
async function validateAccountReferences(entry: NewEntry | Entry): Promise<void> {
  const ids = [...new Set(accountEffects(entry).map(effect => effect.accountId))];
  if (ids.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error('账单关联账户无效');
  const accounts = await db.accounts.bulkGet(ids);
  if (accounts.some(account => account == null)) throw new Error('账单关联账户不存在');
  if (entry.type !== 'loan') return;
  const present = accounts.filter((account): account is NonNullable<typeof account> => account != null);
  validateLoanAccounts(entry, new Map(present.map(account => [account.id, account])));
}

/** 通用新增、编辑、恢复和导入都不能绕过原支出/可退额校验。 */
async function validateRefundReference(entry: NewEntry | Entry, id?: number): Promise<void> {
  if (!entry.refundFlag) return;
  const original = entry.refundOfEntryId != null ? await db.entries.get(entry.refundOfEntryId) : undefined;
  if (!original || original.deletedAt !== 0 || original.type !== 'expense' || original.refundFlag) {
    throw new Error('关联的原支出账单不存在');
  }
  const siblings = await db.entries.filter(row => row.deletedAt === 0 && row.refundFlag === true
    && row.refundOfEntryId === original.id && row.id !== id).toArray();
  if (siblings.reduce((sum, row) => sum + row.amount, 0) + entry.amount > original.amount) {
    throw new Error('退款总额不能超过原支出金额');
  }
}

/**
 * 新增账单，事务内联动双边账户余额。
 * @param input 账单字段（金额单位分）
 * @param tagIds 关联标签 id 列表（可选）
 * @returns 新账单 id
 */
export async function addEntry(input: NewEntry, tagIds: number[] = []): Promise<number> {
  validate(input);
  const id = await db.transaction('rw', [db.entries, db.accounts, db.entryTags], async () => {
    await validateAccountReferences(input);
    await validateRefundReference(input);
    const entry = stamp({ reimburseStatus: 'none' as ReimburseStatus, ...input, deletedAt: 0 }) as Entry;
    const newId = await db.entries.add(entry);
    await applyEffects({ ...entry, id: newId }, 1);
    for (const tagId of tagIds) await db.entryTags.add({ entryId: newId, tagId });
    return newId;
  });
  emit('entries-changed', { id });
  emit('accounts-changed');
  return id;
}

/**
 * 编辑账单：回滚旧影响 → 应用新影响 → 更新记录。
 * @param id 账单 id
 * @param patch 变更字段（不含 id/createdAt）
 * @param tagIds 传入时整体替换标签关联；不传保持不变
 */
export async function updateEntry(id: number, patch: Partial<NewEntry>, tagIds?: number[]): Promise<void> {
  await db.transaction('rw', [db.entries, db.accounts, db.entryTags], async () => {
    const old = await db.entries.get(id);
    if (!old) throw new Error(`账单不存在：${id}`);
    if (old.sourceAdjustment) throw new Error('挖财原始冲回/零额记录不支持编辑，可删除后重新导入');
    const next = { ...old, ...patch, updatedAt: now() } as Entry;
    validate(next);
    await validateAccountReferences(next);
    await validateRefundReference(next, id);
    if (!next.refundFlag) {
      const refunds = await db.entries
        .filter((entry) => entry.deletedAt === 0 && entry.refundFlag === true && entry.refundOfEntryId === id)
        .toArray();
      if (refunds.length && (next.type !== 'expense' || refunds.reduce((sum, entry) => sum + entry.amount, 0) > next.amount)) {
        throw new Error('该账单已有退款，修改后的类型或金额与退款记录冲突');
      }
    }
    if (old.deletedAt === 0) await applyEffects(old, -1);
    await db.entries.put({ ...next, id });
    if (next.deletedAt === 0) await applyEffects(next, 1);
    if (tagIds) {
      await db.entryTags.where('entryId').equals(id).delete();
      for (const tagId of tagIds) await db.entryTags.add({ entryId: id, tagId });
    }
  });
  emit('entries-changed', { id });
  emit('accounts-changed');
}

/**
 * 软删除账单（进回收站）：回滚余额影响，deletedAt 置为当前时间。
 */
export async function softDeleteEntry(id: number): Promise<void> {
  await db.transaction('rw', [db.entries, db.accounts], async () => {
    const e = await db.entries.get(id);
    if (!e || e.deletedAt !== 0) return;
    const deletedAt = now();
    if (!e.refundFlag) {
      const refunds = await db.entries
        .filter((entry) => entry.deletedAt === 0 && entry.refundFlag === true && entry.refundOfEntryId === id)
        .toArray();
      for (const refund of refunds) {
        await applyEffects(refund, -1);
        await db.entries.update(refund.id, { deletedAt, updatedAt: deletedAt });
      }
    }
    await applyEffects(e, -1);
    await db.entries.update(id, { deletedAt, updatedAt: deletedAt });
  });
  emit('entries-changed', { id });
  emit('accounts-changed');
}

/**
 * 从回收站恢复账单：deletedAt 归零并重放余额影响，回到原日期流水并重新计入统计。
 */
export async function restoreEntry(id: number): Promise<void> {
  await db.transaction('rw', [db.entries, db.accounts], async () => {
    const e = await db.entries.get(id);
    if (!e || e.deletedAt === 0) return;
    // 退款不允许单独恢复：原支出必须先恢复，否则产生孤儿退款
    if (e.refundFlag && e.refundOfEntryId != null) {
      const original = await db.entries.get(e.refundOfEntryId);
      if (!original || original.deletedAt !== 0) {
        throw new Error('请先恢复原支出账单');
      }
    }
    await validateAccountReferences(e);
    validate(e, !!e.sourceAdjustment);
    await validateRefundReference(e, id);
    const deletedAt = e.deletedAt;
    await db.entries.update(id, { deletedAt: 0, updatedAt: now() });
    await applyEffects({ ...e, deletedAt: 0 }, 1);
    if (!e.refundFlag) {
      const refunds = await db.entries
        .filter((entry) => entry.refundFlag === true && entry.refundOfEntryId === id && entry.deletedAt === deletedAt)
        .toArray();
      for (const refund of refunds) {
        validate(refund);
        await validateAccountReferences(refund);
        await validateRefundReference(refund, refund.id);
        await db.entries.update(refund.id, { deletedAt: 0, updatedAt: now() });
        await applyEffects({ ...refund, deletedAt: 0 }, 1);
      }
    }
  });
  emit('entries-changed', { id });
  emit('accounts-changed');
}

/**
 * 物理删除账单（仅允许对已软删除的账单调用；余额影响在软删除时已回滚）。
 * 同时清理标签关联。
 */
export async function purgeEntry(id: number): Promise<void> {
  await db.transaction('rw', [db.entries, db.entryTags, db.entryAttachments, db.attachments, db.lifeNotes, db.settings, db.lifeDrafts, db.lifeEditions], async () => {
    const e = await db.entries.get(id);
    if (!e) return;
    if (e.deletedAt === 0) throw new Error('仅可物理删除回收站中的账单');
    if (!e.refundFlag) {
      const refundIds = (await db.entries.filter((entry) => entry.refundOfEntryId === id).toArray()).map((entry) => entry.id);
      if (refundIds.length) {
        await removeEntryAttachmentLinks(refundIds);
        await db.entryTags.where('entryId').anyOf(refundIds).delete();
        await db.entries.bulkDelete(refundIds);
      }
    }
    await db.entryTags.where('entryId').equals(id).delete();
    await removeEntryAttachmentLinks([id]);
    await db.entries.delete(id);
  });
  emit('entries-changed', { id });
}

/** 按 id 读取单条账单（含已软删除） */
export async function getEntry(id: number): Promise<Entry | undefined> {
  return db.entries.get(id);
}

/** 读取账单关联的标签 id 列表 */
export async function getEntryTagIds(entryId: number): Promise<number[]> {
  const rows = await db.entryTags.where('entryId').equals(entryId).toArray();
  return rows.map((r) => r.tagId);
}

/** 原支出关联的有效退款记录，按退款时间倒序。 */
export async function listRefunds(originalEntryId: number): Promise<Entry[]> {
  const rows = await db.entries.where('refundOfEntryId').equals(originalEntryId)
    .and((entry) => entry.deletedAt === 0 && entry.refundFlag === true).toArray();
  return rows.sort((a, b) => b.occurredAt - a.occurredAt);
}

/** 原支出尚可退款金额；非有效支出返回 0。 */
export async function refundableAmount(originalEntryId: number): Promise<number> {
  const original = await db.entries.get(originalEntryId);
  if (!original || original.deletedAt !== 0 || original.type !== 'expense' || original.refundFlag) return 0;
  const refunded = (await listRefunds(originalEntryId)).reduce((sum, entry) => sum + entry.amount, 0);
  return Math.max(0, original.amount - refunded);
}

export interface CreateRefundInput {
  originalEntryId: number;
  amount: number;
  occurredAt: number;
  accountId?: number;
  categoryId?: number;
  merchantId?: number;
  note?: string;
}

/**
 * 新建关联退款：退款作为独立支出退款记录，账户余额增加、支出统计冲减，且总额不得超过原支出。
 */
export async function createRefund(input: CreateRefundInput): Promise<number> {
  if (!Number.isInteger(input.amount) || input.amount <= 0) throw new Error('退款金额须大于 0');
  const id = await db.transaction('rw', [db.entries, db.accounts, db.entryTags], async () => {
    const original = await db.entries.get(input.originalEntryId);
    if (!original || original.deletedAt !== 0 || original.type !== 'expense' || original.refundFlag) {
      throw new Error('仅支出账单可以发起退款');
    }
    const existing = await db.entries
      .filter((entry) => entry.deletedAt === 0 && entry.refundFlag === true
        && entry.refundOfEntryId === input.originalEntryId)
      .toArray();
    const remaining = original.amount - existing.reduce((sum, entry) => sum + entry.amount, 0);
    if (input.amount > remaining) throw new Error(`最多可退款 ${remaining} 分`);
    const entry = stamp({
      type: 'expense' as const,
      amount: input.amount,
      occurredAt: input.occurredAt,
      categoryId: input.categoryId ?? original.categoryId,
      accountId: input.accountId ?? original.accountId,
      merchantId: input.merchantId ?? original.merchantId,
      note: input.note,
      reimburseStatus: 'none' as ReimburseStatus,
      refundFlag: true,
      refundOfEntryId: original.id,
      deletedAt: 0,
    }) as Entry;
    validate(entry);
    await validateAccountReferences(entry);
    const refundId = await db.entries.add(entry);
    await applyEffects({ ...entry, id: refundId }, 1);
    const tags = await db.entryTags.where('entryId').equals(original.id).toArray();
    for (const tag of tags) await db.entryTags.add({ entryId: refundId, tagId: tag.tagId });
    return refundId;
  });
  emit('entries-changed', { id, refundOfEntryId: input.originalEntryId });
  emit('accounts-changed');
  return id;
}

/**
 * 按日期范围与筛选条件查询未删除账单，occurredAt 倒序。
 * 无 from/to 时全量（慎用，配合 limit）。
 */
export async function listEntries(filter: EntryFilter = {}): Promise<Entry[]> {
  const { from = 0, to = Infinity, type, categoryIds, accountIds, reimburseStatus, limit } = filter;
  let coll = db.entries
    .where('[deletedAt+occurredAt]')
    .between([0, from], [0, to], true, false)
    .reverse();
  const catSet = categoryIds && new Set(categoryIds);
  const acctSet = accountIds && new Set(accountIds);
  const matches = (e: Entry) => {
    if (type && e.type !== type) return false;
    if (catSet && (e.categoryId == null || !catSet.has(e.categoryId))) return false;
    if (acctSet) {
      const hit = [e.accountId, e.fromAccountId, e.toAccountId].some((a) => a != null && acctSet.has(a));
      if (!hit) return false;
    }
    if (reimburseStatus && e.reimburseStatus !== reimburseStatus) return false;
    return true;
  };
  // 报销状态候选通常很少，先走状态索引，避免为了几十笔记录扫描整本账单。
  if (reimburseStatus && reimburseStatus !== 'none') {
    const rows = await db.entries.where('reimburseStatus').equals(reimburseStatus)
      .filter(e => e.deletedAt === 0 && e.occurredAt >= from && e.occurredAt < to && matches(e)).toArray();
    rows.sort((a, b) => b.occurredAt - a.occurredAt || b.id - a.id);
    return limit ? rows.slice(0, limit) : rows;
  }
  // 没有额外条件时保留原生范围读取；空谓词会迫使 Dexie 逐条遍历游标。
  if (type || catSet || acctSet || reimburseStatus) coll = coll.filter(matches);
  return limit ? coll.limit(limit).toArray() : coll.toArray();
}

/** 搜索日期选择器的下界，只读取日期索引中的首笔有效账单。 */
export async function getEarliestEntryDate(): Promise<number | undefined> {
  const entry = await db.entries.where('[deletedAt+occurredAt]')
    .between([0, 0], [0, Infinity], true, false).first();
  return entry?.occurredAt;
}

/** 本地自然日 key，形如 '2026-08-07' */
export function dayKey(ts: number): string {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/**
 * 按日分组查询（首页时间线/明细用）。
 * @returns 日期倒序的分组数组，组内 occurredAt 倒序
 */
export async function listEntriesByDay(filter: EntryFilter = {}): Promise<{ day: string; entries: Entry[] }[]> {
  const rows = await listEntries(filter);
  const groups = new Map<string, Entry[]>();
  for (const e of rows) {
    const key = dayKey(e.occurredAt);
    const arr = groups.get(key);
    if (arr) arr.push(e);
    else groups.set(key, [e]);
  }
  return [...groups.entries()].map(([day, entries]) => ({ day, entries }));
}

/** 回收站列表：已软删除账单，按删除时间倒序 */
export async function listDeletedEntries(): Promise<Entry[]> {
  const rows = await db.entries.where('deletedAt').above(0).toArray();
  return rows.sort((a, b) => b.deletedAt - a.deletedAt);
}

/**
 * 导入查重：按「时间+类型+金额+账户」精确匹配（走复合索引）。
 * @returns 命中的未删除账单列表（空数组即无重复）
 */
export async function findDuplicates(
  occurredAt: number,
  type: EntryType,
  amount: number,
  accountId: number | undefined,
): Promise<Entry[]> {
  const rows = await db.entries
    .where('[occurredAt+type+amount+accountId]')
    .equals([occurredAt, type, amount, accountId ?? 0])
    .toArray();
  return rows.filter((e) => e.deletedAt === 0);
}

/**
 * [M3] 转账查重：复合索引 [occurredAt+type+amount+accountId] 对 accountId=undefined
 * 的转账不生效（README 遗留事项 1），改走 occurredAt 单列索引后过滤 from/to。
 * @returns 命中的未删除转账列表
 */
export async function findTransferDuplicates(
  occurredAt: number,
  amount: number,
  fromAccountId: number | undefined,
  toAccountId: number | undefined,
): Promise<Entry[]> {
  const rows = await db.entries.where('occurredAt').equals(occurredAt).toArray();
  return rows.filter((e) =>
    e.deletedAt === 0 && e.type === 'transfer' && e.amount === amount
    && e.fromAccountId === fromAccountId && e.toAccountId === toAccountId);
}

/** 同秒同额但不同应收应付账户或借贷种类，不视为重复。 */
export async function findLoanDuplicates(
  occurredAt: number, amount: number, loanKind: LoanKind,
  fromAccountId: number | undefined, toAccountId: number | undefined,
): Promise<Entry[]> {
  const rows = await db.entries.where('occurredAt').equals(occurredAt).toArray();
  return rows.filter(entry => entry.deletedAt === 0 && entry.type === 'loan'
    && entry.loanKind === loanKind && entry.amount === amount
    && entry.fromAccountId === fromAccountId && entry.toAccountId === toAccountId);
}

/** [M3] 批量导入的单项：账单字段 + 预先 ensure 好的标签 id 列表 */
export interface ImportEntryItem {
  input: NewEntry;
  tagIds?: number[];
}

/** 导入事务内回读持久化数据，逐笔核验金额、类型、日期与映射，失败让外层整体回滚。 */
export async function verifyImportedEntries(ids: number[], items: ImportEntryItem[]): Promise<Entry[]> {
  const saved = await db.entries.bulkGet(ids);
  if (saved.length !== items.length || saved.some((entry, i) => !entry ||
    (['type', 'amount', 'occurredAt', 'accountId', 'categoryId', 'fromAccountId', 'toAccountId', 'loanKind'] as const)
      .some(key => entry[key] !== items[i].input[key]))) throw new Error('入库核对不一致');
  return saved as Entry[];
}

/**
 * [M3] 批量导入：单个事务内写入全部账单 + importBatch 记录，
 * 每笔复用 validate/applyEffects 驱动账户与借贷余额（与手工记账硬规则一致），
 * 任一笔失败整个事务回滚。完成后只 emit 一次事件。
 * @param items 待导入账单列表（金额单位分）
 * @param batch 导入批次信息（source/fileName/counts/snapshotRef）
 * @returns 批次 id 与新账单 id 列表
 */
export async function importEntriesBatch(
  items: ImportEntryItem[],
  batch: Omit<ImportBatch, 'id' | 'createdAt' | 'updatedAt'>,
): Promise<{ batchId: number; entryIds: number[] }> {
  for (const it of items) validate(it.input, batch.source === 'wacai');
  const result = await db.transaction(
    'rw',
    [db.entries, db.accounts, db.entryTags, db.importBatches],
    async () => {
      const batchId = await db.importBatches.add(stamp({ ...batch }) as ImportBatch);
      const entryIds: number[] = [];
      for (const { input, tagIds = [] } of items) {
        await validateAccountReferences(input);
        await validateRefundReference(input);
        const entry = stamp({
          reimburseStatus: 'none' as ReimburseStatus, ...input, deletedAt: 0, importBatchId: batchId,
        }) as Entry;
        const newId = await db.entries.add(entry);
        await applyEffects({ ...entry, id: newId }, 1);
        for (const tagId of tagIds) await db.entryTags.add({ entryId: newId, tagId });
        entryIds.push(newId);
      }
      return { batchId, entryIds };
    },
  );
  emit('entries-changed');
  emit('accounts-changed');
  return result;
}

/**
 * 报销到账：把所选待报销支出标记为已报销，到账账户余额 +到账金额。
 * 统计口径（计收入 / 冲抵支出）由 statsRepo 按设置计算，此处只落数据。
 * @param ids 待报销支出账单 id 列表
 * @param reimburseAccountId 到账账户
 * @param amountById 可选：按账单指定到账金额（分），缺省为全额报销
 */
export async function settleReimbursement(
  ids: number[],
  reimburseAccountId: number,
  amountById?: Map<number, number>,
): Promise<void> {
  await db.transaction('rw', [db.entries, db.accounts], async () => {
    if (!Number.isSafeInteger(reimburseAccountId) || !(await db.accounts.get(reimburseAccountId))) {
      throw new Error('报销到账账户不存在');
    }
    for (const id of ids) {
      const e = await db.entries.get(id);
      if (!e || e.deletedAt !== 0 || e.type !== 'expense' || e.reimburseStatus !== 'pending') continue;
      if (e.refundFlag || e.sourceAdjustment) throw new Error('退款或冲回记录不能同时报销');
      const amt = amountById?.get(id) ?? e.amount;
      if (!Number.isSafeInteger(amt) || amt <= 0 || amt > e.amount) throw new Error('报销到账金额须为正整数（分），且不能超过原支出');
      await db.entries.update(id, {
        reimburseStatus: 'done',
        reimbursedAt: now(),
        reimburseAccountId,
        reimbursedAmount: amt,
        updatedAt: now(),
      });
      const acct = await db.accounts.get(reimburseAccountId);
      const balance = acct!.balance + amt;
      if (!Number.isSafeInteger(balance)) throw new Error('账户余额必须为安全整数（分）');
      await db.accounts.update(reimburseAccountId, { balance, updatedAt: now() });
    }
  });
  emit('entries-changed');
  emit('accounts-changed');
}

/** 备注频率项（getNoteFrequencies 返回元素） */
export interface NoteFrequency {
  /** 备注原文（去首尾空白） */
  note: string;
  /** 出现次数 */
  count: number;
  /** 该备注出现过的分类 id 集合（无分类账单不计入） */
  categoryIds: number[];
}

/**
 * 全量备注聚合缓存（不带 categoryId 调用的结果）。记一笔每次打开都会拉备注建议，
 * 避免重复 O(N) 全库遍历；订阅 'entries-changed'（增删改/导入/恢复都会 emit，
 * 含 restoreAll 整库替换）精确失效，比时间戳过期更及时且无窗口内脏读。
 */
let noteFreqCache: NoteFrequency[] | undefined;
on('entries-changed', () => { noteFreqCache = undefined; });

/**
 * 聚合未删除账单的非空备注，去重后按频率降序取前 50 条（备注历史建议用）。
 * 不带 categoryId 的调用走模块级缓存；指定 categoryId 时因需按分类重新计数，
 * 无法由全量聚合推导，仍直接扫描。
 * @param categoryId 可选：仅统计该分类下的账单
 */
export async function getNoteFrequencies(categoryId?: number): Promise<NoteFrequency[]> {
  if (categoryId == null && noteFreqCache) return noteFreqCache;
  const agg = new Map<string, { count: number; categoryIds: Set<number> }>();
  await db.entries
    .where('[deletedAt+occurredAt]')
    .between([0, 0], [0, Infinity], true, true)
    .each((e) => {
      const note = e.note?.trim();
      if (!note) return;
      if (categoryId != null && e.categoryId !== categoryId) return;
      let item = agg.get(note);
      if (!item) { item = { count: 0, categoryIds: new Set() }; agg.set(note, item); }
      item.count += 1;
      if (e.categoryId != null) item.categoryIds.add(e.categoryId);
    });
  const result = [...agg.entries()]
    .map(([note, v]) => ({ note, count: v.count, categoryIds: [...v.categoryIds] }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 50);
  if (categoryId == null) noteFreqCache = result;
  return result;
}
