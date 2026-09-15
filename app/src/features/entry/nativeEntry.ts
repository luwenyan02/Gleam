import { Capacitor, registerPlugin } from '@capacitor/core';
import { App } from '@capacitor/app';
import { parseEntryLaunch, shortcutTemplates } from '../../core/entryLaunch';
import { listTemplates } from '../../core/repo/templateRepo';
import { getSetting } from '../../core/repo/settingsRepo';
import { on } from '../../core/store';
import { isSheetOpen } from '../shell/sheet';
import { showToast } from '../shell/toast';
import { openEntrySheet } from './entrySheet';

const native = registerPlugin<{
  setShortcuts(options: { templates: Array<{ id: number; name: string }> }): Promise<void>;
}>('GleamEntry');

/** 只在解锁、外壳及记账面板初始化完成后注册。 */
export async function initNativeEntry(): Promise<void> {
  if (Capacitor.getPlatform() !== 'android') return;
  let opening = false;
  let lastUrl = '';
  let lastAt = 0;
  const launch = async (url: string) => {
    const target = parseEntryLaunch(url);
    if (!target || opening || (url === lastUrl && Date.now() - lastAt < 1500)) return;
    lastUrl = url; lastAt = Date.now();
    if (isSheetOpen()) { showToast('请先保存或关闭当前草稿'); return; }
    opening = true;
    try {
      if ('templateId' in target && !(await listTemplates()).some(template => template.id === target.templateId)) {
        showToast('模板已删除，请重新填写');
        await openEntrySheet({ presetType: 'expense' });
      } else await openEntrySheet('templateId' in target ? { ...target, presetType: 'expense' } : target);
    } catch (error) { showToast(error instanceof Error ? error.message : '快捷记账打开失败'); }
    finally { opening = false; }
  };
  let refreshQueue = Promise.resolve();
  let published = '';
  const refresh = () => {
    refreshQueue = refreshQueue.then(async () => {
      const [templates, recent, pin] = await Promise.all([listTemplates(), getSetting('entry.recentTemplates'), getSetting('security.pin')]);
      const payload = { templates: shortcutTemplates(templates, recent).map((template, index) => ({
        id: template.id, name: pin ? `速记 ${index + 1}` : template.name.slice(0, 20),
      })) };
      const signature = JSON.stringify(payload);
      if (signature === published) return;
      await native.setShortcuts(payload);
      published = signature;
    }).catch(error => console.warn('[entry] 快捷入口更新失败', error));
  };
  on('templates-changed', refresh);
  on('settings-changed', refresh);
  refresh();
  await App.addListener('appUrlOpen', event => { void launch(event.url); });
  const initial = await App.getLaunchUrl();
  if (initial?.url) await launch(initial.url);
}
