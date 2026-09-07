/** 应收应付入口：账户页的同一组账户，不维护独立对象或第二份余额。 */
import './loan.css';
import { iconHtml } from '../../assets/icons';
import { esc } from '../../core/esc';
import { on } from '../../core/store';
import { formatFenCny } from '../../core/money';
import { listLoanAccounts } from '../../core/repo/loanRepo';
import { openAccountDetail, openAccountForm } from '../account/account';
import { registerSubpage } from '../shell/router';

let body: HTMLElement | undefined;
let refreshToken = 0;
async function refresh(): Promise<void> {
  const el = body;
  if (!el?.isConnected) return;
  const token = ++refreshToken;
  const accounts = await listLoanAccounts();
  if (token !== refreshToken || !el.isConnected) return;
  const receivable = accounts.reduce((sum, a) => sum + Math.max(a.balance, 0), 0);
  const payable = accounts.reduce((sum, a) => sum + Math.max(-a.balance, 0), 0);
  el.innerHTML = `
    <section class="card lo-sum" aria-label="应收应付总览">
      <div><p class="label">别人欠我</p><p class="big in num">${formatFenCny(receivable)}</p><p class="tiny">应收合计</p></div>
      <div><p class="label">我欠别人</p><p class="big out num">${formatFenCny(payable)}</p><p class="tiny">应付合计</p></div>
    </section>
    <section class="card list" aria-label="应收应付账户列表">
      ${accounts.map(account => `<button class="row" data-loan-account="${account.id}">
        <span class="e-ic">${iconHtml('ic-wallet')}</span>
        <div class="e-main"><p class="e-title">${esc(account.name)}</p><p class="e-meta">应收应付账户${account.hidden ? ' · 已隐藏' : ''}</p></div>
        <span class="acct-amt num">${account.balance > 0 ? '应收 ' + formatFenCny(account.balance) : account.balance < 0 ? '应付 ' + formatFenCny(-account.balance) : '已结清'}</span>
      </button>`).join('') || '<p class="sub" style="padding:18px">暂无应收应付账户；可在这里新建，或从账户页添加。</p>'}
    </section>
    <button class="btn ghost" data-new-loan-account>新建应收应付账户</button>
    <p class="tiny" style="margin-top:12px">与账户页共用余额和流水。借贷本金按双账户转账处理，不计入收支。</p>`;
}

export function initLoan(): void {
  registerSubpage('sp-loan', {
    title:'应收应付',
    render(el) {
      body = el;
      el.addEventListener('click', event => {
        const target = event.target as HTMLElement;
        const account = target.closest<HTMLElement>('[data-loan-account]');
        if (account) openAccountDetail(Number(account.dataset.loanAccount));
        else if (target.closest('[data-new-loan-account]')) void openAccountForm(undefined, 'receivable');
      });
      void refresh();
    },
    onShow() { void refresh(); },
  });
  on('accounts-changed', () => void refresh());
}
