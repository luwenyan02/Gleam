/**
 * 拾光 · 周期账仓库（recurringRepo）
 * 周期规则 CRUD 与到期入账。到期补跑由 scheduler 调用 runDueRules：
 * - 普通规则逐期自动入账（经 entryRepo，联动余额并进统计）；
 * - amountConfirm 规则不自动入账，返回「待确认」列表（通知接口预留，M2 实现 UI）。
 * 写操作后 emit 'entries-changed'（入账时）；规则变化无独立事件，UI 直接查询。
 */
import { db, now, stamp } from '../db';
import type { CategoryKind, RecurringRule } from '../types';
import { addEntry } from './entryRepo';

/** 新建规则输入 */
export type NewRecurringRule = Omit<RecurringRule, 'id' | 'createdAt' | 'updatedAt' | 'nextRunAt' | 'initialCatchUpThrough' | 'skippedOccurrences'> & {
  nextRunAt?: number;
};

/** 旧规则没有 type，统一视为支出。 */
export function recurringRuleType(rule: Pick<RecurringRule, 'type'>): CategoryKind {
  return rule.type === 'income' ? 'income' : 'expense';
}

/**
 * 依据频率与入账日，计算 after 之后（不含）最近一次运行时间。
 * days 语义：daily 忽略；weekly 0-6（周日=0）；monthly 1-31（超出当月天数顺延到月底）；yearly MMDD 数值。
 */
export function computeNextRunAt(rule: Pick<RecurringRule, 'freq' | 'days' | 'interval' | 'startDate'>, after: number): number {
  const interval = Math.max(1, rule.interval ?? 1);
  const floor = Math.max(after, (rule.startDate ?? 0) - 1);
  const anchor = new Date(rule.startDate ?? floor);
  anchor.setHours(9, 0, 0, 0);
  if (rule.freq === 'weekly') anchor.setDate(anchor.getDate() - ((anchor.getDay() + 6) % 7));
  const calendarDay = (d: Date): number => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000;
  const candidatesAt = (offset: number): number[] => {
    const y = anchor.getFullYear(), m = anchor.getMonth(), day = anchor.getDate();
    if (rule.freq === 'daily') return [new Date(y, m, day + offset, 9).getTime()];
    if (rule.freq === 'weekly') return (rule.days.length ? rule.days : [1])
      .map(dow => new Date(y, m, day + offset * 7 + ((dow + 6) % 7), 9).getTime());
    if (rule.freq === 'monthly') return (rule.days.length ? rule.days : [1]).map(dom =>
      new Date(y, m + offset, Math.min(dom, new Date(y, m + offset + 1, 0).getDate()), 9).getTime());
    return (rule.days.length ? rule.days : [101]).map(mmdd => {
      const month = Math.floor(mmdd / 100) - 1;
      return new Date(y + offset, month, Math.min(mmdd % 100, new Date(y + offset, month + 1, 0).getDate()), 9).getTime();
    });
  };
  // 周期间隔从开始日期后的第一个可入账周期起算；没有开始日期的旧规则沿当前周期推进。
  if (rule.startDate != null && candidatesAt(0).every(at => at < rule.startDate!)) {
    if (rule.freq === 'yearly') anchor.setFullYear(anchor.getFullYear() + 1);
    else if (rule.freq === 'monthly') anchor.setMonth(anchor.getMonth() + 1, 1);
    else anchor.setDate(anchor.getDate() + (rule.freq === 'weekly' ? 7 : 1));
  }
  const base = new Date(floor);
  const distance = rule.freq === 'yearly' ? base.getFullYear() - anchor.getFullYear()
    : rule.freq === 'monthly' ? (base.getFullYear() - anchor.getFullYear()) * 12 + base.getMonth() - anchor.getMonth()
      : (calendarDay(base) - calendarDay(anchor)) / (rule.freq === 'weekly' ? 7 : 1);
  const offset = Math.max(0, Math.floor(distance / interval)) * interval;
  const current = candidatesAt(offset).filter(at => at > floor);
  return Math.min(...(current.length ? current : candidatesAt(offset + interval)));
}

/**
 * 新增周期规则（nextRunAt 缺省自动按频率推算）。
 * @returns 规则 id
 */
export async function addRule(input: NewRecurringRule): Promise<number> {
  const nextRunAt = input.nextRunAt ?? computeNextRunAt(input, input.startDate != null ? input.startDate - 1 : now());
  const rule = stamp({ ...input, type: recurringRuleType(input), nextRunAt });
  return db.recurringRules.add({ ...rule, initialCatchUpThrough: rule.createdAt } as RecurringRule);
}

