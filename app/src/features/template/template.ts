/**
 * 拾光 · 速记模板管理（features/template，覆盖 sp-template-manage）
 * 「分类 + 金额 + 名称」一键记账模板的增删改与排序：
 * 列表行显示名称 / 分类名 / 金额，上下移按钮写 sortOrder；
 * 新建与编辑走 openSheet 抽屉（名称输入 + 金额输入 + 支出分类树选择），删除需确认。
 * 入口：我的页「速记模板」行 + 记一笔抽屉速记区「管理」；数据一律经 templateRepo。
 */
import './template.css';
import { iconHtml } from '../../assets/icons';
import { esc } from '../../core/esc';
import { formatFen, parseYuanToFen } from '../../core/money';
import { addTemplate, updateTemplate, deleteTemplate, listTemplates } from '../../core/repo/templateRepo';
import { listExpenseTree } from '../../core/repo/categoryRepo';
import { registerSubpage } from '../shell/router';
import { openSheet, closeSheet } from '../shell/sheet';
import { showToast } from '../shell/toast';
import { confirmDialog } from '../shell/dialog';
import type { QuickTemplate } from '../../core/types';

/** 抽屉监听器控制：#sheet 为复用容器，重开前必须废止上一次绑定 */
let sheetAbort: AbortController | undefined;

function sheetSignal(): AbortSignal {
  sheetAbort?.abort();
  sheetAbort = new AbortController();
  return sheetAbort.signal;
}

/** 注册速记模板管理子页（sp-template-manage），main.ts 调用一次 */
export function initTemplateManage(): void {
  registerSubpage('sp-template-manage', {
    title: '速记模板',
    render(el) {
      /** 最近一次加载的模板（排序与编辑用，sortOrder 升序） */
      let templates: QuickTemplate[] = [];

      el.innerHTML = `
        <p class="sub" style="padding:0 2px 10px">常用的「分类 + 金额」存成模板，记一笔抽屉里一键填好 · 点行可编辑，上下箭头调顺序</p>
        <div id="tm-list"></div>
        <button class="btn ghost" id="tm-add">新建模板</button>`;

      async function refresh(): Promise<void> {
        if (!el.isConnected) return;
        const [tpls, tree] = await Promise.all([listTemplates(), listExpenseTree()]);
        if (!el.isConnected) return;
        templates = tpls;
        const catNames = new Map<number, string>();
        for (const g of tree) {
          catNames.set(g.parent.id, g.parent.name);
          for (const c of g.children) catNames.set(c.id, c.name);
        }
        el.querySelector('#tm-list')!.innerHTML = templates.length ? `
          <section class="card list" aria-label="速记模板列表">
            ${templates.map((t, i) => `
              <div class="row tm-item" data-id="${t.id}" role="button" tabindex="0">
                <span class="e-ic sm">${iconHtml('ic-bolt', 17)}</span>
                <div class="tm-main"><b>${esc(t.name)}</b>
                  <span class="row-note">${esc(catNames.get(t.categoryId) ?? '分类已删除')} · ¥${formatFen(t.amount)}</span></div>
                <span class="tm-sort">
                  <button class="icon-btn tm-up" data-move="-1" data-idx="${i}" aria-label="上移"${i === 0 ? ' disabled' : ''}>${iconHtml('ic-left', 15)}</button>
                  <button class="icon-btn tm-down" data-move="1" data-idx="${i}" aria-label="下移"${i === templates.length - 1 ? ' disabled' : ''}>${iconHtml('ic-right', 15)}</button>
                </span>
              </div>`).join('')}
          </section>`
          : '<p class="sub" style="padding:12px 2px">还没有速记模板 · 点下方「新建模板」创建</p>';
      }

      /** 上下移：把既有 sortOrder 值按交换后的顺序重新分配（与分类管理同法） */
      async function move(idx: number, delta: number): Promise<void> {
        const to = idx + delta;
        if (to < 0 || to >= templates.length) return;
        const order = templates.map((t) => t.id);
        [order[idx], order[to]] = [order[to], order[idx]];
        const byId = new Map(templates.map((t) => [t.id, t]));
        const slots = templates.map((t) => t.sortOrder).sort((a, b) => a - b);
        for (let i = 0; i < order.length; i++) {
          const t = byId.get(order[i])!;
          if (t.sortOrder !== slots[i]) await updateTemplate(t.id, { sortOrder: slots[i] });
        }
        void refresh();
      }

      el.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const mv = target.closest<HTMLElement>('[data-move]');
        if (mv) {
          if (!mv.hasAttribute('disabled')) void move(Number(mv.dataset.idx), Number(mv.dataset.move));
          return;
        }
        if (target.closest('#tm-add')) {
          openTplForm(undefined, () => void refresh());
          return;
        }
        const row = target.closest<HTMLElement>('.tm-item[data-id]');
        if (row) {
          const tpl = templates.find((t) => t.id === Number(row.dataset.id));
          if (tpl) openTplForm(tpl, () => void refresh());
        }
      });
      void refresh();
    },
  });
}

