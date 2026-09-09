import { iconHtml } from '../../assets/icons';
import { getSetting, setSetting } from '../../core/repo/settingsRepo';
import { getHomeLayout, saveHomeLayout, HOME_SERVICES, type HomeModule, type HomeService } from '../../core/repo/homeLayoutRepo';
import { registerSubpage } from '../shell/router';
import { showToast } from '../shell/toast';

const MODULES = {
  month: { icon: 'ic-coin', name: '本月概览' }, quick: { icon: 'ic-bolt', name: '快捷入口' },
  today: { icon: 'ic-book', name: '今日流水' }, past: { icon: 'ic-cal', name: '往日回顾' },
} as const;
function arrows(key: string, name: string, index: number, total: number, group: string): string {
  return `<span class="home-order"><button data-move="${key}" data-group="${group}" data-step="-1" aria-label="上移${name}" ${index === 0 ? 'disabled' : ''}>↑</button><button data-move="${key}" data-group="${group}" data-step="1" aria-label="下移${name}" ${index === total - 1 ? 'disabled' : ''}>↓</button></span>`;
}
export function initHomeEdit(): void {
  registerSubpage('sp-home-custom', {
    title: '首页自定义',
    render(el) {
      let busy = false;
      async function refresh(): Promise<void> {
        const [mods, layout] = await Promise.all([getSetting('home.modules'), getHomeLayout()]);
        if (!el.isConnected) return;
        el.innerHTML = `<h3 class="card-title">首页模块</h3><section class="card list" id="homeedit-list" aria-label="首页模块开关">
          ${layout.order.map((key, index) => {
            const item = MODULES[key]; const enabled = mods[key] !== false;
            return `<div class="row" data-mod="${key}"><span class="e-ic sm">${iconHtml(item.icon, 17)}</span><span class="e-main">${item.name}</span>${arrows(key, item.name, index, layout.order.length, 'order')}<button class="switch${enabled ? ' on' : ''}" data-sw="${key}" role="switch" aria-checked="${enabled}" aria-label="${item.name}"></button></div>`;
          }).join('')}</section>
          <h3 class="card-title">快捷入口（最多五个）</h3>
          <section class="card list" aria-label="快捷入口配置">
            ${[...layout.quick, ...HOME_SERVICES.map(s => s.key).filter(key => !layout.quick.includes(key))].map(key => {
              const item = HOME_SERVICES.find(s => s.key === key)!; const index = layout.quick.indexOf(key); const enabled = index >= 0;
              return `<div class="row"><span class="e-ic sm">${iconHtml(item.icon, 17)}</span><span class="e-main">${item.name}</span>${enabled ? arrows(key, item.name, index, layout.quick.length, 'quick') : ''}<button class="switch${enabled ? ' on' : ''}" data-quick="${key}" role="switch" aria-checked="${enabled}" aria-label="快捷${item.name}"></button></div>`;
            }).join('')}
          </section><p class="tiny">其余功能从首页「全部」访问。</p>`;
      }
      el.addEventListener('click', event => {
        const target = (event.target as HTMLElement).closest<HTMLElement>('[data-sw], [data-quick], [data-move]');
        if (!target || busy) return;
        busy = true;
        void (async () => {
          const layout = await getHomeLayout();
          if (target.dataset.sw) {
            const key = target.dataset.sw as HomeModule; const mods = await getSetting('home.modules');
            await setSetting('home.modules', { ...mods, [key]: mods[key] === false });
          } else if (target.dataset.quick) {
            const key = target.dataset.quick as HomeService;
            if (layout.quick.includes(key)) layout.quick = layout.quick.filter(k => k !== key);
            else if (layout.quick.length < 5) layout.quick.push(key);
            else { showToast('最多五个快捷入口，请先关闭一个'); return; }
            await saveHomeLayout(layout);
          } else {
            const list = target.dataset.group === 'quick' ? layout.quick : layout.order;
            const index = (list as string[]).indexOf(target.dataset.move!); const to = index + Number(target.dataset.step);
            if (index < 0 || to < 0 || to >= list.length) return;
            [list[index], list[to]] = [list[to], list[index]];
            await saveHomeLayout(layout);
          }
          await refresh();
          const attr = target.dataset.move ? `data-move="${target.dataset.move}"][data-step="${target.dataset.step}"` : target.dataset.sw ? `data-sw="${target.dataset.sw}"` : `data-quick="${target.dataset.quick}"`;
          el.querySelector<HTMLElement>(`[${attr}]`)?.focus({ preventScroll: true });
        })().catch(error => showToast((error as Error).message)).finally(() => { busy = false; });
      });
      void refresh();
    },
  });
}
