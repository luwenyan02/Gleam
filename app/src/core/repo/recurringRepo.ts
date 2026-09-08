/**
 * 拾光 · 周期账仓库（recurringRepo）
 * 周期规则 CRUD 与到期入账。到期补跑由 scheduler 调用 runDueRules：
 * - 普通规则逐期自动入账（经 entryRepo，联动余额并进统计）；
 * - amountConfirm 规则不自动入账，返回「待确认」列表（通知接口预留，M2 实现 UI）。
 * 写操作后 emit 'entries-changed'（入账时）；规则变化无独立事件，UI 直接查询。
 */
import { db, now, stamp } from '../db';
import type { RecurringRule } from '../types';
import { addEntry } from './entryRepo';

/** 新建规则输入 */
export type NewRecurringRule = Omit<RecurringRule, 'id' | 'createdAt' | 'updatedAt' | 'nextRunAt'> & {
  nextRunAt?: number;
};

/**
 * 依据频率与入账日，计算 after 之后（不含）最近一次运行时间。
 * days 语义：daily 忽略；weekly 0-6（周日=0）；monthly 1-31（超出当月天数顺延到月底）；yearly MMDD 数值。
 */
export function computeNextRunAt(rule: Pick<RecurringRule, 'freq' | 'days'>, after: number): number {
  const base = new Date(after);
  base.setHours(9, 0, 0, 0); // 统一 09:00 入账
  const candidates: number[] = [];
  switch (rule.freq) {
    case 'daily': {
      const d = new Date(base);
      if (d.getTime() <= after) d.setDate(d.getDate() + 1);
      return d.getTime();
    }
    case 'weekly': {
      for (const dow of rule.days.length ? rule.days : [1]) {
        for (let add = 0; add < 15; add++) {
          const d = new Date(base);
          d.setDate(d.getDate() + add);
          if (d.getDay() === dow && d.getTime() > after) {
            candidates.push(d.getTime());
            break;
          }
        }
      }
      break;
    }
    case 'monthly': {
      for (const dom of rule.days.length ? rule.days : [1]) {
        for (let addM = 0; addM < 3; addM++) {
          const y = base.getFullYear();
          const m = base.getMonth() + addM;
          const lastDay = new Date(y, m + 1, 0).getDate();
          const d = new Date(y, m, Math.min(dom, lastDay), 9, 0, 0, 0);
          if (d.getTime() > after) {
            candidates.push(d.getTime());
            break;
          }
        }
      }
      break;
    }
    case 'yearly': {
      for (const mmdd of rule.days.length ? rule.days : [101]) {
        const mm = Math.floor(mmdd / 100) - 1;
        const dd = mmdd % 100;
        for (let addY = 0; addY < 2; addY++) {
          const d = new Date(base.getFullYear() + addY, mm, dd, 9, 0, 0, 0);
          if (d.getTime() > after) {
            candidates.push(d.getTime());
            break;
          }
        }
      }
      break;
    }
  }
  return Math.min(...candidates);
}

/**
 * 新增周期规则（nextRunAt 缺省自动按频率推算）。
 * @returns 规则 id
 */
export async function addRule(input: NewRecurringRule): Promise<number> {
  const nextRunAt = input.nextRunAt ?? computeNextRunAt(input, now());
  return db.recurringRules.add(stamp({ ...input, nextRunAt }) as RecurringRule);
}

/** 更新规则；freq/days 变化时自动重算 nextRunAt */
export async function updateRule(id: number, patch: Partial<NewRecurringRule>): Promise<void> {
  const rule = await db.recurringRules.get(id);
  if (!rule) throw new Error(`规则不存在：${id}`);
  const merged = { ...rule, ...patch };
  const nextRunAt =
    patch.freq !== undefined || patch.days !== undefined ? computeNextRunAt(merged, now()) : merged.nextRunAt;
  await db.recurringRules.put({ ...merged, nextRunAt, updatedAt: now(), id });
}

/** 启用 / 暂停（暂停的规则不入账；重新启用时从当前时间起算下一期） */
export async function setRuleEnabled(id: number, enabled: boolean): Promise<void> {
  const rule = await db.recurringRules.get(id);
  if (!rule) return;
  const nextRunAt = enabled ? computeNextRunAt(rule, now()) : rule.nextRunAt;
  await db.recurringRules.update(id, { enabled, nextRunAt, updatedAt: now() });
}

/** 删除规则（已入账的账单不受影响） */
export async function deleteRule(id: number): Promise<void> {
  await db.recurringRules.delete(id);
}

/** 全部规则 */
export async function listRules(): Promise<RecurringRule[]> {
  return db.recurringRules.toArray();
}