/* ── 新建 / 编辑抽屉 ─────────────────── */

/**
 * 模板表单抽屉：名称 + 金额 + 支出分类树选择；编辑模式带删除（confirmDialog 确认）。
 * @param tpl 编辑的模板，缺省为新建
 * @param onSaved 保存/删除成功后的回调（列表刷新）
 */
function openTplForm(tpl: QuickTemplate | undefined, onSaved: () => void): void {
  const title = tpl ? '编辑模板' : '新建模板';
  openSheet({
    ariaLabel: title,
    onClose: () => sheetAbort?.abort(),
    async render(el) {
      const tree = await listExpenseTree();
      if (!el.isConnected) return;
      let categoryId = tpl?.categoryId;

      el.innerHTML = `
        <div class="cm-sheet-head">
          <p class="sheet-title">${esc(title)}</p>
          <button class="icon-btn" data-act="close" aria-label="关闭">${iconHtml('ic-close')}</button>
        </div>
        <div class="sheet-scroll">
          <div class="field"><span>名称</span><input class="note" id="tf-name" maxlength="12" placeholder="如 早餐" value="${tpl ? esc(tpl.name) : ''}" style="margin-bottom:0;flex:1"></div>
          <div class="field"><span>金额</span><input class="note" id="tf-amount" inputmode="decimal" placeholder="如 15 或 12.5" value="${tpl ? formatFen(tpl.amount) : ''}" style="margin-bottom:0;flex:1"></div>
          <p class="tiny" style="padding:6px 0 0">选择支出分类</p>
          <div class="tm-cats" id="tf-cats">
            ${tree.map((g) => `
              <p class="tm-cat-sec">${esc(g.parent.name)}</p>
              <div class="tm-cat-row">
                <button type="button" class="chip${categoryId === g.parent.id ? ' active' : ''}" data-cat="${g.parent.id}">${esc(g.parent.name)}</button>
                ${g.children.map((c) => `<button type="button" class="chip${categoryId === c.id ? ' active' : ''}" data-cat="${c.id}">${esc(c.name)}</button>`).join('')}
              </div>`).join('') || '<p class="sub" style="padding:8px 0">还没有支出分类 · 请先到「分类管理」创建</p>'}
          </div>
          <button class="btn primary" data-act="save" style="margin-top:14px">${tpl ? '保存' : '创建'}</button>
          ${tpl ? '<button class="btn ghost" data-act="del" style="margin-top:10px;color:var(--danger)">删除模板</button>' : ''}
        </div>`;

      el.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const cat = target.closest<HTMLElement>('[data-cat]');
        if (cat) {
          categoryId = Number(cat.dataset.cat);
          for (const c of el.querySelectorAll<HTMLElement>('[data-cat]')) c.classList.toggle('active', c === cat);
          return;
        }
        const act = target.closest<HTMLElement>('[data-act]')?.dataset.act;
        if (act === 'close') closeSheet();
        else if (act === 'save') void save();
        else if (act === 'del' && tpl) void remove(tpl);
      }, { signal: sheetSignal() });

      async function save(): Promise<void> {
        const name = el.querySelector<HTMLInputElement>('#tf-name')!.value.trim();
        if (!name) { showToast('请填写模板名称'); return; }
        if (categoryId == null) { showToast('请选择支出分类'); return; }
        let amount: number;
        try {
          amount = parseYuanToFen(el.querySelector<HTMLInputElement>('#tf-amount')!.value);
        } catch (err) {
          showToast(String(err instanceof Error ? err.message : err));
          return;
        }
        if (amount <= 0) { showToast('金额需大于 0'); return; }
        if (tpl) await updateTemplate(tpl.id, { name, amount, categoryId });
        else await addTemplate({ name, amount, categoryId });
        closeSheet();
        showToast(tpl ? '模板已更新' : `已新建模板「${name}」`);
        onSaved();
      }

      async function remove(target: QuickTemplate): Promise<void> {
        const ok = await confirmDialog({
          title: `删除模板「${target.name}」？`,
          message: '模板本身不入账，删除不影响已记的账单',
          okText: '删除',
          danger: true,
        });
        if (!ok) return;
        await deleteTemplate(target.id);
        closeSheet();
        showToast('模板已删除');
        onSaved();
      }
    },
  });
}
