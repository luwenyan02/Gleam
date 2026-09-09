/**
 * 拾光 · 分类管理（features/category，PRD 4.11）
 * 支出两级树 / 收入单级，分段切换；新建大类/小类（53 枚图标库选图标）、
 * 改名、换图标、小类移动到其他大类/升为大类、拖动排序；
 * 删除有账单引用时必须选择「转移到指定分类」（categoryRepo.deleteCategory 事务转移）。
 * 视觉结构与原型 index.html #page-cats（L957-971）一致；数据一律经 repo。
 */
import './category.css';
import { ICON_IDS, iconHtml } from '../../assets/icons';
import { esc } from '../../core/esc';
import { on } from '../../core/store';
import {
  addCategory, deleteCategory, listCategories, listExpenseTree, moveCategory, updateCategory, reorderCategories,
} from '../../core/repo/categoryRepo';
import { registerSubpage } from '../shell/router';
import { openSheet, closeSheet } from '../shell/sheet';
import { showToast } from '../shell/toast';
import { confirmDialog } from '../shell/dialog';
import type { Category, CategoryKind } from '../../core/types';

/** 抽屉监听器控制：#sheet 为复用容器，重开前必须废止上一次绑定 */
let sheetAbort: AbortController | undefined;

function sheetSignal(): AbortSignal {
  sheetAbort?.abort();
  sheetAbort = new AbortController();
  return sheetAbort.signal;
}

const TIP: Record<CategoryKind, string> = {
  expense: '点击编辑 · 拖动排序',
  income: '点击编辑 · 拖动排序',
};