/** 汇总：每月固定支出合计（仅启用的 monthly 规则简单合计）与启用项数 */
export async function ruleSummary(): Promise<{ monthlyTotal: number; enabledCount: number }> {
  const rules = await listRules();
  const enabled = rules.filter((r) => r.enabled);
  const monthlyTotal = enabled
    .filter((r) => r.freq === 'monthly')
    .reduce((s, r) => s + r.amount * Math.max(1, r.days.length), 0);
  return { monthlyTotal, enabledCount: enabled.length };
}

/** 待确认入账项（amountConfirm 规则到期时产生，由 UI 呈现确认后手动入账） */
export interface PendingConfirm {
  ruleId: number;
  name: string;
  /** 约定金额（分），入账时可修改 */
  amount: number;
  /** 该期原定入账时间 */
  dueAt: number;
  accountId: number;
  categoryId: number;
}

/**
 * 领取并入账一期待确认周期账。
 * `ruleId + dueAt` 是稳定身份；队列移除、写账和余额变更同事务提交。
 * 若另一调用已领取该项，返回 booked=false，不重复入账。
 */
export async function confirmPendingOccurrence(
  ruleId: number,
  dueAt: number,
  amount: number,
): Promise<{ booked: boolean; pending: PendingConfirm[] }> {
  return db.transaction(
    'rw',
    [db.entries, db.accounts, db.entryTags, db.recurringRules, db.settings],
    async () => {
      const row = await db.settings.get('recurring.pendingConfirms');
      const saved = Array.isArray(row?.value) ? row.value as PendingConfirm[] : [];
      const index = saved.findIndex((item) => item.ruleId === ruleId && item.dueAt === dueAt);
      if (index < 0) return { booked: false, pending: saved };

      const item = saved[index];
      const pending = saved.filter((_, current) => current !== index);
      await db.settings.put({ key: 'recurring.pendingConfirms', value: pending, updatedAt: now() });
      await addEntry({
        type: 'expense',
        amount,
        occurredAt: item.dueAt,
        categoryId: item.categoryId,
        accountId: item.accountId,
        note: `周期账 · ${item.name}`,
      });
      return { booked: true, pending };
    },
  );
}

/**
 * 补跑到期规则（nextRunAt <= asOf 的启用规则，逐期推进直至追平）：
 * - 普通规则：每期生成一笔支出账单（occurredAt = 原定入账时间）；
 * - amountConfirm 规则：不入账，收集为 PendingConfirm 返回（通知接口预留）。
 * @returns 本次自动入账笔数与待确认列表
 */
export async function runDueRules(asOf = now()): Promise<{ booked: number; pending: PendingConfirm[] }> {
  return db.transaction(
    'rw',
    [db.entries, db.accounts, db.entryTags, db.recurringRules, db.settings],
    async () => {
      const due = await db.recurringRules.where('[enabled+nextRunAt]').between([1, 0], [1, asOf], true, true).toArray();
      // Dexie 布尔不可索引，enabled 以 filter 兜底（索引项按数字写入时生效）
      const rules = due.length ? due : (await db.recurringRules.toArray()).filter((r) => r.enabled && r.nextRunAt <= asOf);
      let booked = 0;
      const pending: PendingConfirm[] = [];
      for (const rule of rules) {
        let cursor = rule.nextRunAt;
        let guard = 0;
        while (cursor <= asOf && guard < 400) {
          guard++;
          if (rule.amountConfirm) {
            pending.push({
              ruleId: rule.id!,
              name: rule.name,
              amount: rule.amount,
              dueAt: cursor,
              accountId: rule.accountId,
              categoryId: rule.categoryId,
            });
          } else {
            await addEntry({
              type: 'expense',
              amount: rule.amount,
              occurredAt: cursor,
              categoryId: rule.categoryId,
              accountId: rule.accountId,
              note: `周期账 · ${rule.name}`,
            });
            booked++;
          }
          cursor = computeNextRunAt(rule, cursor);
        }
        await db.recurringRules.update(rule.id!, { nextRunAt: cursor, updatedAt: now() });
      }
      if (!pending.length) return { booked, pending };

      const savedRow = await db.settings.get('recurring.pendingConfirms');
      const saved = Array.isArray(savedRow?.value) ? savedRow.value as PendingConfirm[] : [];
      const seen = new Set(saved.map((item) => `${item.ruleId}@${item.dueAt}`));
      const fresh = pending.filter((item) => !seen.has(`${item.ruleId}@${item.dueAt}`));
      if (fresh.length) {
        await db.settings.put({
          key: 'recurring.pendingConfirms',
          value: [...saved, ...fresh],
          updatedAt: now(),
        });
      }
      return { booked, pending: fresh };
    },
  );
}
