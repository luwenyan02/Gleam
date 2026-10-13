/**
 * 拾光 · 共享 pickList 浮层选择器
 * 底部滑入面板，支持标题、搜索、分组、选中高亮，
 * 供全 App 所有列表选择场景（账户/标签/商家/分类/联系人等）统一使用。
 *
 * 对外契约：openPickList(opts)，回调式 API（选中 → onPick，取消 → onCancel）。
 * 样式见 ./pickList.css，动画参照 dateTimeWheel 的 close 模式（移除 .open → 延时移除 DOM）。
 */
import { iconHtml } from '../assets/icons';
import { esc } from '../core/esc';
import './pickList.css';
import { manageOverlay } from './overlay';

/* ── 公共类型 ─────────────────────── */

export interface PickListItem {
  value: string | number;
  label: string;
  /** 分组名；相邻同组项前渲染一个灰色小字标题行（类似 optgroup label） */
  group?: string;
  /** 图标 id（对应 assets/icons 中的 symbol id，如 'ic-wallet'） */
  icon?: string;
  /** 右侧辅助文案（如账户余额），可选 */
  note?: string;
}

export interface PickListOptions {
  /** 浮层挂载容器（页面容器或 sheet 容器），.picker-mask 以 position:absolute 相对于它 */
  container: HTMLElement;
  /** 面板标题（可选） */
  title?: string;
  /** 选项列表 */
  items: PickListItem[];
  /** 当前选中值（高亮 + 勾号） */
  selected?: string | number;
  /** 是否显示搜索栏（默认 items.length > 15 时自动开启） */
  searchable?: boolean;
  /** 搜索框右侧的图标操作；执行前先关闭选择浮层。 */
  searchAction?: { icon: string; label: string; onClick(): void };
  /** 选中回调 */
  onPick(value: string | number, label: string): void;
  /** 取消回调（点遮罩区域） */
  onCancel?(): void;
}

/* ── 实现 ─────────────────────────── */

/**
 * 打开列表选择浮层。
 *
 * 在 container 内 append `.picker-mask`（遮罩 + 底部面板），
 * 选中某项 → 调 onPick → 关闭；点遮罩 → 调 onCancel → 关闭。
 */
export function openPickList(opts: PickListOptions): void {
  const { container, items, selected, onPick, onCancel } = opts;
  const searchable = opts.searchable ?? items.length > 15;

  /* ── 构建 DOM ── */
  const mask = document.createElement('div');
  mask.className = 'picker-mask';

  const panel = document.createElement('div');
  panel.className = 'picker-panel';

  // 标题
  if (opts.title) {
    const h = document.createElement('h4');
    h.className = 'picker-title';
    h.textContent = opts.title;
    panel.appendChild(h);
  }

  // 搜索栏
  let searchInput: HTMLInputElement | null = null;
  if (searchable) {
    const wrap = document.createElement('div');
    wrap.className = 'picker-search';
    searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.placeholder = '搜索…';
    searchInput.setAttribute('aria-label', '搜索选项');
    wrap.appendChild(searchInput);
    if (opts.searchAction) {
      const action = document.createElement('button');
      action.className = 'icon-btn picker-search-action';
      action.type = 'button';
      action.setAttribute('aria-label', opts.searchAction.label);
      action.title = opts.searchAction.label;
      action.innerHTML = iconHtml(opts.searchAction.icon, 18);
      action.addEventListener('click', () => { close(); opts.searchAction!.onClick(); });
      wrap.appendChild(action);
    }
    panel.appendChild(wrap);
  }

  // 列表区
  const listEl = document.createElement('div');
  listEl.className = 'picker-list';
  listEl.setAttribute('role', 'listbox');
  if (opts.title) listEl.setAttribute('aria-label', opts.title);
  panel.appendChild(listEl);

  /* ── 渲染列表（搜索 filter 时重调用） ── */
  function renderList(filter?: string): void {
    const kw = filter?.toLowerCase();
    const filtered = kw
      ? items.filter((it) => it.label.toLowerCase().includes(kw))
      : items;

    let html = '';
    let lastGroup = '';
    for (const item of filtered) {
      // 分组标题行
      if (item.group && item.group !== lastGroup) {
        lastGroup = item.group;
        html += `<div class="picker-group-title">${esc(item.group)}</div>`;
      }
      const isSel = item.value === selected;
      html += `<button class="picker-item${isSel ? ' selected' : ''}" data-value="${esc(String(item.value))}" type="button" role="option" aria-selected="${isSel}">`;
      if (item.icon) html += `<span class="picker-item-icon">${iconHtml(item.icon, 18)}</span>`;
      html += `<span class="picker-item-label">${esc(item.label)}</span>`;
      if (item.note) html += `<span class="picker-item-note">${esc(item.note)}</span>`;
      if (isSel) html += `<span class="picker-item-check">\u2713</span>`;
      html += `</button>`;
    }
    listEl.innerHTML = html;
  }
  renderList();

  // 搜索事件
  if (searchInput) {
    searchInput.addEventListener('input', () => renderList(searchInput!.value.trim()));
  }

  mask.appendChild(panel);
  container.appendChild(mask);

  /* ── 底部滑入动画 ── */
  requestAnimationFrame(() => panel.classList.add('open'));

  /* ── 关闭：panel 滑出 → 200ms 后移除 DOM（参照 dateTimeWheel 的 close 模式） ── */
  function close(): void {
    releaseOverlay();
    panel.classList.remove('open');
    setTimeout(() => mask.remove(), 200);
  }

  mask.setAttribute('aria-label',opts.title ?? '选择一项');
  const releaseOverlay = manageOverlay(mask, () => { close(); onCancel?.(); });

  /* ── 事件绑定 ── */
  mask.addEventListener('click', (e) => {
    // 点遮罩区（非 panel）→ 取消
    if (e.target === mask) {
      close();
      onCancel?.();
      return;
    }
    // 点选项行 → 选中
    const btn = (e.target as HTMLElement).closest<HTMLElement>('.picker-item');
    if (!btn) return;
    const val = btn.dataset.value!;
    const item = items.find((it) => String(it.value) === val);
    if (!item) return;
    close();
    onPick(item.value, item.label);
  });
}