/** 注册分类管理子页（覆盖 sp-categories 占位），main.ts 调用一次 */
export function initCategoryManager(): void {
  registerSubpage('sp-categories', {
    title: '分类管理',
    render(el) {
      let kind: CategoryKind = 'expense';
      /** 最近一次加载的分类，按 id 索引（拖动排序与编辑用） */
      const byId = new Map<number, Category>();

      el.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;padding:0 2px 10px">
          <p class="sub" id="cm-tip" style="padding:0;flex:1">${TIP.expense}</p>
          <div class="seg mini" id="cm-seg" role="tablist" aria-label="分类类型" style="flex:none;margin-left:10px">
            <button class="active" data-t="expense" role="tab" aria-selected="true">支出</button>
            <button data-t="income" role="tab" aria-selected="false">收入</button>
          </div>
        </div>
        <div id="cm-list"></div>
        <button class="btn ghost" id="cm-add">新建大类</button>`;

      async function refresh(): Promise<void> {
        if (!el.isConnected) return;
        byId.clear();
        const list = el.querySelector('#cm-list')!;
        if (kind === 'expense') {
          const tree = await listExpenseTree();
          if (!el.isConnected) return;
          for (const g of tree) {
            byId.set(g.parent.id, g.parent);
            for (const c of g.children) byId.set(c.id, c);
          }
          list.innerHTML = tree.map((g) => `
            <section class="card list" style="margin-bottom:12px" aria-label="${esc(g.parent.name)}大类">
              <div class="row cm-item" data-id="${g.parent.id}" data-drag-group="parents" draggable="true" role="button" tabindex="0">
                <span class="e-ic sm">${iconHtml(g.parent.icon, 17)}</span><b>${esc(g.parent.name)}</b>
                <span class="row-note">${g.children.length} 个小类</span>
                <button class="restore-link" data-addsub="${g.parent.id}">添加小类</button>
              </div>
              ${g.children.map((c) => `
                <button class="row cm-item" data-id="${c.id}" data-drag-group="p${g.parent.id}" draggable="true">
                  <span class="e-ic sm">${iconHtml(c.icon, 17)}</span>${esc(c.name)}
                  <span class="chev" style="margin-left:auto">${iconHtml('ic-right', 15)}</span>
                </button>`).join('')}
            </section>`).join('') || '<p class="sub" style="padding:12px 2px">还没有支出大类 · 点下方「新建大类」创建</p>';
        } else {
          const cats = await listCategories('income');
          if (!el.isConnected) return;
          for (const c of cats) byId.set(c.id, c);
          list.innerHTML = `<section class="card list" aria-label="收入分类">
            ${cats.map((c) => `
              <button class="row cm-item" data-id="${c.id}" data-drag-group="income" draggable="true">
                <span class="e-ic sm">${iconHtml(c.icon, 17)}</span>${esc(c.name)}
                <span class="chev" style="margin-left:auto">${iconHtml('ic-right', 15)}</span>
              </button>`).join('') || '<p class="sub" style="padding:12px 2px">还没有收入分类</p>'}
          </section>`;
        }
      }

      /* 分段切换 */
      el.querySelector('#cm-seg')!.addEventListener('click', (e) => {
        const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-t]');
        if (!btn) return;
        kind = btn.dataset.t as CategoryKind;
        for (const b of el.querySelectorAll<HTMLElement>('#cm-seg button')) {
          b.classList.toggle('active', b === btn);
          b.setAttribute('aria-selected', String(b === btn));
        }
        el.querySelector('#cm-tip')!.textContent = TIP[kind];
        el.querySelector('#cm-add')!.textContent = kind === 'expense' ? '新建大类' : '新建收入分类';
        void refresh();
      });

      /* 点击：添加小类 / 编辑分类 / 新建大类 */
      el.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const addsub = target.closest<HTMLElement>('[data-addsub]');
        if (addsub) {
          const parent = byId.get(Number(addsub.dataset.addsub));
          if (parent) openCatForm({ kind: 'expense', parentId: parent.id, parentName: parent.name });
          return;
        }
        if (target.closest('#cm-add')) {
          openCatForm({ kind });
          return;
        }
        const row = target.closest<HTMLElement>('.cm-item[data-id]');
        if (row) {
          const cat = byId.get(Number(row.dataset.id));
          if (cat) void openCatEdit(cat);
        }
      });

      /* 拖动排序（同一 drag-group 内） */
      let dragEl: HTMLElement | null = null;
      el.addEventListener('dragstart', (e) => {
        const row = (e.target as HTMLElement).closest<HTMLElement>('[data-drag-group]');
        if (!row) return;
        dragEl = row;
        row.classList.add('dragging');
        e.dataTransfer?.setData('text/plain', row.dataset.id ?? '');
      });
      el.addEventListener('dragover', (e) => {
        const row = (e.target as HTMLElement).closest<HTMLElement>('[data-drag-group]');
        if (!row || !dragEl || row === dragEl || row.dataset.dragGroup !== dragEl.dataset.dragGroup) return;
        e.preventDefault();
        row.classList.add('drag-over');
      });
      el.addEventListener('dragleave', (e) => {
        (e.target as HTMLElement).closest<HTMLElement>('[data-drag-group]')?.classList.remove('drag-over');
      });
      el.addEventListener('drop', (e) => {
        const row = (e.target as HTMLElement).closest<HTMLElement>('[data-drag-group]');
        if (!row || !dragEl || row === dragEl || row.dataset.dragGroup !== dragEl.dataset.dragGroup) return;
        e.preventDefault();
        const group = dragEl.dataset.dragGroup!;
        const rows = [...el.querySelectorAll<HTMLElement>(`[data-drag-group="${group}"]`)];
        const ids = rows.map((r) => Number(r.dataset.id));
        const fromIdx = ids.indexOf(Number(dragEl.dataset.id));
        const toIdx = ids.indexOf(Number(row.dataset.id));
        const [moved] = ids.splice(fromIdx, 1);
        ids.splice(toIdx, 0, moved);
        void persistOrder(ids);
      });
      el.addEventListener('dragend', () => {
        dragEl?.classList.remove('dragging');
        for (const r of el.querySelectorAll('.drag-over')) r.classList.remove('drag-over');
        dragEl = null;
      });

      /** 把同组分类的既有 sortOrder 值按新顺序重新分配（不与其他组冲突） */
      async function persistOrder(orderedIds: number[]): Promise<void> {
        try { await reorderCategories(orderedIds); }
        catch (error) { showToast((error as Error).message); return; }
        showToast('排序已保存');
      }

      const off = on('categories-changed', () => {
        if (!el.isConnected) { off(); return; }
        void refresh();
      });
      void refresh();
    },
  });
}

/* ── 新建 / 编辑抽屉 ─────────────────── */

/** 图标宫格 HTML */
function iconGrid(selected: string): string {
  return `<div class="icon-grid" id="cf-icons">
    ${ICON_IDS.map((id) => `<button class="icon-cell${id === selected ? ' active' : ''}" data-icon="${id}" aria-label="${id}">${iconHtml(id)}</button>`).join('')}
  </div>`;
}

/** 新建分类（大类 / 小类 / 收入分类） */
function openCatForm(opts: { kind: CategoryKind; parentId?: number; parentName?: string }): void {
  let icon = opts.kind === 'income' ? 'ic-coin' : 'ic-bowl';
  const title = opts.parentId != null
    ? `新建小类 · ${opts.parentName}`
    : opts.kind === 'expense' ? '新建大类' : '新建收入分类';

  openSheet({
    ariaLabel: title,
    onClose: () => sheetAbort?.abort(),
    render(el) {
      el.innerHTML = `
        <div class="cm-sheet-head">
          <p class="sheet-title">${esc(title)}</p>
          <button class="icon-btn" data-act="close" aria-label="关闭">${iconHtml('ic-close')}</button>
        </div>
        <div class="sheet-scroll">
          <div class="field"><span>名称</span><input class="note" id="cf-name" maxlength="12" placeholder="如 早午餐" style="margin-bottom:0;flex:1"></div>
          <p class="tiny" style="padding:6px 0 0">选择图标</p>
          ${iconGrid(icon)}
          <button class="btn primary" data-act="save" style="margin-top:14px">创建</button>
        </div>`;
      el.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const cell = target.closest<HTMLElement>('[data-icon]');
        if (cell) {
          icon = cell.dataset.icon!;
          for (const c of el.querySelectorAll<HTMLElement>('[data-icon]')) c.classList.toggle('active', c === cell);
          return;
        }
        const act = target.closest<HTMLElement>('[data-act]')?.dataset.act;
        if (act === 'close') closeSheet();
        else if (act === 'save') void save();
      }, { signal: sheetSignal() });

      async function save(): Promise<void> {
        const name = el.querySelector<HTMLInputElement>('#cf-name')!.value.trim();
        if (!name) { showToast('请填写分类名称'); return; }
        try {
          await addCategory({ name, icon, kind: opts.kind, parentId: opts.parentId });
          closeSheet();
          showToast(`已新建「${name}」`);
        } catch (err) {
          showToast(err instanceof Error ? err.message : String(err));
        }
      }
    },
  });
}

/** 编辑分类：改名、换图标、小类移动/升为大类、删除（有引用须转移） */
async function openCatEdit(cat: Category): Promise<void> {
  const isChild = cat.parentId != null;
  const parents = isChild
    ? (await listExpenseTree()).map((g) => g.parent)
    : [];
  /** 移动目标：数字为大类 id；null 表示升为大类 */
  let moveTo: number | null = cat.parentId ?? null;
  let icon = cat.icon;

  openSheet({
    ariaLabel: `编辑分类：${cat.name}`,
    onClose: () => sheetAbort?.abort(),
    render(el) {
      el.innerHTML = `
        <div class="cm-sheet-head">
          <p class="sheet-title">编辑「${esc(cat.name)}」</p>
          <button class="icon-btn" data-act="close" aria-label="关闭">${iconHtml('ic-close')}</button>
        </div>
        <div class="sheet-scroll">
          <div class="field"><span>名称</span><input class="note" id="cf-name" maxlength="12" value="${esc(cat.name)}" style="margin-bottom:0;flex:1"></div>
          ${isChild ? `
          <div class="field"><span>所属大类</span>
            <div class="chip-group" id="cf-move">
              ${parents.map((p) => `<button class="chip${p.id === moveTo ? ' active' : ''}" data-move="${p.id}">${esc(p.name)}</button>`).join('')}
              <button class="chip${moveTo == null ? ' active' : ''}" data-move="top">升为大类</button>
            </div>
          </div>` : ''}
          <p class="tiny" style="padding:6px 0 0">选择图标</p>
          ${iconGrid(icon)}
          <button class="btn primary" data-act="save" style="margin-top:14px">保存修改</button>
          <button class="btn ghost" data-act="del" style="margin-top:10px;color:var(--over)">删除分类</button>
          <p class="tiny" style="text-align:center;margin-top:10px">删除时若有账单引用，需先选择转移到的分类</p>
        </div>`;
      el.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const cell = target.closest<HTMLElement>('[data-icon]');
        if (cell) {
          icon = cell.dataset.icon!;
          for (const c of el.querySelectorAll<HTMLElement>('[data-icon]')) c.classList.toggle('active', c === cell);
          return;
        }
        const mv = target.closest<HTMLElement>('[data-move]');
        if (mv) {
          moveTo = mv.dataset.move === 'top' ? null : Number(mv.dataset.move);
          for (const c of el.querySelectorAll<HTMLElement>('[data-move]')) c.classList.toggle('active', c === mv);
          return;
        }
        const act = target.closest<HTMLElement>('[data-act]')?.dataset.act;
        if (act === 'close') closeSheet();
        else if (act === 'save') void save();
        else if (act === 'del') void remove();
      }, { signal: sheetSignal() });

      async function save(): Promise<void> {
        const name = el.querySelector<HTMLInputElement>('#cf-name')!.value.trim();
        if (!name) { showToast('请填写分类名称'); return; }
        try {
          await updateCategory(cat.id, { name, icon });
          if (isChild && moveTo !== (cat.parentId ?? null)) {
            await moveCategory(cat.id, moveTo ?? undefined);
            showToast(moveTo == null ? `「${name}」已升为大类` : '已移动到新大类');
          } else {
            showToast('分类已更新');
          }
          closeSheet();
        } catch (err) {
          showToast(err instanceof Error ? err.message : String(err));
        }
      }

      async function remove(): Promise<void> {
        const ok = await confirmDialog({
          title: `删除「${cat.name}」？`,
          message: '删除后不可恢复；若有账单引用该分类，需要先转移到其他分类。',
          okText: '删除',
          danger: true,
        });
        if (!ok) return;
        try {
          await deleteCategory(cat.id);
          closeSheet();
          showToast(`已删除「${cat.name}」`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('账单引用')) openTransferSheet(cat);
          else showToast(msg);
        }
      }
    },
  });
}

/** 删除前的账单转移选择：选择同 kind 的目标分类后执行删除转移 */
async function openTransferSheet(cat: Category): Promise<void> {
  let candidates: Category[];
  if (cat.kind === 'income') {
    candidates = (await listCategories('income')).filter((c) => c.id !== cat.id);
  } else {
    const tree = await listExpenseTree();
    candidates = tree.flatMap((g) => [g.parent, ...g.children]).filter((c) => c.id !== cat.id);
  }
  if (!candidates.length) { showToast('没有可转移的目标分类'); return; }

  openSheet({
    ariaLabel: '选择转移目标分类',
    onClose: () => sheetAbort?.abort(),
    render(el) {
      el.innerHTML = `
        <div class="cm-sheet-head">
          <p class="sheet-title">转移「${esc(cat.name)}」的账单到…</p>
          <button class="icon-btn" data-act="close" aria-label="关闭">${iconHtml('ic-close')}</button>
        </div>
        <div class="sheet-scroll">
          <p class="sub" style="padding:0 2px 8px">该分类有账单引用 · 选择目标分类后，账单将转移过去并删除原分类</p>
          <div class="card list">
            ${candidates.map((c) => `
              <button class="row" data-to="${c.id}">
                <span class="e-ic sm">${iconHtml(c.icon, 17)}</span>${esc(c.name)}${c.parentId != null ? '<span class="row-note">小类</span>' : ''}
                <span class="chev" style="margin-left:auto">${iconHtml('ic-right', 15)}</span>
              </button>`).join('')}
          </div>
        </div>`;
      el.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        if (target.closest('[data-act="close"]')) { closeSheet(); return; }
        const row = target.closest<HTMLElement>('[data-to]');
        if (!row) return;
        const toId = Number(row.dataset.to);
        void deleteCategory(cat.id, toId)
          .then(() => {
            closeSheet();
            const to = candidates.find((c) => c.id === toId);
            showToast(`已删除「${cat.name}」，账单转移到「${to?.name ?? ''}」`);
          })
          .catch((err: unknown) => showToast(err instanceof Error ? err.message : String(err)));
      }, { signal: sheetSignal() });
    },
  });
}
