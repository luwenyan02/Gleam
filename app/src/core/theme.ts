/**
 * 拾光 · 主题模式（深色模式三档：light / dark / system）
 * 深色时在 <html> 设 data-theme="dark"（浅色态不设属性），
 * tokens.css 按该属性覆写种子变量，全部 color-mix 派生色自动跟随；
 * 'system' 档由 matchMedia('(prefers-color-scheme: dark)') 解析并监听系统切换。
 * 同步维护 <meta name="theme-color"> 与 localStorage['gleam-theme'] 镜像
 * （镜像存解析前的模式值，index.html 内联脚本冷启动读镜像防闪白）。
 */
import { getSetting } from './repo/settingsRepo';
import { on } from './store';

const STORAGE_KEY = 'gleam-theme';
/** 状态栏/浏览器框架色：亮色用品牌主色，暗色用暗背景色 */
const META_LIGHT = '#D66A2C';
const META_DARK = '#1C1712';

const media = window.matchMedia('(prefers-color-scheme: dark)');

/** 读取 'theme.mode' 并应用：设/删 data-theme、更新 theme-color、写 localStorage 镜像 */
export async function applyTheme(): Promise<void> {
  const mode = await getSetting('theme.mode');
  try { localStorage.setItem(STORAGE_KEY, mode); } catch { /* 隐私模式下写入可能失败，忽略 */ }
  const dark = mode === 'dark' || (mode === 'system' && media.matches);
  const rootEl = document.documentElement;
  if (dark) rootEl.setAttribute('data-theme', 'dark');
  else rootEl.removeAttribute('data-theme');
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    ?.setAttribute('content', dark ? META_DARK : META_LIGHT);
}

/** 初始化主题：应用一次并监听系统配色与设置变化（main.ts 调用一次） */
export function initTheme(): void {
  void applyTheme();
  media.addEventListener('change', () => void applyTheme());
  on('settings-changed', () => void applyTheme());
}
