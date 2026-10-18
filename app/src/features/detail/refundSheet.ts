/**
 * 拾光 · 关联退款录入子页（sp-entry-refund）
 * 原支出摘要、金额自定义键盘、退款分类 / 账户 / 日期选择，保存走 entryRepo.createRefund。
 */
import { iconHtml } from '../../assets/icons';
import { esc } from '../../core/esc';
import { formatFen, formatFenCny, parseYuanToFen } from '../../core/money';
import {
  getEntry, refundableAmount, createRefund,
} from '../../core/repo/entryRepo';
import { listExpenseTree } from '../../core/repo/categoryRepo';
import { listAccounts } from '../../core/repo/accountRepo';
import { openDateTimeWheel } from '../../shared/dateTimeWheel';
import { closeSubpage, SUBPAGE_CLOSE_EVENT } from '../shell/router';
import { showToast } from '../shell/toast';
import { canRefund, getRefundEntryId } from './entrySwipe';
import { fullDateTime, dayLabel, sheetPick } from './detailShared';
import { categoryDisplayMap } from '../../core/categoryIcons';
import { openPickList } from '../../shared/pickList';
import { entryKeyFeedback } from '../entry/entryKeyFeedback';
import './refund.css';

export async function renderRefundPage(body: HTMLElement): Promise<void> {
  const subpage = body.closest<HTMLElement>('.subpage')!;
  let active = true;
  subpage.addEventListener(SUBPAGE_CLOSE_EVENT, () => { active = false; }, { once: true });
  const originalId = getRefundEntryId();
  if (originalId == null) { body.innerHTML = '<p class="tiny">未指定原账单</p>'; return; }
  const [original, remaining, tree, accounts] = await Promise.all([
    getEntry(originalId), refundableAmount(originalId), listExpenseTree(), listAccounts(false),
  ]);
  if (!active) return;
  if (!original || original.deletedAt !== 0 || !canRefund(original)) {
    body.innerHTML = '<div class="placeholder"><p class="sub">原支出账单不存在或不可退款</p></div>';
    return;
  }
  const sourceEntry = original;
  if (remaining <= 0) {
    body.innerHTML = '<div class="placeholder"><p class="sub">这笔支出已经全部退款</p></div>';
    return;
  }
  const categoryMap = categoryDisplayMap(tree.flatMap(group => [group.parent, ...group.children]));
  const categories = tree.flatMap((group) => group.children.length ? group.children : [group.parent])
    .map(category => categoryMap.get(category.id)!);
  const originalCategory = categories.find((cat) => cat.id === original.categoryId) ?? categories[0];
  let categoryId = originalCategory?.id;
  let accountId = accounts.some((account) => account.id === original.accountId) ? original.accountId : accounts[0]?.id;
  let occurredAt = Date.now();
  let amountText = formatFen(remaining).replace(/,/g, '');
  let replaceAmountOnNextKey = true;
  let saving = false;
  const orderedCategories = originalCategory
    ? [originalCategory, ...categories.filter(category => category.id !== originalCategory.id)] : categories;
  const visibleCategories = orderedCategories.slice(0, categories.length > 20 ? 19 : 20);

  body.classList.add('refund-page');
  body.innerHTML = `
    <section class="pick-card refund-amount-card">
      <div><p>退款金额</p><small>最多可退 ${formatFenCny(remaining)}</small></div>
      <label class="refund-amount-value num">
        <i>¥</i>
        <input id="rf-amount" type="text" inputmode="none" enterkeyhint="done" placeholder="0.00"
          maxlength="11" autocomplete="off" spellcheck="false" aria-label="退款金额">
      </label>
    </section>
    <div class="refund-scroll">
      <section class="refund-origin">
        <span class="e-ic">${iconHtml(originalCategory?.icon ?? 'ic-coin', 18)}</span>
        <div><p>原支出 · ${esc(originalCategory?.name ?? '未分类')}</p><small>${fullDateTime(original.occurredAt)}</small></div>
        <strong class="num">-${formatFen(original.amount)}</strong>
      </section>
      <div class="entry-section-head"><span>退款分类</span></div>
      <div class="cat-grid" id="rf-cats" role="listbox" aria-label="选择退款分类"></div>
    </div>
    <div class="refund-note-field">
      <input class="note" id="rf-note" maxlength="80" placeholder="写点备注（可选）" aria-label="退款备注">
      <button type="button" id="rf-note-clear" aria-label="清空退款备注" hidden>${iconHtml('ic-close', 16)}</button>
    </div>
    <div class="meta-row refund-meta">
      <button class="chip" id="rf-date">${iconHtml('ic-cal', 15)}<span>${dayLabel(occurredAt)}</span></button>
      <button class="chip" id="rf-account">${iconHtml('ic-wallet', 15)}<span>${esc(accounts.find((account) => account.id === accountId)?.name ?? '选择账户')}</span></button>
    </div>
    <div class="entry-keyboard">
    <div class="keypad" id="rf-keypad" aria-label="退款金额键盘">
      <button data-rk="1">1</button><button data-rk="2">2</button><button data-rk="3">3</button><button data-rk="del" class="op" aria-label="删除一位">${iconHtml('ic-del')}</button>
      <button data-rk="4">4</button><button data-rk="5">5</button><button data-rk="6">6</button><button data-rk="full" class="again" aria-label="填入剩余可退全额">全额</button>
      <button data-rk="7">7</button><button data-rk="8">8</button><button data-rk="9">9</button><button data-rk="save" class="save" aria-label="保存退款">保存</button>
      <button data-rk="clear" class="clear" aria-label="清空退款金额">清空</button><button data-rk="0" class="zero">0</button><button data-rk=".">.</button>
    </div></div>`;

  const renderCategories = () => {
    body.querySelector('#rf-cats')!.innerHTML = visibleCategories.map(cat => `
      <button class="cat${cat.id === categoryId ? ' sel' : ''}" data-rf-cat="${cat.id}" role="option" aria-selected="${cat.id === categoryId}">
        <span class="cat-ic">${iconHtml(cat.icon)}</span><span>${esc(cat.name)}</span>
      </button>`).join('') + (categories.length > 20 ? `
      <button class="cat cat-more" id="rf-more"><span class="cat-ic">${iconHtml('ic-set')}</span><span>更多</span></button>` : '');
  };
  renderCategories();

  const amountEl = body.querySelector<HTMLInputElement>('#rf-amount')!;
  const refreshAmount = () => {
    amountEl.value = amountText;
    amountEl.style.width = `${Math.max(4, amountText.length)}ch`;
    body.querySelector<HTMLButtonElement>('[data-rk="clear"]')!.disabled = saving || !amountText;
  };
  refreshAmount();

  const note = body.querySelector<HTMLInputElement>('#rf-note')!;
  const noteClear = body.querySelector<HTMLButtonElement>('#rf-note-clear')!;
  note.addEventListener('input', () => { noteClear.hidden = !note.value; });
  note.addEventListener('focus', () => { body.classList.add('refund-note-editing'); });
  note.addEventListener('blur', () => { body.classList.remove('refund-note-editing'); });
  noteClear.addEventListener('pointerdown', event => event.preventDefault());
  noteClear.addEventListener('click', () => { note.value = ''; noteClear.hidden = true; note.focus(); });

  amountEl.addEventListener('focus', () => {
    requestAnimationFrame(() => amountEl.select());
  });
  amountEl.addEventListener('input', () => {
    replaceAmountOnNextKey = false;
    const raw = amountEl.value.replace(/[^\d.]/g, '');
    const dotIndex = raw.indexOf('.');
    const hasDecimal = dotIndex >= 0;
    let integer = (hasDecimal ? raw.slice(0, dotIndex) : raw).replace(/^0+(?=\d)/, '');
    if (hasDecimal && integer === '') integer = '0';
    const decimals = hasDecimal ? raw.slice(dotIndex + 1).replace(/\./g, '').slice(0, 2) : '';
    const digits = `${integer}${decimals}`.slice(0, 8);
    const integerLength = Math.max(0, digits.length - decimals.length);
    const nextInteger = digits.slice(0, integerLength);
    const nextDecimals = digits.slice(integerLength);
    amountText = hasDecimal ? `${nextInteger || '0'}.${nextDecimals}` : nextInteger;
    refreshAmount();
  });

  body.querySelector('#rf-cats')!.addEventListener('click', (event) => {
    if (saving || !active) return;
    if ((event.target as HTMLElement).closest('#rf-more')) {
      openPickList({
        container: subpage, title: '选择退款分类', selected: categoryId,
        items: categories.map(cat => ({ value: cat.id, label: cat.name, icon: cat.icon,
          group: categoryMap.get(cat.parentId ?? cat.id)?.name })),
        onPick(value) {
          if (!active || saving) return;
          categoryId = Number(value);
          if (!visibleCategories.some(cat => cat.id === categoryId)) {
            visibleCategories[visibleCategories.length - 1] = categoryMap.get(categoryId)!;
          }
          renderCategories();
          requestAnimationFrame(() => {
            if (!active) return;
            const selected = body.querySelector<HTMLElement>(`[data-rf-cat="${categoryId}"]`);
            selected?.focus({ preventScroll: true });
            selected?.scrollIntoView({ block: 'nearest' });
          });
        },
      });
      return;
    }
    const button = (event.target as HTMLElement).closest<HTMLElement>('[data-rf-cat]');
    if (!button) return;
    categoryId = Number(button.dataset.rfCat);
    body.querySelectorAll('[data-rf-cat]').forEach(item => {
      item.classList.toggle('sel', item === button);
      item.setAttribute('aria-selected', String(item === button));
    });
  });
  body.querySelector('#rf-account')!.addEventListener('click', () => {
    void sheetPick('选择退款到账账户', accounts.map((account) => ({
      id: account.id, label: account.name, icon: 'ic-wallet', note: formatFen(account.balance),
    }))).then((picked) => {
      if (picked == null || !active || saving) return;
      accountId = picked;
      body.querySelector('#rf-account span')!.textContent = accounts.find((account) => account.id === accountId)?.name ?? '选择账户';
    });
  });
  body.querySelector('#rf-date')!.addEventListener('click', () => {
    const d = new Date(occurredAt);
    const today = new Date();
    const panel = openDateTimeWheel({
      withTime: false,
      initial: { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() },
      maxDate: { year: today.getFullYear(), month: today.getMonth() + 1, day: today.getDate() },
      onConfirm(r) {
        if (!active || saving) return;
        occurredAt = new Date(r.year, r.month - 1, r.day, 12, 0).getTime();
        body.querySelector('#rf-date span')!.textContent = dayLabel(occurredAt);
      },
    });
    document.body.appendChild(panel);
  });
  const keypad = body.querySelector<HTMLElement>('#rf-keypad')!;
  keypad.addEventListener('pointerdown', event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-rk]');
    if (button && !button.disabled && active && !saving && event.isPrimary && event.button === 0) void entryKeyFeedback();
  });
  keypad.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-rk]');
    if (!button || button.disabled || saving || !active) return;
    if (event.detail === 0) void entryKeyFeedback();
    const key = button.dataset.rk!;
    if (key === 'save') { void saveRefund(); return; }
    if (key === 'full') {
      amountText = formatFen(remaining).replace(/,/g, '');
      replaceAmountOnNextKey = true;
    } else if (key === 'clear') {
      amountText = '';
      replaceAmountOnNextKey = false;
    } else if (key === 'del') {
      amountText = replaceAmountOnNextKey ? '' : amountText.slice(0, -1);
      replaceAmountOnNextKey = false;
    }
    else if (key === '.') {
      if (replaceAmountOnNextKey) {
        amountText = '0.';
        replaceAmountOnNextKey = false;
      } else if (!amountText.includes('.')) amountText = (amountText || '0') + '.';
    } else {
      const next = (replaceAmountOnNextKey ? '' : amountText) + key;
      const decimals = next.split('.')[1]?.length ?? 0;
      if (decimals <= 2 && next.replace('.', '').length <= 8) {
        amountText = next.replace(/^0+(?=\d)/, '');
        replaceAmountOnNextKey = false;
      }
    }
    refreshAmount();
  });

  async function saveRefund(): Promise<void> {
    if (saving || !active) return;
    let amount: number;
    try { amount = parseYuanToFen(amountText); }
    catch (error) { showToast(String(error instanceof Error ? error.message : error)); return; }
    if (amount <= 0) { showToast('请输入退款金额'); return; }
    if (amount > remaining) { showToast(`本次最多可退 ${formatFenCny(remaining)}`); return; }
    if (accountId == null) { showToast('请选择退款到账账户'); return; }
    saving = true;
    body.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input').forEach(control => { control.disabled = true; });
    try {
      await createRefund({
        originalEntryId: sourceEntry.id,
        amount,
        occurredAt,
        accountId,
        categoryId,
        merchantId: sourceEntry.merchantId,
        note: body.querySelector<HTMLInputElement>('#rf-note')!.value.trim() || undefined,
      });
      if (active) {
        showToast(`退款已记录：${formatFenCny(amount)}，并已关联原账单`);
        closeSubpage();
      }
    } catch (error) {
      if (active) showToast(String(error instanceof Error ? error.message : error));
    } finally {
      saving = false;
      if (active) {
        body.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input').forEach(control => { control.disabled = false; });
        refreshAmount();
      }
    }
  }
}
