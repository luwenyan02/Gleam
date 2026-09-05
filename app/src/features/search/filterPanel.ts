/**
 * 拾光 · 高级筛选面板（filterPanel）
 * 全屏子页形式，筛选项：类别（多选）、账户（多选）、标签（多选）、商家（多选）、金额范围。
 * 底部双按钮："重置" + "确定"。
 */
import { esc } from '../../core/esc';
import { listCategories } from '../../core/repo/categoryRepo';
import { listAccounts } from '../../core/repo/accountRepo';
import { listTags } from '../../core/repo/tagRepo';
import { listMerchants } from '../../core/repo/merchantRepo';

export interface FilterState {
  categoryIds: number[];
  accountIds: number[];
  tagIds: number[];
  merchantIds: number[];
  amountMin: string; // 元字符串
  amountMax: string;
}

export function emptyFilter(): FilterState {
  return { categoryIds: [], accountIds: [], tagIds: [], merchantIds: [], amountMin: '', amountMax: '' };
}

export function isFilterEmpty(f: FilterState): boolean {
  return !f.categoryIds.length && !f.accountIds.length && !f.tagIds.length && !f.merchantIds.length && !f.amountMin && !f.amountMax;
}

export interface FilterPanelOptions {
  initial: FilterState;
  onConfirm(state: FilterState): void;
  onCancel(): void;
}

/**
 * 创建高级筛选面板 DOM，调用方 append 到容器。
 */
