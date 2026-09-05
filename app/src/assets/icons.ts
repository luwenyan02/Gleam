/**
 * 拾光 · SVG 图标库
 * 原样迁移自原型 index.html（L410-466），共 53 枚 symbol，id 与原型一致。
 * 使用方式：`<svg class="ic"><use href="#ic-wallet"/></svg>`
 */

/** 全部图标 id（供分类管理图标选择器等场景枚举） */
export const ICON_IDS = [
  'ic-home', 'ic-chart', 'ic-book', 'ic-user', 'ic-plus', 'ic-close', 'ic-left', 'ic-right',
  'ic-search', 'ic-bowl', 'ic-cup', 'ic-cart', 'ic-bus', 'ic-car', 'ic-metro', 'ic-house',
  'ic-film', 'ic-med', 'ic-cap', 'ic-gift', 'ic-wallet', 'ic-card', 'ic-pay', 'ic-brief',
  'ic-pen', 'ic-camera', 'ic-pulse', 'ic-cloud', 'ic-file', 'ic-lock', 'ic-swap', 'ic-coin',
  'ic-set', 'ic-cal', 'ic-bolt', 'ic-mic', 'ic-repeat', 'ic-del', 'ic-loan-in', 'ic-loan-out',
  'ic-repay', 'ic-collect', 'ic-sun', 'ic-moon', 'ic-fruit', 'ic-cone', 'ic-park', 'ic-shirt',
  'ic-bottle', 'ic-tag', 'ic-shop', 'ic-trash', 'ic-eye',
  'ic-ai',
] as const;

export type IconId = (typeof ICON_IDS)[number];

