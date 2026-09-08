/**
 * 拾光 · 商家仓库（merchantRepo）
 * 常用商家按使用频次（useCount）排前；导入时自动并入（ensureMerchant）。
 */
import { db, now, stamp } from '../db';
import type { Merchant } from '../types';
import { emitAfterCommit as emit } from './transactionEvents';

/** 商家列表，useCount 降序（常用在前） */
export async function listMerchants(): Promise<Merchant[]> {
  const rows = await db.merchants.toArray();
  return rows.sort((a, b) => b.useCount - a.useCount);
}

/**
 * 按名称取商家，不存在则创建。
 * @returns 商家 id
 */
export async function ensureMerchant(name: string): Promise<number> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('商家名不能为空');
  const existing = await db.merchants.where('name').equals(trimmed).first();
  if (existing) return existing.id!;
  const id = await db.merchants.add(stamp({ name: trimmed, useCount: 0 }) as Merchant);
  return id;
}

/** 记账选中商家后调用，使用频次 +1 */
export async function touchMerchant(id: number): Promise<void> {
  const m = await db.merchants.get(id);
  if (m) await db.merchants.update(id, { useCount: m.useCount + 1, updatedAt: now() });
}

/**
 * 改名（M2-D 最小补充：商家管理页需要改名能力，此前缺失；写法对齐 tagRepo.renameTag）。
 */
export async function renameMerchant(id: number, name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('商家名不能为空');
  await db.merchants.update(id, { name: trimmed, updatedAt: now() });
  emit('entries-changed');
}

/** 删除商家（引用它的账单 merchantId 置空） */
export async function deleteMerchant(id: number): Promise<void> {
  await db.transaction('rw', [db.merchants, db.entries], async () => {
    await db.entries.filter((e) => e.merchantId === id).modify({ merchantId: undefined, updatedAt: now() });
    await db.merchants.delete(id);
  });
  emit('entries-changed');
}
