/**
 * 拾光 · 极简发布订阅事件总线
 * repo 写操作完成后自动 emit 对应事件；UI 模块 on 订阅后刷新自身。
 *
 * 约定事件名（新增事件请先在 AppEvent 中登记）：
 * - 'entries-changed'    账单增删改/恢复/批量导入
 * - 'accounts-changed'   账户或余额变化（含账单联动）
 * - 'categories-changed' 分类变化
 * - 'budgets-changed'    预算变化
 * - 'life-changed'       生活记录/习惯变化
 * - 'settings-changed'   设置变化
 * - 'route-changed'      路由（页/子页）变化
 */

export type AppEvent =
  | 'entries-changed'
  | 'accounts-changed'
  | 'categories-changed'
  | 'budgets-changed'
  | 'credit-changed'
  | 'life-changed'
  | 'settings-changed'
  | 'route-changed';

type Handler = (payload?: unknown) => void;

const handlers = new Map<AppEvent, Set<Handler>>();

/**
 * 订阅事件。
 * @returns 取消订阅函数
 */
export function on(event: AppEvent, cb: Handler): () => void {
  let set = handlers.get(event);
  if (!set) {
    set = new Set();
    handlers.set(event, set);
  }
  set.add(cb);
  return () => set.delete(cb);
}

/**
 * 触发事件（同步逐个调用订阅者，单个订阅者异常不阻断其他订阅者）。
 * @param payload 可选负载，如变更的实体 id
 */
export function emit(event: AppEvent, payload?: unknown): void {
  const set = handlers.get(event);
  if (!set) return;
  for (const cb of [...set]) {
    try {
      cb(payload);
    } catch (err) {
      console.error(`[store] handler for "${event}" failed:`, err);
    }
  }
}
