/**
 * 拾光 · 启动调度器（scheduler）
 * 应用启动与 visibilitychange 回前台时补跑：
 * 1. 周期账到期入账（recurringRepo.runDueRules；amountConfirm 规则收集为待确认，不入账）；
 * 2. 回收站超保留期物理清除（trashRepo.purgeExpired）；
 * 3. [M3] 快照超 7 天清理（backupRepo.purgeSnapshots）；
 * 4. [M3] 自动备份到期检测（backup.auto + backup.lastBackupAt，UI 轻提醒）。
 */
import { emit } from './store';
import { runDueRules, type PendingConfirm } from './repo/recurringRepo';
import { purgeExpired } from './repo/trashRepo';
import { purgeSnapshots } from './repo/backupRepo';
import { getSetting, setSetting } from './repo/settingsRepo';

/** 一次补跑的结果汇总 */
export interface CatchUpResult {
  /** 周期账自动入账笔数 */
  booked: number;
  /** 待确认入账项（amountConfirm 规则，UI 呈现确认） */
  pending: PendingConfirm[];
  /** 回收站物理清除条数 */
  purged: number;
  /** [M3] 自动备份已到期（backup.auto 非 off 且距上次备份超过周期） */
  backupDue: boolean;
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
 * [M3 修复] 待确认项持久化（M2 遗留：仅存内存，刷新丢失）：
 * runDueRules 产生新项时合并写入 settings kv 'recurring.pendingConfirms'（按
 * ruleId@dueAt 去重）；首次 catchUp 把已存项一并回放给监听者，后续只分发新增；
 * 确认/入账后由周期账 UI 调 savePendingConfirms 同步移除。
 */
let replayedSaved = false;

/** [M3 修复] 周期账 UI 确认/移除待确认项后，回写剩余队列 */
export async function savePendingConfirms(queue: PendingConfirm[]): Promise<void> {
  await setSetting('recurring.pendingConfirms', queue);
}

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
  if (running) return { booked: 0, pending: [], purged: 0, backupDue: false };
  running = true;
  try {
    const { booked, pending } = await runDueRules();
    const purged = await purgeExpired();
    await purgeSnapshots(); // [M3] 清理超 7 天的恢复/导入前快照
    if (booked > 0) emit('entries-changed');

    // [M3 修复] 新产生的待确认项合并持久化；首次补跑连同已存项一并回放
    const saved = await getSetting('recurring.pendingConfirms');
    const seen = new Set(saved.map((p) => `${p.ruleId}@${p.dueAt}`));
    const fresh = pending.filter((p) => !seen.has(`${p.ruleId}@${p.dueAt}`));
    const merged = [...saved, ...fresh];
    if (fresh.length) await setSetting('recurring.pendingConfirms', merged);
    const dispatch = replayedSaved ? fresh : merged;
    replayedSaved = true;
    if (dispatch.length) {
      if (pendingListeners.length) for (const cb of pendingListeners) cb(dispatch);
      else bufferedPending.push(...dispatch); // 见上方 M2-C 最小修复说明
    }

    // [M3] 自动备份到期检测：从未备份（lastBackupAt=0）也视为到期
    let backupDue = false;
    const auto = await getSetting('backup.auto');
    if (auto !== 'off') {
      const last = await getSetting('backup.lastBackupAt');
      const span = auto === 'daily' ? 86400000 : 7 * 86400000;
      backupDue = Date.now() - last >= span;
    }
    return { booked, pending: dispatch, purged, backupDue };
  } finally {
    running = false;
  }
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
