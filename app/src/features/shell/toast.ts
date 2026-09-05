/**
 * 拾光 · Toast 工具
 * 轻提示，自动消失。DOM 节点由 shell 挂载（#toast）。
 */

let timer: number | undefined;

/**
 * 显示一条轻提示。
 * @param msg 文案
 * @param duration 显示时长（毫秒），默认 2200
 */
export function showToast(msg: string, duration = 2200): void {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  if (timer) clearTimeout(timer);
  timer = window.setTimeout(() => el.classList.remove('show'), duration);
}
