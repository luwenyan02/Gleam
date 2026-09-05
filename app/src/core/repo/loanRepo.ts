/**
 * 拾光 · 借贷往来仓库（loanRepo）
 * 借贷对象（往来人）管理。对象余额（正 = TA 欠你）随借贷账单由 entryRepo 自动增减，
 * 本仓库不直接改 balance。写操作后 emit 'entries-changed'。
 */
import { db, now, stamp } from '../db';
import { emit } from '../store';
import type { Entry, LoanContact } from '../types';

/** 全部借贷对象，按名称排序 */
export async function listLoanContacts(): Promise<LoanContact[]> {
  const rows = await db.loanContacts.toArray();
  return rows.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
}

/** 单个对象 */
export async function getLoanContact(id: number): Promise<LoanContact | undefined> {
  return db.loanContacts.get(id);
}

/**
 * 按名称取对象，不存在则创建（挖财导入按收付款人自动建立/合并时使用）。
 * @returns 对象 id
 */
export async function ensureLoanContact(name: string): Promise<number> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('对象名不能为空');
  const existing = await db.loanContacts.where('name').equals(trimmed).first();
  if (existing) return existing.id!;
  const id = await db.loanContacts.add(stamp({ name: trimmed, balance: 0 }) as LoanContact);
  emit('entries-changed');
  return id;
}

/** 对象改名 */
export async function renameLoanContact(id: number, name: string): Promise<void> {
  await db.loanContacts.update(id, { name: name.trim(), updatedAt: now() });
  emit('entries-changed');
}

/**
 * 删除对象。存在未删除关联借贷账单时抛错（须先处理账单）。
 */
export async function deleteLoanContact(id: number): Promise<void> {
  const used = await db.entries
    .where('loanContactId')
    .equals(id)
    .filter((e) => e.deletedAt === 0)
    .count();
  if (used > 0) throw new Error(`该对象仍有 ${used} 笔借贷账单，请先处理`);
  await db.loanContacts.delete(id);
  emit('entries-changed');
}

/** 对象往来流水（未删除借贷账单，occurredAt 倒序） */
export async function listContactEntries(contactId: number): Promise<Entry[]> {
  const rows = await db.entries
    .where('loanContactId')
    .equals(contactId)
    .filter((e) => e.deletedAt === 0)
    .toArray();
  return rows.sort((a, b) => b.occurredAt - a.occurredAt);
}
