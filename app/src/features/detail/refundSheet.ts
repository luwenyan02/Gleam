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
import { closeSubpage } from '../shell/router';
import { showToast } from '../shell/toast';
import { canRefund, getRefundEntryId } from './entrySwipe';
import { fullDateTime, dayLabel, sheetPick } from './detailShared';
import { categoryDisplayMap } from '../../core/categoryIcons';

export async function renderRefundPage(body: HTMLElement): Promise<void> {
  const originalId = getRefundEntryId();
  if (originalId == null) { body.innerHTML = '<p class="tiny">未指定原账单</p>'; return; }
  const [original, remaining, tree, accounts] = await Promise.all([
    getEntry(originalId), refundableAmount(originalId), listExpenseTree(), listAccounts(false),
  ]);
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

  body.classList.add('refund-page');
  body.innerHTML = `
    <section class="refund-origin">
      <span class="e-ic">${iconHtml(originalCategory?.icon ?? 'ic-coin', 20)}</span>
      <div><p>原支出 · ${esc(originalCategory?.name ?? '未分类')}</p><small>${fullDateTime(original.occurredAt)}</small></div>
      <strong class="num">-${formatFen(original.amount)}</strong>
    </section>
    <section class="refund-amount-card">
      <div><p>退款金额</p><small>本次最多可退 ${formatFenCny(remaining)}</small></div>
      <label class="refund-amount-value num">
        <i>¥</i>
        <input id="rf-amount" type="text" inputmode="decimal" enterkeyhint="done"
          maxlength="11" autocomplete="off" spellcheck="false" aria-label="退款金额">
      </label>
    </section>
    <div class="refund-section-title"><span>退款分类</span><small>默认沿用原支出分类</small></div>
    <div class="cat-grid refund-cats" id="rf-cats">
      ${categories.map((cat) => `<button class="cat${cat.id === categoryId ? ' sel' : ''}" data-rf-cat="${cat.id}"><span class="cat-ic">${iconHtml(cat.icon)}</span><span>${esc(cat.name)}</span></button>`).join('')}
    </div>
    <input class="note" id="rf-note" maxlength="80" placeholder="输入退款备注…">
    <div class="meta-row refund-meta">
      <button class="chip" id="rf-date">${iconHtml('ic-cal', 15)}<span>${dayLabel(occurredAt)}</span></button>
      <button class="chip" id="rf-account">${iconHtml('ic-wallet', 15)}<span>${esc(accounts.find((account) => account.id === accountId)?.name ?? '选择账户')}</span></button>
      <span class="chip tag">关联 #${original.id}</span>
    </div>
    <div class="refund-keypad" id="rf-keypad" aria-label="退款金额键盘">
      <button data-rk="1">1</button><button data-rk="2">2</button><button data-rk="3">3</button><button data-rk="del">${iconHtml('ic-del', 18)}</button>
      <button data-rk="4">4</button><button data-rk="5">5</button><button data-rk="6">6</button><button data-rk="clear" class="muted">清空</button>
      <button data-rk="7">7</button><button data-rk="8">8</button><button data-rk="9">9</button><button data-rk="save" class="save">保存退款</button>
      <button data-rk="0" class="zero">0</button><button data-rk=".">.</button>
    </div>`;

  const amountEl = body.querySelector<HTMLInputElement>('#rf-amount')!;
  const refreshAmount = () => { amountEl.value = amountText; };
  refreshAmount();

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
    if (amountEl.value !== amountText) amountEl.value = amountText;
  });

  body.querySelector('#rf-cats')!.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>('[data-rf-cat]');
    if (!button) return;
    categoryId = Number(button.dataset.rfCat);
    body.querySelectorAll('[data-rf-cat]').forEach((item) => item.classList.toggle('sel', item === button));
  });
  body.querySelector('#rf-account')!.addEventListener('click', () => {
    void sheetPick('选择退款到账账户', accounts.map((account) => ({
      id: account.id, label: account.name, icon: 'ic-wallet', note: formatFen(account.balance),
    }))).then((picked) => {
      if (picked == null) return;
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
        occurredAt = new Date(r.year, r.month - 1, r.day, 12, 0).getTime();
        body.querySelector('#rf-date span')!.textContent = dayLabel(occurredAt);
      },
    });
    document.body.appendChild(panel);
  });
  body.querySelector('#rf-keypad')!.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>('[data-rk]');
    if (!button) return;
    const key = button.dataset.rk!;
    if (key === 'save') { void saveRefund(); return; }
    if (key === 'clear') {
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
    if (saving) return;
    let amount: number;
    try { amount = parseYuanToFen(amountText); }
    catch (error) { showToast(String(error instanceof Error ? error.message : error)); return; }
    if (amount <= 0) { showToast('请输入退款金额'); return; }
    if (amount > remaining) { showToast(`本次最多可退 ${formatFenCny(remaining)}`); return; }
    if (accountId == null) { showToast('请选择退款到账账户'); return; }
    saving = true;
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
      showToast(`退款已记录：${formatFenCny(amount)}，并已关联原账单`);
      closeSubpage();
    } catch (error) {
      showToast(String(error instanceof Error ? error.message : error));
    } finally {
      saving = false;
    }
  }
}
