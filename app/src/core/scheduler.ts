/**
 * 拾光 · 启动调度器（scheduler）
 * 应用启动与 visibilitychange 回前台时补跑：
 * 1. 周期账到期入账（recurringRepo.runDueRules；amountConfirm 规则收集为待确认，不入账）；
 * 2. 回收站超保留期物理清除（trashRepo.purgeExpired）；
 * 3. [M3] 快照超 7 天清理（backupRepo.purgeSnapshots）；
 */
import { emit } from './store';
import { listRules, runDueRules, type PendingConfirm } from './repo/recurringRepo';
import { purgeExpired } from './repo/trashRepo';
import { purgeSnapshots } from './repo/backupRepo';
import { getSetting } from './repo/settingsRepo';

/** 一次补跑的结果汇总 */
export interface CatchUpResult {
  /** 周期账自动入账笔数 */
  booked: number;
  /** 待确认入账项（amountConfirm 规则，UI 呈现确认） */
  pending: PendingConfirm[];
  /** 回收站物理清除条数 */
  purged: number;
}

/** 待确认项的订阅回调（M2 由周期账 UI 注册，呈现「待确认」通知） */
type PendingListener = (pending: PendingConfirm[]) => void;
const pendingListeners: PendingListener[] = [];

/**
 * ⚠️ M2-C 最小修复（缺陷：启动时待确认项丢失）：
 * main.ts 中 startScheduler() 先于各 UI 模块 init 执行，首次 catchUp 产生的
 * amountConfirm 待确认项分发时尚无监听者，而 runDueRules 已推进 nextRunAt，
 * 该期将永远无法补回。修复：无监听者时缓存 pending，首个监听者注册时回放。
 */
let bufferedPending: PendingConfirm[] = [];

/**
 * 待确认项由 runDueRules 在“推进规则”的同一事务内持久化。
 * scheduler 只从最新数据库队列回放本上下文尚未分发的 ruleId@dueAt，
 * 不再做第二次合并写入。
 */
const dispatchedPendingKeys = new Set<string>();

/**
 * 注册「待确认入账」监听（接口预留：M2 周期账 UI 注册后，
 * 每次补跑产生待确认项都会回调；注册时回放此前缓存的待确认项）。
 * @returns 取消注册函数
 */
export function onPendingConfirm(cb: PendingListener): () => void {
  pendingListeners.push(cb);
  if (bufferedPending.length) {
    const items = bufferedPending;
    bufferedPending = [];
    cb(items);
  }
  return () => {
    const i = pendingListeners.indexOf(cb);
    if (i >= 0) pendingListeners.splice(i, 1);
  };
}

let running = false;

/**
 * 执行一次补跑（幂等防重入；入账会经 entryRepo 联动余额并 emit 事件）。
 */
export async function catchUp(): Promise<CatchUpResult> {
  if (running) return { booked: 0, pending: [], purged: 0 };
  running = true;
  try {
    const { booked, pending } = await catchUpRecurringRules();
    const purged = await purgeExpired();
    await purgeSnapshots();

    return { booked, pending, purged };
  } finally {
    running = false;
  }
}

/** 保存规则后立即处理到期账；独立于清理任务，避免后台补跑守卫吞掉刚保存的规则。 */
export async function catchUpRecurringRules(): Promise<Pick<CatchUpResult, 'booked' | 'pending'>> {
  const asOf = Date.now();
  let booked = 0;
  // 单笔事务仍限制每规则400期；续批到本次检查时刻，离开或失败后由持久化游标接续。
  for (;;) {
    booked += (await runDueRules(asOf)).booked;
    if (!(await listRules()).some(rule => rule.enabled && rule.nextRunAt <= Math.min(asOf, rule.endDate ?? Infinity))) break;
  }
  if (booked > 0) emit('entries-changed');
  const saved = await getSetting('recurring.pendingConfirms');
  const dispatch = saved.filter((item) => {
    const key = `${item.ruleId}@${item.dueAt}`;
    if (dispatchedPendingKeys.has(key)) return false;
    dispatchedPendingKeys.add(key);
    return true;
  });
  if (dispatch.length) {
    if (pendingListeners.length) for (const cb of pendingListeners) cb(dispatch);
    else bufferedPending.push(...dispatch);
  }
  return { booked, pending: dispatch };
}

/**
 * 启动调度器：立即补跑一次，并监听回前台事件继续补跑。
 * 在 main.ts 中 seed 之后调用一次。
 */
export async function startScheduler(): Promise<CatchUpResult> {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void catchUp();
  });
  return catchUp();
}