/** 更新规则；仅实际排期变化时重算 nextRunAt，与补跑串行提交。 */
export async function updateRule(id: number, patch: Partial<NewRecurringRule>): Promise<void> {
  return db.transaction('rw', [db.recurringRules], async () => {
    const rule = await db.recurringRules.get(id);
    if (!rule) throw new Error(`规则不存在：${id}`);
    const merged = { ...rule, ...patch, type: patch.type ?? recurringRuleType(rule) };
    const daysKey = (days: number[]) => [...new Set(days)].sort((a, b) => a - b).join(',');
    const scheduleChanged = merged.freq !== rule.freq || (merged.interval ?? 1) !== (rule.interval ?? 1)
      || merged.startDate !== rule.startDate || daysKey(merged.days) !== daysKey(rule.days);
    const nextRunAt = scheduleChanged ? computeNextRunAt(merged, now()) : merged.nextRunAt;
    await db.recurringRules.put({ ...merged, nextRunAt, updatedAt: now(), id });
  });
}

/** 启用 / 暂停（暂停的规则不入账；重新启用时从当前时间起算下一期） */
export async function setRuleEnabled(id: number, enabled: boolean): Promise<void> {
  return db.transaction('rw', [db.recurringRules], async () => {
    const rule = await db.recurringRules.get(id);
    if (!rule) return;
    const nextRunAt = enabled ? computeNextRunAt(rule, now()) : rule.nextRunAt;
    await db.recurringRules.update(id, { enabled, nextRunAt, updatedAt: now() });
  });
}

/** 删除规则并取消其未入账待确认项；已入账账单不受影响。 */
export async function deleteRule(id: number): Promise<void> {
  await db.transaction('rw', [db.recurringRules, db.settings], async () => {
    const row = await db.settings.get('recurring.pendingConfirms');
    const saved = Array.isArray(row?.value) ? row.value as PendingConfirm[] : [];
    const pending = saved.filter((item) => item.ruleId !== id);
    if (pending.length !== saved.length) {
      await db.settings.put({ key: 'recurring.pendingConfirms', value: pending, updatedAt: now() });
    }
    await db.recurringRules.delete(id);
  });
}

/**
 * 跳过本期：存在未确认待确认项时跳过该期（移除待确认项，nextRunAt 已指向其后一期）；
 * 否则把下一期顺延到再下一期。已入账流水不受影响。
 */
export async function skipNextOccurrence(ruleId: number): Promise<void> {
  await db.transaction('rw', [db.recurringRules, db.settings], async () => {
    const rule = await db.recurringRules.get(ruleId);
    if (!rule) return;
    const row = await db.settings.get('recurring.pendingConfirms');
    const saved = Array.isArray(row?.value) ? row.value as PendingConfirm[] : [];
    const mine = saved.filter((item) => item.ruleId === ruleId).sort((a, b) => a.dueAt - b.dueAt);
    if (mine.length) {
      const target = mine[0];
      const pending = saved.filter((item) => !(item.ruleId === ruleId && item.dueAt === target.dueAt));
      await db.settings.put({ key: 'recurring.pendingConfirms', value: pending, updatedAt: now() });
      await db.recurringRules.update(ruleId, { skippedOccurrences: [...new Set([...(rule.skippedOccurrences ?? []), target.dueAt])], updatedAt: now() });
      return;
    }
    const next = computeNextRunAt(rule, rule.nextRunAt);
    await db.recurringRules.update(ruleId, { nextRunAt: next, skippedOccurrences: [...new Set([...(rule.skippedOccurrences ?? []), rule.nextRunAt])], updatedAt: now() });
  });
}

/** 全部规则 */
export async function listRules(): Promise<RecurringRule[]> {
  return (await db.recurringRules.toArray()).map((rule) => ({
    ...rule,
    type: recurringRuleType(rule),
  }));
}

/** 汇总：启用的 monthly 规则按收支分开简单合计，并返回启用项数。 */
export async function ruleSummary(): Promise<{
  monthlyTotal: number;
  monthlyIncomeTotal: number;
  enabledCount: number;
}> {
  const rules = await listRules();
  const enabled = rules.filter((r) => r.enabled);
  const monthly = enabled.filter((rule) => rule.freq === 'monthly');
  const totalOf = (type: CategoryKind): number => monthly
    .filter((rule) => recurringRuleType(rule) === type)
    .reduce((sum, rule) => sum + rule.amount * Math.max(1, rule.days.length), 0);
  return {
    monthlyTotal: totalOf('expense'),
    monthlyIncomeTotal: totalOf('income'),
    enabledCount: enabled.length,
  };
}