const SPRITE = `<svg width="0" height="0" style="position:absolute" aria-hidden="true">
  <defs>
    <symbol id="ic-home" viewBox="0 0 24 24"><path d="M4 11.2 12 4.5l8 6.7V19a1 1 0 0 1-1 1h-4.6v-5.2H9.6V20H5a1 1 0 0 1-1-1z"/></symbol>
    <symbol id="ic-chart" viewBox="0 0 24 24"><path d="M5.5 20v-8M12 20V5M18.5 20v-5.5M3.5 20h17"/></symbol>
    <symbol id="ic-book" viewBox="0 0 24 24"><path d="M5 5A2 2 0 0 1 7 3h12v15.5H7A2 2 0 0 0 5 20.5z"/><path d="M5 18.5A2 2 0 0 1 7 16.5h12"/></symbol>
    <symbol id="ic-user" viewBox="0 0 24 24"><circle cx="12" cy="8" r="3.5"/><path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5"/></symbol>
    <symbol id="ic-plus" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></symbol>
    <symbol id="ic-close" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></symbol>
    <symbol id="ic-left" viewBox="0 0 24 24"><path d="M14.5 5.5 8 12l6.5 6.5"/></symbol>
    <symbol id="ic-right" viewBox="0 0 24 24"><path d="M9.5 5.5 16 12l-6.5 6.5"/></symbol>
    <symbol id="ic-search" viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="m15.8 15.8 4.2 4.2"/></symbol>
    <symbol id="ic-bowl" viewBox="0 0 24 24"><path d="M4 11.5h16a8 8 0 0 1-5 7.2v1.3H9v-1.3a8 8 0 0 1-5-7.2z"/><path d="m9.5 7.5 1-4M14 7.5l1.5-3.5"/></symbol>
    <symbol id="ic-cup" viewBox="0 0 24 24"><path d="M5 9h11v5.5a5 5 0 0 1-5 5h-1a5 5 0 0 1-5-5z"/><path d="M16 10h1.5a2.5 2.5 0 0 1 0 5H16M8.5 6V4M12 6V4"/></symbol>
    <symbol id="ic-cart" viewBox="0 0 24 24"><circle cx="9.5" cy="20" r="1.3"/><circle cx="17" cy="20" r="1.3"/><path d="M3 4h2.2l2.2 11.5h10.4L20 8H6.3"/></symbol>
    <symbol id="ic-bus" viewBox="0 0 24 24"><rect x="4.5" y="4" width="15" height="12.5" rx="2.5"/><path d="M4.5 10h15M8 20.5v-2M16 20.5v-2"/></symbol>
    <symbol id="ic-car" viewBox="0 0 24 24"><path d="M5 16.5V12l2.2-5h9.6L19 12v4.5M5 12h14"/><circle cx="8" cy="16.5" r="1.4"/><circle cx="16" cy="16.5" r="1.4"/></symbol>
    <symbol id="ic-metro" viewBox="0 0 24 24"><rect x="6" y="3.5" width="12" height="13.5" rx="3"/><path d="M6 11.5h12M8 20.5l1.5-2.5M16 20.5l-1.5-2.5M9.8 14.5h.01M14.2 14.5h.01"/></symbol>
    <symbol id="ic-house" viewBox="0 0 24 24"><path d="M4.5 11.5 12 5l7.5 6.5"/><path d="M6.5 10.5V19h11v-8.5M10.5 19v-4.5h3V19"/></symbol>
    <symbol id="ic-film" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="m10.3 9.3 4.4 2.7-4.4 2.7z"/></symbol>
    <symbol id="ic-med" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M12 8.5v7M8.5 12h7"/></symbol>
    <symbol id="ic-cap" viewBox="0 0 24 24"><path d="M3 9.5 12 5l9 4.5-9 4.5z"/><path d="M6.5 11.8v3.9c0 1.2 2.4 2.3 5.5 2.3s5.5-1.1 5.5-2.3v-3.9"/></symbol>
    <symbol id="ic-gift" viewBox="0 0 24 24"><path d="M4.5 8h15v3.5h-15zM6 11.5V19a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-7.5M12 8v12"/><path d="M12 8C12 5.5 10 4 8.8 4.8 7.6 5.6 8.5 8 12 8zm0 0c0-2.5 2-4 3.2-3.2C16.4 5.6 15.5 8 12 8z"/></symbol>
    <symbol id="ic-wallet" viewBox="0 0 24 24"><path d="M4 8a2 2 0 0 1 2-2h12.5v3.2H20a.8.8 0 0 1 .8.8v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><path d="M15.5 13.6h2"/></symbol>
    <symbol id="ic-card" viewBox="0 0 24 24"><rect x="3.5" y="6" width="17" height="12.5" rx="2"/><path d="M3.5 10.5h17M7 15h4"/></symbol>
    <symbol id="ic-pay" viewBox="0 0 24 24"><rect x="7" y="3.5" width="10" height="17" rx="2.2"/><path d="M11 17.5h2M9.5 9.5l2.5 2.7 2.5-2.7M12 12.2v3"/></symbol>
    <symbol id="ic-brief" viewBox="0 0 24 24"><rect x="4" y="8" width="16" height="11" rx="2"/><path d="M9 8V6.5A1.5 1.5 0 0 1 10.5 5h3A1.5 1.5 0 0 1 15 6.5V8M4 13h16"/></symbol>
    <symbol id="ic-pen" viewBox="0 0 24 24"><path d="m5 19 1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L9 18zM14.5 6.5l3 3"/></symbol>
    <symbol id="ic-camera" viewBox="0 0 24 24"><rect x="3.5" y="7" width="17" height="12" rx="2.5"/><circle cx="12" cy="13" r="3.4"/><path d="M8.5 7l1.3-2h4.4L15.5 7"/></symbol>
    <symbol id="ic-pulse" viewBox="0 0 24 24"><path d="M3.5 12.5h4L10 6l4 12 2.5-5.5h4"/></symbol>
    <symbol id="ic-cloud" viewBox="0 0 24 24"><path d="M7 18.5a4 4 0 0 1-.4-8A5.5 5.5 0 0 1 17 9a4.2 4.2 0 0 1 .6 8.3"/><path d="M12 20v-6M9.6 16.2 12 13.8l2.4 2.4"/></symbol>
    <symbol id="ic-file" viewBox="0 0 24 24"><path d="M6.5 3.5h7L18.5 8v12.5h-12zM13.5 3.5V8h5"/><path d="M9.5 13h5M9.5 16h5"/></symbol>
    <symbol id="ic-lock" viewBox="0 0 24 24"><rect x="5.5" y="10.5" width="13" height="9.5" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5M12 14.5v2"/></symbol>
    <symbol id="ic-swap" viewBox="0 0 24 24"><path d="M7 4.5 3.5 8 7 11.5M3.5 8h13M17 12.5 20.5 16 17 19.5M20.5 16h-13"/></symbol>
    <symbol id="ic-coin" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="m9.3 8.8 2.7 3.2 2.7-3.2M12 12v4M9.8 13.4h4.4"/></symbol>
    <symbol id="ic-set" viewBox="0 0 24 24"><path d="M4.5 8h2.8M11.7 8h7.8M4.5 16h7.8M16.7 16h2.8"/><circle cx="9.5" cy="8" r="2.2"/><circle cx="14.5" cy="16" r="2.2"/></symbol>
    <symbol id="ic-cal" viewBox="0 0 24 24"><rect x="4.5" y="5.5" width="15" height="14" rx="2"/><path d="M4.5 10h15M8.5 3.5v3.5M15.5 3.5v3.5"/></symbol>
    <symbol id="ic-bolt" viewBox="0 0 24 24"><path d="M13 3.5 6 13.5h5L11 20.5l7-10h-5z"/></symbol>
    <symbol id="ic-mic" viewBox="0 0 24 24"><rect x="9.5" y="3.5" width="5" height="10.5" rx="2.5"/><path d="M6.5 11.5a5.5 5.5 0 0 0 11 0M12 17v3.5M9 20.5h6"/></symbol>
    <symbol id="ic-repeat" viewBox="0 0 24 24"><path d="m17.5 4.5 2.5 2.5-2.5 2.5M4.5 12v-1.5A3.5 3.5 0 0 1 8 7h12M6.5 19.5 4 17l2.5-2.5M19.5 12v1.5A3.5 3.5 0 0 1 16 17H4"/></symbol>
    <symbol id="ic-del" viewBox="0 0 24 24"><path d="M8.5 5h10A1.5 1.5 0 0 1 20 6.5v11a1.5 1.5 0 0 1-1.5 1.5h-10L3 12z"/><path d="m11 9.5 5 5M16 9.5l-5 5"/></symbol>
    <symbol id="ic-loan-in" viewBox="0 0 24 24"><path d="M12 3.5v9M12 12.5 15.5 9M12 12.5 8.5 9"/><path d="M4.5 14.5v3A2.5 2.5 0 0 0 7 20h10a2.5 2.5 0 0 0 2.5-2.5v-3"/></symbol>
    <symbol id="ic-loan-out" viewBox="0 0 24 24"><path d="M12 12.5v-9M12 3.5 15.5 7M12 3.5 8.5 7"/><path d="M4.5 14.5v3A2.5 2.5 0 0 0 7 20h10a2.5 2.5 0 0 0 2.5-2.5v-3"/></symbol>
    <symbol id="ic-repay" viewBox="0 0 24 24"><path d="M9 14 4.5 9.5 9 5"/><path d="M4.5 9.5H14a5.5 5.5 0 0 1 0 11h-4"/></symbol>
    <symbol id="ic-collect" viewBox="0 0 24 24"><circle cx="12" cy="6.8" r="3"/><path d="m10.8 5.4 1.2 1.4 1.2-1.4M12 6.8v1.8"/><path d="M3.5 13.5h17M4.5 13.5 6 18.5a2 2 0 0 0 1.9 1.5h8.2a2 2 0 0 0 1.9-1.5l1.5-5"/></symbol>
    <symbol id="ic-sun" viewBox="0 0 24 24"><circle cx="12" cy="13.5" r="3.8"/><path d="M12 5V3.5M6 7.5 5 6.5M18 7.5l1-1M4.5 13.5h-2M21.5 13.5h-2M5 19.5h14"/></symbol>
    <symbol id="ic-moon" viewBox="0 0 24 24"><path d="M19.5 13.8A7.3 7.3 0 1 1 10.2 4.5a5.8 5.8 0 0 0 9.3 9.3z"/></symbol>
    <symbol id="ic-fruit" viewBox="0 0 24 24"><path d="M9 8.2c-2.6 0-4.3 2.1-4.3 4.8 0 3.4 2.3 6.9 4.4 6.9.9 0 1.5-.5 2.9-.5s2 .5 2.9.5c2.1 0 4.4-3.5 4.4-6.9 0-2.7-1.7-4.8-4.3-4.8-1.1 0-2 .5-3 .5s-1.9-.5-3-.5z"/><path d="M12 8.7c0-2.2 1.4-3.7 3.4-4.2"/></symbol>
    <symbol id="ic-cone" viewBox="0 0 24 24"><path d="M8.2 11.5h7.6L12 20.5z"/><path d="M8.2 11.5a4 4 0 1 1 7.6 0"/></symbol>
    <symbol id="ic-park" viewBox="0 0 24 24"><rect x="4.8" y="4.2" width="14.4" height="15.6" rx="3.2"/><path d="M10 16.5v-9h3.2a2.4 2.4 0 0 1 0 4.8H10"/></symbol>
    <symbol id="ic-shirt" viewBox="0 0 24 24"><path d="M8.5 4.5 3.8 7.4l1.7 3 2-1v10.1h9V9.4l2 1 1.7-3-4.7-2.9a3.5 3.5 0 0 1-7 0z"/></symbol>
    <symbol id="ic-bottle" viewBox="0 0 24 24"><path d="M9.5 8V5.5h5V8M8 5.5h8"/><rect x="7.5" y="8" width="9" height="12" rx="2"/><path d="M9.8 12.5h4.4"/></symbol>
    <symbol id="ic-tag" viewBox="0 0 24 24"><path d="M4 4.5h7.5a1.5 1.5 0 0 1 1.05.44L20 12.4a1.5 1.5 0 0 1 0 2.1L14.5 20a1.5 1.5 0 0 1-2.1 0L4.44 12.05A1.5 1.5 0 0 1 4 11z"/><circle cx="9" cy="9" r="1.4"/></symbol>
    <symbol id="ic-shop" viewBox="0 0 24 24"><path d="M4.5 9.5 6 4.5h12l1.5 5M3.5 9.5h17M6 9.5V19a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V9.5M10 20v-5.5h4V20"/></symbol>
    <symbol id="ic-trash" viewBox="0 0 24 24"><path d="M4.5 6.8h15M9.5 6.8V5a1.5 1.5 0 0 1 1.5-1.5h2A1.5 1.5 0 0 1 14.5 5v1.8M6.5 6.8l1 12.7a1 1 0 0 0 1 .9h7a1 1 0 0 0 1-.9l1-12.7M10 10.8v5.4M14 10.8v5.4"/></symbol>
    <symbol id="ic-eye" viewBox="0 0 24 24"><path d="M3.5 12S6.8 6.2 12 6.2 20.5 12 20.5 12 17.2 17.8 12 17.8 3.5 12 3.5 12z"/><circle cx="12" cy="12" r="2.6"/></symbol>
    <symbol id="ic-ai" viewBox="0 0 24 24"><circle cx="12" cy="4.5" r="1.3"/><path d="M12 5.8v2.7"/><rect x="5" y="8.5" width="14" height="10" rx="2.5"/><path d="M9.5 12.5v1.8M14.5 12.5v1.8M2.8 12.5v3M21.2 12.5v3"/></symbol>
  </defs>
</svg>`;

/**
 * 把图标 sprite 注入 document.body 开头（幂等，可重复调用）。
 * 必须在任何页面渲染前调用一次。
 */
export function injectIcons(doc: Document = document): void {
  if (doc.getElementById('gleam-icon-sprite')) return;
  const holder = doc.createElement('div');
  holder.id = 'gleam-icon-sprite';
  holder.style.display = 'contents';
  holder.innerHTML = SPRITE;
  doc.body.prepend(holder);
}

/**
 * 生成一个 `<svg class="ic"><use/></svg>` 图标的 HTML 片段。
 * @param id 图标 id（如 'ic-wallet'）
 * @param size 可选，覆盖默认 20px 尺寸
 */
export function iconHtml(id: IconId | string, size?: number): string {
  const style = size ? ` style="width:${size}px;height:${size}px"` : '';
  return `<svg class="ic"${style} aria-hidden="true"><use href="#${id}"/></svg>`;
}
