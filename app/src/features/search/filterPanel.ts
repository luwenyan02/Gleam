/**
 * 拾光 · 高级筛选面板（filterPanel）
 * 全屏子页形式，筛选项：类别（多选）、账户（多选）、标签（多选）、商家（多选）、金额范围。
 * 底部双按钮："重置" + "确定"。
 */
import { expandCategoryIds, parseAmountRange } from '../../core/queryValidation';
import { showToast } from '../shell/toast';
import { esc } from '../../core/esc';
import { listCategories } from '../../core/repo/categoryRepo';
import { listAccounts } from '../../core/repo/accountRepo';
import { listTags } from '../../core/repo/tagRepo';
import { listMerchants } from '../../core/repo/merchantRepo';
import { ACCOUNT_GROUPS, ACCOUNT_GROUP_NAMES } from '../../core/types';
import './search.css';

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
  accountScope?: number;
  onConfirm(state: FilterState): void;
  onCancel(): void;
}

/**
 * 创建高级筛选面板 DOM，调用方 append 到容器。
 */
export async function createFilterPanel(opts: FilterPanelOptions): Promise<HTMLElement> {
  const state: FilterState = { ...opts.initial, categoryIds: [...opts.initial.categoryIds], accountIds: [...opts.initial.accountIds], tagIds: [...opts.initial.tagIds], merchantIds: [...opts.initial.merchantIds] };

  if (opts.accountScope != null) state.accountIds = [opts.accountScope];

  const [expenseCats, incomeCats, accounts, tags, merchants] = await Promise.all([
    listCategories('expense'), listCategories('income'), listAccounts(), listTags(), listMerchants(),
  ]);
  const allCats = [...expenseCats, ...incomeCats];
  state.categoryIds = expandCategoryIds(state.categoryIds, allCats);
  const expenseIds = new Set(expenseCats.map(category => category.id));
  const categoryGroups = expenseCats.filter(category => category.parentId == null || !expenseIds.has(category.parentId))
    .map(parent => ({ parent, children: expenseCats.filter(category => category.parentId === parent.id) }));
  const accountGroups = (opts.accountScope != null ? [] : ACCOUNT_GROUPS).map(group => ({ group, accounts: accounts.filter(account => account.group === group) }))
    .filter(group => group.accounts.length);

  const panel = document.createElement('div');
  panel.className = 'fp-panel';

  function selectedText(ids: number[], allItems: { id: number; name: string }[]): string {
    if (!ids.length) return '全部';
    if (ids.length <= 2) return ids.map(id => allItems.find(i => i.id === id)?.name ?? '').join('、');
    return `已选${ids.length}项`;
  }

  // 查询会展开大类；整组选中时摘要无需重复列出其小类。
  function selectedCategoryIds(): number[] {
    return state.categoryIds.filter(id => {
      const parentId = allCats.find(category => category.id === id)?.parentId;
      return parentId == null || !state.categoryIds.includes(parentId);
    });
  }

  function groupButton(label: string, attribute: string): string {
    return `<button type="button" class="fp-group-toggle" role="checkbox" aria-checked="false" ${attribute}><span class="fp-group-name">${esc(label)}</span><span class="fp-group-status">全选</span><span class="fp-group-check" aria-hidden="true"></span></button>`;
  }

  function updateSelections(): void {
    for (const [attribute, selected] of [['data-cid', state.categoryIds], ['data-aid', state.accountIds]] as const) {
      panel.querySelectorAll<HTMLButtonElement>(`[${attribute}]`).forEach(button => {
        if (button.hasAttribute('data-category-group')) return;
        const active = selected.includes(Number(button.getAttribute(attribute)));
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', String(active));
      });
    }
    const updateGroup = (button: HTMLElement, ids: number[], selected: number[]) => {
      const count = ids.filter(id => selected.includes(id)).length;
      const checked = count === ids.length ? 'true' : count ? 'mixed' : 'false';
      button.setAttribute('aria-checked', checked);
      button.querySelector('.fp-group-status')!.textContent = checked === 'true' ? '已全选' : checked === 'mixed' ? '部分已选' : '全选';
    };
    for (const { parent, children } of categoryGroups) {
      updateGroup(panel.querySelector(`[data-category-group="${parent.id}"]`)!, children.length ? children.map(child => child.id) : [parent.id], state.categoryIds);
    }
    for (const { group, accounts: members } of accountGroups) {
      updateGroup(panel.querySelector(`[data-account-group="${group}"]`)!, members.map(account => account.id), state.accountIds);
    }
    panel.querySelector('[data-expand="category"] .fp-value')!.textContent = `${selectedText(selectedCategoryIds(), allCats)} ›`;
    const accountValue = panel.querySelector('[data-expand="account"] .fp-value');
    if (accountValue) accountValue.textContent = `${selectedText(state.accountIds, accounts)} ›`;
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
          <button type="button" class="fp-row" data-expand="category" aria-expanded="false" aria-controls="fp-cats">
            <span class="fp-label">类别</span>
            <span class="fp-value">${esc(selectedText(state.categoryIds, allCats))} ›</span>
          </button>
          <div class="fp-expand" id="fp-cats" hidden>
            <h3 class="fp-kind">支出</h3>
            ${categoryGroups.map(({ parent, children }) => `<section class="fp-category-group fp-option-group">
              ${groupButton(parent.name, `data-category-group="${parent.id}"${children.length ? '' : ` data-cid="${parent.id}"`}`)}
              ${children.length ? `<div class="fp-chips">${children.map(c => `<button type="button" class="chip" data-cid="${c.id}">${esc(c.name)}</button>`).join('')}</div>` : ''}
            </section>`).join('') || '<p class="fp-empty">暂无支出分类</p>'}
            <h3 class="fp-kind">收入</h3>
            <div class="fp-chips">${incomeCats.map(c => `<button type="button" class="chip" data-cid="${c.id}">${esc(c.name)}</button>`).join('') || '<p class="fp-empty">暂无收入分类</p>'}</div>
          </div>
        </div>
        <div class="fp-section">
          ${opts.accountScope != null ? `<div class="fp-row"><span class="fp-label">账户</span><span class="fp-value">${esc(selectedText([opts.accountScope], accounts))}</span></div>` : `<button type="button" class="fp-row" data-expand="account" aria-expanded="false" aria-controls="fp-accts">
            <span class="fp-label">账户</span>
            <span class="fp-value">${esc(selectedText(state.accountIds, accounts))} ›</span>
          </button>
          <div class="fp-expand" id="fp-accts" hidden>
            ${accountGroups.map(({ group, accounts: members }) => `<section class="fp-account-group fp-option-group">
              ${groupButton(ACCOUNT_GROUP_NAMES[group], `data-account-group="${group}"`)}
              <div class="fp-chips">${members.map(a => `<button type="button" class="chip" data-aid="${a.id}">${esc(a.name)}${a.hidden ? '（已隐藏）' : ''}</button>`).join('')}</div>
            </section>`).join('') || '<p class="fp-empty">暂无账户</p>'}
          </div>`}
        </div>
        <div class="fp-section">
          <button type="button" class="fp-row" data-expand="tag" aria-expanded="false" aria-controls="fp-tags">
            <span class="fp-label">标签</span>
            <span class="fp-value">${esc(selectedText(state.tagIds, tags))} ›</span>
          </button>
          <div class="fp-expand" id="fp-tags" hidden>
            <div class="fp-chips">
              ${tags.map(t => `<button class="chip${state.tagIds.includes(t.id) ? ' active' : ''}" data-tid="${t.id}">${esc(t.name)}</button>`).join('')}
            </div>
          </div>
        </div>
        <div class="fp-section">
          <button type="button" class="fp-row" data-expand="merchant" aria-expanded="false" aria-controls="fp-merchants">
            <span class="fp-label">商家</span>
            <span class="fp-value">${esc(selectedText(state.merchantIds, merchants))} ›</span>
          </button>
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
            <input type="text" id="fp-min" placeholder="最小金额" value="${esc(state.amountMin)}" inputmode="decimal">
            <span class="fp-sep">—</span>
            <input type="text" id="fp-max" placeholder="最大金额" value="${esc(state.amountMax)}" inputmode="decimal">
          </div>
        </div>
      </div>
      <div class="fp-footer">
        <button class="btn ghost fp-reset">重置</button>
        <button class="btn primary fp-ok">确定</button>
      </div>`;
    updateSelections();
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
      if (expandEl) {
        expandEl.hidden = !expandEl.hidden;
        expandRow.setAttribute('aria-expanded', String(!expandEl.hidden));
      }
      return;
    }

    const categoryGroup = target.closest<HTMLElement>('[data-category-group]');
    if (categoryGroup) {
      const group = categoryGroups.find(group => group.parent.id === Number(categoryGroup.dataset.categoryGroup))!;
      const ids = [group.parent.id, ...group.children.map(child => child.id)];
      state.categoryIds = categoryGroup.getAttribute('aria-checked') === 'true'
        ? state.categoryIds.filter(id => !ids.includes(id)) : [...new Set([...state.categoryIds, ...ids])];
      updateSelections();
      return;
    }
    const accountGroup = target.closest<HTMLElement>('[data-account-group]');
    if (accountGroup) {
      const ids = accountGroups.find(group => group.group === accountGroup.dataset.accountGroup)!.accounts.map(account => account.id);
      state.accountIds = accountGroup.getAttribute('aria-checked') === 'true'
        ? state.accountIds.filter(id => !ids.includes(id)) : [...new Set([...state.accountIds, ...ids])];
      updateSelections();
      return;
    }

    // 类别选择
    const catChip = target.closest<HTMLElement>('[data-cid]');
    if (catChip) {
      const id = Number(catChip.dataset.cid);
      const idx = state.categoryIds.indexOf(id);
      if (idx >= 0) {
        state.categoryIds.splice(idx, 1);
        // 取消小类后，不能让大类查询又把它自动补回。
        const parentId = allCats.find(category => category.id === id)?.parentId;
        state.categoryIds = state.categoryIds.filter(selected => selected !== parentId);
      } else state.categoryIds.push(id);
      updateSelections();
      return;
    }

    // 账户选择
    const acctChip = target.closest<HTMLElement>('[data-aid]');
    if (acctChip) {
      const id = Number(acctChip.dataset.aid);
      const idx = state.accountIds.indexOf(id);
      if (idx >= 0) state.accountIds.splice(idx, 1); else state.accountIds.push(id);
      updateSelections();
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
      state.accountIds = opts.accountScope != null ? [opts.accountScope] : [];
      state.tagIds = [];
      state.merchantIds = [];
      state.amountMin = '';
      state.amountMax = '';
      renderPanel();
      panel.querySelector<HTMLButtonElement>('.fp-reset')?.focus();
      return;
    }

    // 确定
    if (target.closest('.fp-ok')) {
      state.amountMin = panel.querySelector<HTMLInputElement>('#fp-min')?.value ?? '';
      state.amountMax = panel.querySelector<HTMLInputElement>('#fp-max')?.value ?? '';
      try { parseAmountRange(state.amountMin, state.amountMax); }
      catch (error) { showToast(error instanceof Error ? error.message : '金额范围无效'); return; }
      opts.onConfirm({ ...state, categoryIds: selectedCategoryIds() });
      return;
    }
  });

  return panel;
}