/** 待确认入账项（amountConfirm 规则到期时产生，由 UI 呈现确认后手动入账） */
export interface PendingConfirm {
  ruleId: number;
  name: string;
  /** 收支类型；旧队列项缺失时按支出兼容 */
  type?: CategoryKind;
  /** 约定金额（分），入账时可修改 */
  amount: number;
  /** 该期原定入账时间 */
  dueAt: number;
  accountId: number;
  categoryId: number;
  /** 转账待确认保留当期目标账户，后续编辑规则不改变该期。 */
  transferToAccountId?: number;
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
      const rule = await db.recurringRules.get(ruleId);
      if (!rule) throw new Error('周期账规则已删除，无法入账');
      if (!rule.enabled) throw new Error('周期账已暂停，启用后才能入账');

      const row = await db.settings.get('recurring.pendingConfirms');
      const saved = Array.isArray(row?.value) ? row.value as PendingConfirm[] : [];
      const index = saved.findIndex((item) => item.ruleId === ruleId && item.dueAt === dueAt);
      if (index < 0) return { booked: false, pending: saved };

      const item = saved[index];
      const pending = saved.filter((_, current) => current !== index);
      await db.settings.put({ key: 'recurring.pendingConfirms', value: pending, updatedAt: now() });
      const common = { amount, occurredAt: item.dueAt, note: `周期账 · ${item.name}` };
      if (item.transferToAccountId != null) {
        await addEntry({ ...common, type: 'transfer', fromAccountId: item.accountId, toAccountId: item.transferToAccountId });
      } else {
        await addEntry({ ...common, type: item.type === 'income' ? 'income' : 'expense', categoryId: item.categoryId, accountId: item.accountId });
      }
      return { booked: true, pending };
    },
  );
}

/**
 * 补跑到期规则（nextRunAt <= asOf 的启用规则，逐期推进直至追平）：
 * - 普通规则：每期按规则收支类型生成账单（occurredAt = 原定入账时间）；
 * - amountConfirm 规则：不入账，收集为 PendingConfirm 返回（通知接口预留）。
 * @returns 本次自动入账笔数与待确认列表
 */
export async function runDueRules(asOf = now()): Promise<{ booked: number; pending: PendingConfirm[] }> {
  return db.transaction(
    'rw',
    [db.entries, db.accounts, db.entryTags, db.recurringRules, db.settings],
    async () => {
      // 布尔值不能作为IndexedDB索引键；统一读取小规模规则表，兼容旧数值标志且排除已结束规则。
      const rules = (await db.recurringRules.toArray())
        .filter(rule => rule.enabled && rule.nextRunAt <= Math.min(asOf, rule.endDate ?? Infinity));
      let booked = 0;
      const pending: PendingConfirm[] = [];
      for (const rule of rules) {
        const horizon = Math.min(asOf, rule.endDate ?? Number.MAX_SAFE_INTEGER);
        let cursor = rule.nextRunAt;
        let guard = 0;
        while (cursor <= horizon && guard < 400) {
          guard++;
          booked += await processOccurrence(rule, cursor, pending);
          cursor = computeNextRunAt(rule, cursor);
        }
        await db.recurringRules.update(rule.id!, { nextRunAt: cursor, updatedAt: now() });
      }
      return { booked, pending: await persistPending(pending) };
    },
  );
}

/** 同一期的写账方式保持一致；调用方必须持有账单、余额、规则与队列的写事务。 */
async function processOccurrence(rule: RecurringRule, dueAt: number, pending: PendingConfirm[]): Promise<number> {
  if (rule.amountConfirm) {
    pending.push({ ruleId: rule.id, name: rule.name, type: recurringRuleType(rule), amount: rule.amount,
      dueAt, accountId: rule.accountId, categoryId: rule.categoryId, transferToAccountId: rule.transferToAccountId });
    return 0;
  }
  const common = { amount: rule.amount, occurredAt: dueAt, note: `周期账 · ${rule.name}` };
  if (rule.transferToAccountId != null) {
    await addEntry({ ...common, type: 'transfer', fromAccountId: rule.accountId, toAccountId: rule.transferToAccountId });
  } else {
    await addEntry({ ...common, type: recurringRuleType(rule), categoryId: rule.categoryId, accountId: rule.accountId });
  }
  return 1;
}

async function persistPending(pending: PendingConfirm[]): Promise<PendingConfirm[]> {
  if (!pending.length) return [];
  const savedRow = await db.settings.get('recurring.pendingConfirms');
  const saved = Array.isArray(savedRow?.value) ? savedRow.value as PendingConfirm[] : [];
  const seen = new Set(saved.map(item => `${item.ruleId}@${item.dueAt}`));
  const fresh = pending.filter(item => !seen.has(`${item.ruleId}@${item.dueAt}`));
  if (fresh.length) await db.settings.put({ key: 'recurring.pendingConfirms', value: [...saved, ...fresh], updatedAt: now() });
  return fresh;
}