export async function createFilterPanel(opts: FilterPanelOptions): Promise<HTMLElement> {
  const state: FilterState = { ...opts.initial, categoryIds: [...opts.initial.categoryIds], accountIds: [...opts.initial.accountIds], tagIds: [...opts.initial.tagIds], merchantIds: [...opts.initial.merchantIds] };

  const [expenseCats, incomeCats, accounts, tags, merchants] = await Promise.all([
    listCategories('expense'), listCategories('income'), listAccounts(), listTags(), listMerchants(),
  ]);
  const allCats = [...expenseCats, ...incomeCats];

  const panel = document.createElement('div');
  panel.className = 'fp-panel';

  function selectedText(ids: number[], allItems: { id: number; name: string }[]): string {
    if (!ids.length) return '全部';
    if (ids.length <= 2) return ids.map(id => allItems.find(i => i.id === id)?.name ?? '').join('、');
    return `已选${ids.length}项`;
  }

  function renderPanel(): void {
    panel.innerHTML = `
      <div class="fp-header">
        <button class="fp-cancel">取消</button>
        <h2>高级筛选</h2>
        <span></span>
      </div>
      <div class="fp-body">
        <div class="fp-section">
          <div class="fp-row" data-expand="category">
            <span class="fp-label">类别</span>
            <span class="fp-value">${esc(selectedText(state.categoryIds, allCats))} ›</span>
          </div>
          <div class="fp-expand" id="fp-cats" hidden>
            <div class="fp-chips">
              ${allCats.map(c => `<button class="chip${state.categoryIds.includes(c.id) ? ' active' : ''}" data-cid="${c.id}">${esc(c.name)}</button>`).join('')}
            </div>
          </div>
        </div>
        <div class="fp-section">
          <div class="fp-row" data-expand="account">
            <span class="fp-label">账户</span>
            <span class="fp-value">${esc(selectedText(state.accountIds, accounts))} ›</span>
          </div>
          <div class="fp-expand" id="fp-accts" hidden>
            <div class="fp-chips">
              ${accounts.map(a => `<button class="chip${state.accountIds.includes(a.id) ? ' active' : ''}" data-aid="${a.id}">${esc(a.name)}</button>`).join('')}
            </div>
          </div>
        </div>
        <div class="fp-section">
          <div class="fp-row" data-expand="tag">
            <span class="fp-label">标签</span>
            <span class="fp-value">${esc(selectedText(state.tagIds, tags))} ›</span>
          </div>
          <div class="fp-expand" id="fp-tags" hidden>
            <div class="fp-chips">
              ${tags.map(t => `<button class="chip${state.tagIds.includes(t.id) ? ' active' : ''}" data-tid="${t.id}">${esc(t.name)}</button>`).join('')}
            </div>
          </div>
        </div>
        <div class="fp-section">
          <div class="fp-row" data-expand="merchant">
            <span class="fp-label">商家</span>
            <span class="fp-value">${esc(selectedText(state.merchantIds, merchants))} ›</span>
          </div>
          <div class="fp-expand" id="fp-merchants" hidden>
            <div class="fp-chips">
              ${merchants.map(m => `<button class="chip${state.merchantIds.includes(m.id) ? ' active' : ''}" data-mid="${m.id}">${esc(m.name)}</button>`).join('')}
            </div>
          </div>
        </div>
        <div class="fp-section">
          <div class="fp-row fp-amount-row">
            <span class="fp-label">金额范围</span>
          </div>
          <div class="fp-amount-inputs">
            <input type="number" id="fp-min" placeholder="最小金额" value="${esc(state.amountMin)}" inputmode="decimal">
            <span class="fp-sep">—</span>
            <input type="number" id="fp-max" placeholder="最大金额" value="${esc(state.amountMax)}" inputmode="decimal">
          </div>
        </div>
      </div>
      <div class="fp-footer">
        <button class="btn ghost fp-reset">重置</button>
        <button class="btn primary fp-ok">确定</button>
      </div>`;
  }

  renderPanel();

  // 事件代理
  panel.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;

    // 取消
    if (target.closest('.fp-cancel')) {
      opts.onCancel();
      return;
    }

    // 展开/折叠
    const expandRow = target.closest<HTMLElement>('[data-expand]');
    if (expandRow) {
      const key = expandRow.dataset.expand!;
      const mapId: Record<string, string> = { category: 'fp-cats', account: 'fp-accts', tag: 'fp-tags', merchant: 'fp-merchants' };
      const expandEl = panel.querySelector<HTMLElement>(`#${mapId[key]}`);
      if (expandEl) expandEl.hidden = !expandEl.hidden;
      return;
    }

    // 类别选择
    const catChip = target.closest<HTMLElement>('[data-cid]');
    if (catChip) {
      const id = Number(catChip.dataset.cid);
      const idx = state.categoryIds.indexOf(id);
      if (idx >= 0) state.categoryIds.splice(idx, 1); else state.categoryIds.push(id);
      catChip.classList.toggle('active');
      // 更新汇总文字
      const row = panel.querySelector('[data-expand="category"] .fp-value');
      if (row) row.textContent = `${selectedText(state.categoryIds, allCats)} ›`;
      return;
    }

    // 账户选择
    const acctChip = target.closest<HTMLElement>('[data-aid]');
    if (acctChip) {
      const id = Number(acctChip.dataset.aid);
      const idx = state.accountIds.indexOf(id);
      if (idx >= 0) state.accountIds.splice(idx, 1); else state.accountIds.push(id);
      acctChip.classList.toggle('active');
      const row = panel.querySelector('[data-expand="account"] .fp-value');
      if (row) row.textContent = `${selectedText(state.accountIds, accounts)} ›`;
      return;
    }

    // 标签选择
    const tagChip = target.closest<HTMLElement>('[data-tid]');
    if (tagChip) {
      const id = Number(tagChip.dataset.tid);
      const idx = state.tagIds.indexOf(id);
      if (idx >= 0) state.tagIds.splice(idx, 1); else state.tagIds.push(id);
      tagChip.classList.toggle('active');
      const row = panel.querySelector('[data-expand="tag"] .fp-value');
      if (row) row.textContent = `${selectedText(state.tagIds, tags)} ›`;
      return;
    }

    // 商家选择
    const merchantChip = target.closest<HTMLElement>('[data-mid]');
    if (merchantChip) {
      const id = Number(merchantChip.dataset.mid);
      const idx = state.merchantIds.indexOf(id);
      if (idx >= 0) state.merchantIds.splice(idx, 1); else state.merchantIds.push(id);
      merchantChip.classList.toggle('active');
      const row = panel.querySelector('[data-expand="merchant"] .fp-value');
      if (row) row.textContent = `${selectedText(state.merchantIds, merchants)} ›`;
      return;
    }

    // 重置
    if (target.closest('.fp-reset')) {
      state.categoryIds = [];
      state.accountIds = [];
      state.tagIds = [];
      state.merchantIds = [];
      state.amountMin = '';
      state.amountMax = '';
      renderPanel();
      return;
    }

    // 确定
    if (target.closest('.fp-ok')) {
      state.amountMin = panel.querySelector<HTMLInputElement>('#fp-min')?.value ?? '';
      state.amountMax = panel.querySelector<HTMLInputElement>('#fp-max')?.value ?? '';
      opts.onConfirm(state);
      return;
    }
  });

  return panel;
}
