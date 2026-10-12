import { esc } from '../../core/esc';
import { formatFen } from '../../core/money';
import { summarizeLedgerEntries } from '../../core/ledgerQuery';
import { listAccounts } from '../../core/repo/accountRepo';
import { listCategories } from '../../core/repo/categoryRepo';
import {
  getLifeLedgerEvidence, getLifeLedgerFollowUps, lifeLedgerCategoryShares, lifeLedgerPeriods, lifeLedgerScopeLabel,
  type LifeLedgerReview, type LifeLedgerScope,
} from '../../core/repo/lifeLedgerContextRepo';
import { entryRowText } from '../detail/entryRowText';
import { openEntryDetail } from '../detail/entrySwipe';
import { closeSheet, openSheet } from '../shell/sheet';

const currency = (fen: number) => `¥${formatFen(fen)}`;
const signed = (fen: number) => `${fen > 0 ? '+' : ''}${currency(fen)}`;

/** 金额和操作完全来自本机结果，模型文字不能创建按钮或改变查询。 */
export function lifeLedgerResultHtml(review: LifeLedgerReview, messageIndex: number, busy: boolean): string {
  const summary = review.summary;
  const periods = lifeLedgerPeriods(review);
  const change = summary.analysis?.change;
  const reasons = {
    comparable: '', 'empty-baseline': '基期没有支出或退款记录，不计算变化率',
    'zero-baseline': '基期净支出为零，不计算变化率',
    'negative-baseline': '基期净支出为负，不计算变化率',
    'negative-current': '本期净支出为负，不计算变化率',
    'unsafe-percentage': '变化率超出精确显示范围，仅列金额差额',
  };
  const shares = lifeLedgerCategoryShares(summary);
  const periodTitle = (scope: LifeLedgerScope) => scope.period === 'recent' ? '近30天' : scope.month;
  const selector = (month: string, type = 'expense', categoryIndex?: number) => `data-ledger-evidence data-result-index="${messageIndex}" data-month="${month}" data-kind="${type}"${categoryIndex == null ? '' : ` data-category-index="${categoryIndex}"`}${busy ? ' disabled' : ''}`;
  return `<section class="life-ledger-result" data-ledger-result="${messageIndex}" aria-label="本机核对数据">
    <div class="life-ledger-result-head"><strong>本机核对数据</strong><small>人民币 · 本次分析时已记账数据</small></div>
    <p class="life-ledger-result-scope">${esc(lifeLedgerScopeLabel(summary.scope))}${summary.analysis?.kind === 'trend' ? ' · 近 6 月' : summary.analysis?.kind === 'compare' ? ' · 对比上月' : summary.scope.period === 'recent' ? ' · 分类构成' : ' · 单月分类'}</p>
    <div class="life-ledger-period-results">${periods.map(period => `<div class="life-ledger-period-result">
      <button ${selector(period.scope.month)} aria-label="核对 ${periodTitle(period.scope)} 支出明细"><span><b>${periodTitle(period.scope)}</b><small>${esc(period.range.label)}</small><small>支出 ${period.totals.expenseCount} 笔 · 退款 ${period.totals.refundCount} 笔</small></span><span class="life-ledger-result-amount"><small>净支出</small><b>${currency(period.totals.expenseFen)}</b><small>核对明细 ›</small></span></button>
      ${period.income ? `<button class="life-ledger-income-result" ${selector(period.scope.month, 'income')} aria-label="核对 ${periodTitle(period.scope)} 收入明细"><span>收入 ${period.income.count} 笔</span><b>${currency(period.income.incomeFen)} ›</b></button>` : ''}
    </div>`).join('')}</div>
    ${change ? `<p class="life-ledger-change">${periods.at(-1)!.scope.month} 比 ${periods[0].scope.month}：${signed(change.expenseChangeFen)}${change.expenseChangePercent == null ? `<small>${reasons[change.reason]}</small>` : `<small>变化率 ${change.expenseChangePercent > 0 ? '+' : ''}${change.expenseChangePercent.toFixed(2)}%</small>`}</p>` : ''}
    <details class="life-ledger-categories"><summary>${periodTitle(summary.scope)} 分类构成 · ${summary.categories.length} 项</summary>
      ${summary.categories.length ? summary.categories.map((row, index) => `<button ${selector(summary.scope.month, 'expense', index)} aria-label="核对 ${esc(row.name)}分类明细"><span>${esc(row.name)}<small>含退款 ${row.count} 笔${shares[index] == null ? '' : ` · 占净支出 ${shares[index]!.toFixed(2)}%`}</small></span><b>${currency(row.expenseFen)} ›</b></button>`).join('') : '<p class="sub">此范围暂无支出或退款记录</p>'}
      ${shares.some(share => share == null) ? '<p class="sub">含负分类或净支出不大于零，仅列金额和笔数，不计算占比</p>' : '<p class="sub">占比按净支出计算，四舍五入后可能不等于 100%</p>'}
    </details>
    <p class="life-ledger-result-note">${summary.reimbursementMode === 'offset' ? '已到账报销追溯冲抵原支出月份' : '报销按到账时间计收入'}；转账和借贷本金不计收支。明细仅在本机查看</p>
    <div class="life-ledger-followups" aria-label="继续分析">${getLifeLedgerFollowUps(review).map((followup, index) => `<button class="chip" data-ledger-followup="${index}" data-result-index="${messageIndex}"${busy ? ' disabled' : ''}>${esc(followup.label)}</button>`).join('')}</div>
  </section>`;
}