function initialHorizon(rule: RecurringRule, asOf: number): number {
  return Math.min(asOf, rule.createdAt, rule.endDate ?? Infinity, rule.nextRunAt - 1);
}

/** 旧规则只检查创建时已漏掉的期次，不回退正常排期，也不重放创建后的暂停时段。 */
export function hasInitialCatchUp(rule: RecurringRule, asOf = now()): boolean {
  if (!rule.enabled || rule.startDate == null || (rule.initialCatchUpThrough ?? -Infinity) >= rule.createdAt) return false;
  const after = Math.max(rule.startDate - 1, rule.initialCatchUpThrough ?? -Infinity);
  return computeNextRunAt(rule, after) <= initialHorizon(rule, asOf);
}

export interface InitialCatchUpPreview {
  rule: RecurringRule;
  revision: string;
  dates: number[];
  skipped: number;
  through: number;
  more: boolean;
}

async function initialPreview(rule: RecurringRule, asOf: number): Promise<InitialCatchUpPreview> {
  const result: InitialCatchUpPreview = { rule, revision: JSON.stringify(rule), dates: [], skipped: 0, through: rule.createdAt, more: false };
  if (!hasInitialCatchUp(rule, asOf)) return result;
  const row = await db.settings.get('recurring.pendingConfirms');
  const pending = (Array.isArray(row?.value) ? row.value as PendingConfirm[] : []).filter(item => item.ruleId === rule.id);
  const excluded = new Set([...(rule.skippedOccurrences ?? []), ...pending.map(item => item.dueAt)]);
  const horizon = initialHorizon(rule, asOf);
  let cursor = computeNextRunAt(rule, Math.max(rule.startDate! - 1, rule.initialCatchUpThrough ?? -Infinity));
  let checked = 0, last = cursor;
  while (cursor <= horizon && checked < 400) {
    checked++; last = cursor;
    let exists = excluded.has(cursor);
    if (!exists) {
      const day = new Date(cursor); day.setHours(0, 0, 0, 0);
      const end = new Date(day); end.setDate(end.getDate() + 1);
      // 包括已删除账单；不能因用户清理记录而重新补回。手动同额记录保守视为已处理。
      const entries = await db.entries.where('occurredAt').between(day.getTime(), end.getTime(), true, false).toArray();
      exists = entries.some(entry => {
        const accountMatches = rule.transferToAccountId != null
          ? entry.type === 'transfer' && entry.fromAccountId === rule.accountId && entry.toAccountId === rule.transferToAccountId
          : entry.type === recurringRuleType(rule) && entry.accountId === rule.accountId && !entry.refundFlag;
        return accountMatches && (entry.note === `周期账 · ${rule.name}`
          || (entry.amount === rule.amount && !entry.note?.startsWith('周期账 · ')));
      });
    }
    if (exists) result.skipped++;
    else result.dates.push(cursor);
    cursor = computeNextRunAt(rule, cursor);
  }
  result.more = cursor <= horizon;
  if (result.more) result.through = last;
  return result;
}

/** 只读预览，按日期索引查重；旧账必须在看到期次后由用户确认补记。 */
export async function previewInitialCatchUp(ruleId: number): Promise<InitialCatchUpPreview> {
  return db.transaction('r', [db.recurringRules, db.entries, db.settings], async () => {
    const rule = await db.recurringRules.get(ruleId);
    if (!rule) throw new Error('周期账规则不存在');
    if (!rule.enabled) throw new Error('周期账已暂停，启用后才能补记');
    return initialPreview(rule, now());
  });
}

/** 预览确认、再次查重、写账/待确认和补记进度同事务提交；并发点击也不会重复写账。 */
export async function applyInitialCatchUp(preview: InitialCatchUpPreview): Promise<{ booked: number; pending: PendingConfirm[] }> {
  return db.transaction('rw', [db.entries, db.accounts, db.entryTags, db.recurringRules, db.settings], async () => {
    const rule = await db.recurringRules.get(preview.rule.id);
    if (!rule) throw new Error('周期账规则不存在');
    if (!rule.enabled) throw new Error('周期账已暂停，启用后才能补记');
    if ((rule.initialCatchUpThrough ?? -Infinity) >= preview.through) return { booked: 0, pending: [] };
    if (JSON.stringify(rule) !== preview.revision) throw new Error('规则已变化，请重新检查漏期');
    const latest = await initialPreview(rule, now());
    const approved = new Set(preview.dates);
    const pending: PendingConfirm[] = [];
    let booked = 0;
    for (const dueAt of latest.dates) {
      if (approved.has(dueAt)) booked += await processOccurrence(rule, dueAt, pending);
    }
    await db.recurringRules.update(rule.id, { initialCatchUpThrough: preview.through, updatedAt: now() });
    return { booked, pending: await persistPending(pending) };
  });
}
