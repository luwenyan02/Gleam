import { iconHtml } from '../../assets/icons';
import { esc } from '../../core/esc';
import { formatFen, parseYuanToFen } from '../../core/money';
import { ACCOUNT_GROUPS, ACCOUNT_GROUP_NAMES, type Account, type AccountGroup, type Entry, type EntryType } from '../../core/types';
import { addAccount } from '../../core/repo/accountRepo';
import { openPickList } from '../../shared/pickList';
import { manageOverlay } from '../../shared/overlay';
import { rankFrequentAccounts } from './entryWorkspace';
import '../../shared/pickList.css';
import './entryAccountPicker.css';

export function openEntryAccountPicker(options: {
  container: HTMLElement; title: string; accounts: Account[]; entries: Entry[];
  type: EntryType; selected?: number; groups?: readonly AccountGroup[];
}): Promise<number | undefined> {
  return new Promise(resolve => {
    const mask = document.createElement('div');
    mask.className = 'picker-mask entry-account-mask';
    mask.setAttribute('aria-label', options.title);
    const panel = document.createElement('div');
    panel.className = 'picker-panel entry-account-picker';
    // Freeze the initial panel height; filtering and the software keyboard must not resize it.
    panel.style.height = `${Math.round(options.container.getBoundingClientRect().height * .624)}px`;
    panel.innerHTML = `<div class="entry-account-header">
      <div class="entry-account-heading"><h4>${esc(options.title)}</h4><button type="button" class="entry-account-search-button" data-search aria-label="搜索账户">${iconHtml('ic-search')}</button><span class="entry-account-divider" aria-hidden="true"></span><button type="button" data-add>添加账户</button></div>
      <div class="entry-account-heading entry-account-create-heading" hidden><h4>添加账户</h4></div>
      <div class="entry-account-search" hidden><input type="search" aria-label="搜索账户" placeholder="搜索账户"><button type="button" data-cancel-search>取消</button></div>
    </div><div class="picker-list" role="listbox" aria-label="${esc(options.title)}"></div>`;
    mask.append(panel); options.container.append(mask);
    let closed = false, saving = false;
    const close = (id?: number) => {
      if (closed || saving) return;
      closed = true; release(); panel.classList.remove('open');
      setTimeout(() => mask.remove(), 200); resolve(id);
    };
    const release = manageOverlay(mask, () => close());
    requestAnimationFrame(() => panel.classList.add('open'));
    const list = panel.querySelector<HTMLElement>('.picker-list')!;
    const heading = panel.querySelector<HTMLElement>('.entry-account-heading')!;
    const createHeading = panel.querySelector<HTMLElement>('.entry-account-create-heading')!;
    const search = panel.querySelector<HTMLElement>('.entry-account-search')!;
    const input = search.querySelector('input')!;
    const frequent = rankFrequentAccounts(options.accounts, options.entries, options.type);
    const frequentIds = new Set(frequent.map(a => a.id));
    function row(a: Account, compact = false): string {
      const selected = a.id === options.selected;
      return `<button type="button" role="option" aria-selected="${selected}" class="picker-item${compact ? ' frequent-account' : ''}${selected ? ' selected' : ''}" data-account="${a.id}" data-value="${a.id}"><span class="entry-account-copy"><span class="picker-item-label" title="${esc(a.name)}">${esc(a.name)}</span><span class="picker-item-note">${a.hidden ? '已隐藏 · ' : ''}${formatFen(a.balance)}</span></span><span class="entry-account-check">${selected ? '✓' : ''}</span></button>`;
    }
    function render(): void {
      const keyword = input.value.trim().toLocaleLowerCase();
      const accounts = options.accounts.filter(a => a.name.toLocaleLowerCase().includes(keyword));
      let html = '';
      if (!keyword && frequent.length) html += `<div class="picker-group-title">常用账户 · 近一年</div><div class="frequent-account-grid">${frequent.map(a => row(a, true)).join('')}</div>`;
      for (const group of ACCOUNT_GROUPS) {
        const rows = accounts.filter(a => a.group === group && (keyword || !frequentIds.has(a.id)));
        if (rows.length) html += `<div class="picker-group-title">${esc(ACCOUNT_GROUP_NAMES[group])}</div>${rows.map(a => row(a)).join('')}`;
      }
      list.innerHTML = html || '<p class="entry-account-empty">没有匹配的账户</p>';
      list.scrollTop = 0;
    }
    render();
    panel.querySelector('[data-search]')!.addEventListener('click', () => {
      heading.hidden = true; search.hidden = false; input.focus();
    });
    panel.querySelector('[data-cancel-search]')!.addEventListener('click', () => {
      input.value = ''; input.blur(); search.hidden = true; heading.hidden = false; render();
      panel.querySelector<HTMLButtonElement>('[data-search]')!.focus();
    });
    input.addEventListener('input', render);
    panel.querySelector('[data-add]')!.addEventListener('click', () => {
      heading.hidden = true; search.hidden = true; createHeading.hidden = false;
      list.removeAttribute('role');
      const groups = options.groups ?? ACCOUNT_GROUPS.filter(g => options.type !== 'loan' || g !== 'receivable');
      let selectedGroup: AccountGroup = groups[0] ?? 'cash';
      list.innerHTML = `<form class="entry-account-create">
        <label>账户名称<input name="name" maxlength="20" required autocomplete="off"></label>
        <label>账户类型<button type="button" class="entry-account-type-button" aria-label="账户类型" aria-haspopup="listbox" aria-expanded="false"><span>${esc(ACCOUNT_GROUP_NAMES[selectedGroup])}</span>${iconHtml('ic-right', 16)}</button><input type="hidden" name="group" value="${selectedGroup}"></label>
        <label>初始余额<input name="balance" inputmode="decimal" placeholder="0.00（欠款填负数）"></label>
        <p role="status"></p><div><button type="button" class="btn entry-account-back" data-back>返回</button><button type="submit" class="btn primary">保存并选择</button></div></form>`;
      const form = list.querySelector('form')!;
      const typeButton = form.querySelector<HTMLButtonElement>('.entry-account-type-button')!;
      typeButton.addEventListener('click', () => {
        typeButton.setAttribute('aria-expanded', 'true');
        openPickList({
          container: mask, title: '选择账户类型', searchable: false,
          items: groups.map(group => ({ value: group, label: ACCOUNT_GROUP_NAMES[group] })),
          selected: selectedGroup,
          onPick(value) {
            selectedGroup = value as AccountGroup;
            form.querySelector<HTMLInputElement>('[name="group"]')!.value = selectedGroup;
            typeButton.querySelector('span')!.textContent = ACCOUNT_GROUP_NAMES[selectedGroup];
            typeButton.setAttribute('aria-expanded', 'false');
          },
          onCancel() { typeButton.setAttribute('aria-expanded', 'false'); },
        });
      });
      form.querySelector('[data-back]')!.addEventListener('click', () => { heading.hidden = false; createHeading.hidden = true; list.setAttribute('role', 'listbox'); render(); });
      form.addEventListener('submit', async event => {
        event.preventDefault(); if (saving) return;
        const data = new FormData(form), name = String(data.get('name')).trim();
        if (!name) return;
        const balanceText = String(data.get('balance')).trim();
        saving = true;
        form.querySelectorAll('button').forEach(b => b.disabled = true);
        try {
          const negative = balanceText.startsWith('-');
          const balance = balanceText ? parseYuanToFen(balanceText.replace(/^[+-]/, '')) * (negative ? -1 : 1) : 0;
          const id = await addAccount({ name, group: String(data.get('group')) as AccountGroup, balance });
          saving = false; close(id);
        } catch (error) {
          form.querySelector('[role="status"]')!.textContent = error instanceof Error ? error.message : '添加失败，请重试';
        } finally {
          saving = false; form.querySelectorAll('button').forEach(b => b.disabled = false);
        }
      });
    });
    mask.addEventListener('click', event => {
      if (event.target === mask) { close(); return; }
      const button = (event.target as HTMLElement).closest<HTMLElement>('[data-account]');
      if (button) close(Number(button.dataset.account));
    });
  });
}