export function bindLifeLedgerResults(container: HTMLElement, reviews: ReadonlyMap<number, LifeLedgerReview>, options: {
  isActive: () => boolean;
  onError: (message: string) => void;
  onFollowup: (question: string, scope: LifeLedgerScope) => void;
}): void {
  container.querySelectorAll<HTMLButtonElement>('[data-ledger-followup]').forEach(button => button.onclick = () => {
    if (!options.isActive()) return;
    const review = reviews.get(Number(button.dataset.resultIndex));
    const followup = review && getLifeLedgerFollowUps(review)[Number(button.dataset.ledgerFollowup)];
    if (followup) options.onFollowup(followup.question, { ...followup.scope });
  });
  container.querySelectorAll<HTMLButtonElement>('[data-ledger-evidence]').forEach(button => button.onclick = async () => {
    if (!options.isActive() || button.disabled) return;
    const review = reviews.get(Number(button.dataset.resultIndex));
    if (!review) return;
    let closed = false;
    let sheet: HTMLElement | undefined;
    // 立即占有可取消的抽屉；关闭或新弹层会作废迟到的读取。
    openSheet({ ariaLabel: '核对账本明细', onClose: () => { closed = true; if (button.isConnected) button.disabled = false; }, render(el) {
      sheet = el;
      el.innerHTML = `<div class="sheet-head"><h3>核对账本明细</h3><button class="icon-btn" data-ledger-evidence-close aria-label="关闭核对明细">×</button></div><div class="sheet-scroll life-ledger-evidence-list" data-ledger-evidence-content><p class="sub" role="status">正在本机核对…</p></div>`;
      el.querySelector('[data-ledger-evidence-close]')!.addEventListener('click', closeSheet);
    } });
    button.disabled = true;
    try {
      const selection = { month: button.dataset.month!, type: button.dataset.kind as 'expense' | 'income',
        ...(button.dataset.categoryIndex == null ? {} : { categoryIndex: Number(button.dataset.categoryIndex) }) };
      const [evidence, categories, accounts] = await Promise.all([
        getLifeLedgerEvidence(review, selection),
        Promise.all([listCategories('expense'), listCategories('income')]).then(groups => groups.flat()), listAccounts(true),
      ]);
      if (closed || !sheet || !options.isActive()) return;
      const el = sheet;
      const categoryMap = new Map(categories.map(category => [category.id, category]));
      const accountMap = new Map(accounts.map(account => [account.id, account.name]));
      const summary = summarizeLedgerEntries(evidence.items, { reimburseMode: evidence.summary.reimbursementMode });
      el.querySelector<HTMLElement>('[data-ledger-evidence-content]')!.innerHTML = `<p class="life-ledger-evidence-summary" data-ledger-evidence-summary>${esc(evidence.label)}<br>${evidence.items.length} 笔 · ${selection.type === 'income' ? `收入 ${currency(summary.income)}` : `净支出 ${currency(summary.expense)}`}</p><p class="sub">来自刚才确认的本机范围。点击查看原账单；不会发送给 AI</p><div data-ledger-evidence-rows></div><button class="btn ghost" data-ledger-evidence-more hidden>继续显示明细</button><p class="sub" data-ledger-evidence-status role="status"></p>`;
      let shown = 0;
      const rows = el.querySelector<HTMLElement>('[data-ledger-evidence-rows]')!;
      const more = el.querySelector<HTMLButtonElement>('[data-ledger-evidence-more]')!;
      const renderRows = () => {
        const next = Math.min(shown + 60, evidence.items.length);
        for (const item of evidence.items.slice(shown, next)) {
          const text = entryRowText(item, categoryMap, accountMap);
          const amount = item.type === 'income' ? item.amount : summarizeLedgerEntries([item], { reimburseMode: evidence.summary.reimbursementMode }).expense;
          const row = document.createElement('button');
          row.className = 'life-ledger-evidence-row'; row.dataset.ledgerEntry = String(item.id);
          row.innerHTML = `<span><b>${esc(text.title)}</b><small>${esc(text.meta)}</small>${item.type === 'expense' && item.reimburseStatus === 'done' ? `<small>原额 ${currency(item.amount)} · 已报销 ${currency(item.reimbursedAmount ?? 0)}</small>` : ''}${item.kind === 'reimbursement' ? '<small>报销到账，点击查看原支出</small>' : ''}</span><b>${currency(amount)}</b>`;
          row.onclick = async () => {
            if (closed || row.disabled) return;
            row.disabled = true;
            try {
              await getLifeLedgerEvidence(review, selection);
              if (closed) return;
              closeSheet(); openEntryDetail(item.id);
            } catch (error) {
              if (!closed) el.querySelector<HTMLElement>('[data-ledger-evidence-status]')!.textContent = error instanceof Error ? error.message : '账本已变化，请重新分析';
            } finally { if (!closed) row.disabled = false; }
          };
          rows.append(row);
        }
        shown = next; more.hidden = shown >= evidence.items.length;
        more.textContent = `继续显示明细（已显示 ${shown} / ${evidence.items.length}）`;
        if (!evidence.items.length) rows.textContent = '此范围暂无账单';
      };
      more.onclick = renderRows;
      renderRows();
    } catch (error) {
      if (!closed) { closeSheet(); options.onError(error instanceof Error ? error.message : '暂时无法核对明细'); }
    }
    finally { if (button.isConnected) button.disabled = false; }
  });
}
