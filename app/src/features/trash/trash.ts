/**
 * 拾光 · 回收站（features/trash，PRD 4.12）
 * 账单与生活记录软删除的统一视图：原信息、删除日期、剩余天数（保留 30 天）；
 * 恢复（账单经 entryRepo 重放余额影响）、清空（二次确认）。
 * 视觉结构与原型 index.html #page-trash（L1002-1013）一致；清空按钮因 shell
 * sub-head 固定（返回钮+标题），移到 sub-body 顶行。数据一律经 trashRepo。
 */
import './trash.css';
import { iconHtml } from '../../assets/icons';
import { esc } from '../../core/esc';
import { on } from '../../core/store';
import { formatFen } from '../../core/money';
import {
  listTrash, restoreTrashItem, purgeTrashItem, emptyTrash, type TrashItem,
} from '../../core/repo/trashRepo';
import { listCategories, listExpenseTree } from '../../core/repo/categoryRepo';
import { getSetting } from '../../core/repo/settingsRepo';
import { registerSubpage } from '../shell/router';
import { showToast } from '../shell/toast';
import { confirmDialog } from '../shell/dialog';

function md(ts: number): string {
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 分类 id → 名称（支出树 + 收入平铺） */
async function catNameMap(): Promise<Map<number, string>> {
  const [tree, income] = await Promise.all([listExpenseTree(), listCategories('income')]);
  const map = new Map<number, string>();
  for (const g of tree) {
    map.set(g.parent.id, g.parent.name);
    for (const c of g.children) map.set(c.id, c.name);
  }
  for (const c of income) map.set(c.id, c.name);
  return map;
}

const LIFE_LABEL: Record<string, string> = { diary: '日记', photo: '照片记录', habit: '习惯打卡' };

/** 条目展示名（恢复 toast 与行标题共用） */
function itemName(item: TrashItem, cats: Map<number, string>): string {
  if (item.kind === 'entry') {
    const e = item.entry;
    return e.note || cats.get(e.categoryId ?? -1) || (e.type === 'income' ? '收入' : e.type === 'transfer' ? '转账' : '支出');
  }
  return item.note.title || LIFE_LABEL[item.note.kind] || '生活记录';
}

/** 注册回收站子页（覆盖 sp-trash 占位），main.ts 调用一次 */
export function initTrash(): void {
  registerSubpage('sp-trash', {
    title: '回收站',
    render(el) {
      /** 最近一次渲染的条目（点击行按索引取回） */
      let items: TrashItem[] = [];

      el.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:0 2px 10px">
          <p class="sub" id="tr-tip" style="padding:0;flex:1">删除的账单在这里保留 30 天，到期自动清除 · 删除的账户与账本不会自动清除，需在此手动处理</p>
          <button class="chip danger" id="tr-empty" style="flex:none">清空</button>
        </div>
        <section class="card list" aria-label="回收站条目"><div id="tr-list"></div></section>
        <p class="tiny" style="text-align:center;margin-top:12px">恢复后账单回到原日期的流水中，并重新计入报表与预算</p>`;

      async function refresh(): Promise<void> {
        if (!el.isConnected) return;
        const [list, cats, days] = await Promise.all([listTrash(), catNameMap(), getSetting('trash.retentionDays')]);
        if (!el.isConnected) return;
        items = list;
        el.querySelector('#tr-tip')!.textContent =
          `删除的账单在这里保留 ${days} 天，到期自动清除 · 删除的账户与账本不会自动清除，需在此手动处理`;

        el.querySelector('#tr-list')!.innerHTML = items.length ? items.map((item, i) => {
          const left = Math.max(0, days - Math.floor((Date.now() - item.deletedAt) / 86400000));
          const leftTxt = left > 0 ? `${left} 天后自动清除` : '即将自动清除';
          if (item.kind === 'entry') {
            const e = item.entry;
            const isOrphanRefund = e.refundFlag === true && e.refundOfEntryId != null;
            const sign = e.type === 'income' ? '+' : e.type === 'transfer' ? '' : '-';
            return `
            <div class="row" data-i="${i}">
              <span class="e-ic neutral">${iconHtml('ic-trash', 18)}</span>
              <div class="e-main"><p class="e-title">${esc(itemName(item, cats))}</p><p class="e-meta">${md(e.occurredAt)} · ${esc(cats.get(e.categoryId ?? -1) ?? (e.type === 'transfer' ? '转账' : '未分类'))} · ${md(item.deletedAt)}删除，${leftTxt}</p></div>
              <p class="e-amt num">${sign}¥${formatFen(e.amount)}</p>
              ${isOrphanRefund
                ? '<span class="restore-link" style="color:var(--muted);font-size:12px;cursor:default">需先恢复原消费</span>'
                : `<button class="restore-link" data-restore="${i}">恢复</button>`}
            </div>`;
          }
          return `
            <div class="row" data-i="${i}">
              <span class="e-ic neutral">${iconHtml('ic-trash', 18)}</span>
              <div class="e-main"><p class="e-title">${esc(itemName(item, cats))}</p><p class="e-meta">${LIFE_LABEL[item.note.kind] ?? '生活记录'} · ${md(item.deletedAt)}删除，${leftTxt}</p></div>
              <button class="restore-link" data-restore="${i}">恢复</button>
            </div>`;
        }).join('') : '<p class="sub" style="padding:12px 2px">回收站是空的 · 删除的账单与生活记录会先到这里</p>';
      }

      el.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const restore = target.closest<HTMLElement>('[data-restore]');
        if (restore) {
          const item = items[Number(restore.dataset.restore)];
          if (!item) return;
          void catNameMap().then(async (cats) => {
            try {
              await restoreTrashItem(item);
              showToast(item.kind === 'entry'
                ? `已恢复「${itemName(item, cats)}」：回到原日期流水，并重新计入报表与预算`
                : `已恢复「${itemName(item, cats)}」：回到生活记录`);
            } catch (err) {
              showToast(err instanceof Error ? err.message : String(err));
            }
          });
          return;
        }
        const purge = target.closest<HTMLElement>('[data-purge]');
        if (purge) {
          const item = items[Number(purge.dataset.purge)];
          if (!item) return;
          void (async () => {
            const cats = await catNameMap();
            const ok = await confirmDialog({
              title: `彻底删除「${itemName(item, cats)}」？`,
              message: '彻底删除后不可恢复。',
              okText: '彻底删除',
              danger: true,
            });
            if (ok) { await purgeTrashItem(item); showToast('已彻底删除'); }
          })();
          return;
        }
        if (target.closest('#tr-empty')) {
          if (!items.length) { showToast('回收站是空的'); return; }
          void confirmDialog({
            title: '清空回收站？',
            message: `将彻底删除 ${items.length} 条记录，不可恢复。`,
            okText: '清空',
            danger: true,
          }).then(async (ok) => {
            if (!ok) return;
            const n = await emptyTrash();
            showToast(`已清空回收站 · ${n} 条记录被彻底删除`);
          });
        }
      });

      // 账单/生活记录删除或恢复后刷新；子页关闭（DOM 销毁）后自动退订
      for (const ev of ['entries-changed', 'life-changed', 'settings-changed'] as const) {
        const off = on(ev, () => {
          if (!el.isConnected) { off(); return; }
          void refresh();
        });
      }
      void refresh();
    },
  });
}
