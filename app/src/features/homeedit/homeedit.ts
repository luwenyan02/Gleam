/**
 * 拾光 · 首页自定义（features/homeedit，PRD 4.15）
 * 四个首页模块的显示开关，读写 settings 'home.modules'（home.ts 消费重渲染）；
 * 「记一笔」按钮与底部导航不可隐藏（仅说明文案）；拖动排序不在本期范围。
 * 视觉结构与原型 index.html #page-homeedit（L1016-1031）一致。
 */
import { iconHtml } from '../../assets/icons';
import { getSetting, setSetting } from '../../core/repo/settingsRepo';
import { registerSubpage } from '../shell/router';
import { showToast } from '../shell/toast';

/** 首页模块清单（key 对应 'home.modules' 字段） */
const MODULES = [
  { key: 'month', icon: 'ic-coin', name: '本月概览', note: '支出 / 收入 / 预算进度' },
  { key: 'quick', icon: 'ic-bolt', name: '快捷入口', note: '速记 / 明细 / 日历…' },
  { key: 'today', icon: 'ic-book', name: '今日流水', note: '含生活记录' },
  { key: 'past', icon: 'ic-cal', name: '往日回顾', note: '近几日账单' },
] as const;

type ModuleKey = (typeof MODULES)[number]['key'];

/** 注册首页自定义子页（覆盖 sp-home-custom 占位），main.ts 调用一次 */
export function initHomeEdit(): void {
  registerSubpage('sp-home-custom', {
    title: '首页自定义',
    render(el) {
      el.innerHTML = `
        <p class="sub" style="padding:0 2px 10px">选择首页要显示的模块，关闭后随时可以再打开 · 完整版支持拖动调整顺序</p>
        <section class="card list" id="homeedit-list" aria-label="首页模块开关">
          ${MODULES.map((m) => `
            <div class="row" data-mod="${m.key}">
              <span class="e-ic sm">${iconHtml(m.icon, 17)}</span>
              <div class="e-main"><p class="e-title">${m.name}</p><p class="e-meta">${m.note}</p></div>
              <button class="switch" data-sw="${m.key}" role="switch" aria-checked="true" aria-label="${m.name}"></button>
            </div>`).join('')}
        </section>
        <p class="tiny" style="text-align:center;margin-top:12px">「记一笔」按钮与底部导航不可隐藏</p>`;

      async function sync(): Promise<void> {
        if (!el.isConnected) return;
        const mods = await getSetting('home.modules');
        for (const sw of el.querySelectorAll<HTMLElement>('[data-sw]')) {
          const onNow = mods[sw.dataset.sw as ModuleKey] !== false;
          sw.classList.toggle('on', onNow);
          sw.setAttribute('aria-checked', String(onNow));
        }
      }

      el.addEventListener('click', (e) => {
        const sw = (e.target as HTMLElement).closest<HTMLElement>('[data-sw]');
        if (!sw) return;
        const key = sw.dataset.sw as ModuleKey;
        void getSetting('home.modules').then(async (mods) => {
          const next = !(mods[key] !== false);
          await setSetting('home.modules', { ...mods, [key]: next });
          await sync();
          const name = MODULES.find((m) => m.key === key)!.name;
          showToast(next ? `「${name}」已恢复显示` : `「${name}」已从首页隐藏，随时可再打开`);
        });
      });

      void sync();
    },
  });
}
