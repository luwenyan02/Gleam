import { esc } from '../../core/esc';
import { monthKey, shiftMonthKey } from '../../core/period';
import { getLifeAiDestination } from '../../core/repo/lifeAiRepo';
import { approveLifeLedgerReview, getLifeLedgerReview, lifeLedgerReviewText, suggestLifeLedgerScope, type LifeLedgerGrant, type LifeLedgerReview } from '../../core/repo/lifeLedgerContextRepo';
import { getSetting, setSetting } from '../../core/repo/settingsRepo';
import { openMonthWheel } from '../../shared/dateTimeWheel';
import { closeSheet, openSheet } from '../shell/sheet';

export interface ConfirmedLifeLedger {
  ledgerGrant: LifeLedgerGrant;
  expectedDestination: { baseUrl: string; model: string };
}

/** 月份与汇总始终先在设备上预览；本次确认不成为后续请求的长期授权。 */
export async function confirmLifeLedgerAi(question: string, signal: AbortSignal): Promise<ConfirmedLifeLedger | false> {
  const [destination, initialScope, enabled] = await Promise.all([
    getLifeAiDestination(), suggestLifeLedgerScope(question), getSetting('life.aiEnabled'),
  ]);
  if (signal.aborted) return false;
  if (!document.getElementById('sheet')) return false;
  return new Promise(resolve => {
    let settled = false;
    let scope = initialScope;
    let review: LifeLedgerReview | undefined;
    let version = 0;
    let picker: HTMLElement | undefined;
    const finish = (result: ConfirmedLifeLedger | false, close = true) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      picker?.querySelector<HTMLElement>('.dw-mask')?.click();
      if (close) closeSheet();
      resolve(result);
    };
    const abort = () => finish(false);
    signal.addEventListener('abort', abort, { once: true });
    openSheet({ ariaLabel: '账本分析范围', onClose: () => finish(false, false), render(el) {
      el.innerHTML = `<div class="sheet-head"><h3>账本分析范围</h3><button class="icon-btn" data-ledger-close aria-label="关闭账本分析">×</button></div>
        <div class="sheet-scroll life-ledger-review">
          <div class="life-ledger-month"><button class="icon-btn" data-ledger-prev aria-label="上个月">‹</button><button class="pick-trigger" data-ledger-month aria-label="选择分析月份"></button><button class="icon-btn" data-ledger-next aria-label="下个月">›</button></div>
          <div class="life-ledger-period" role="group" aria-label="月份口径"><button class="chip" data-ledger-period="calendar">自然月</button><button class="chip" data-ledger-period="accounting">财务月</button></div>
          <label class="lc-check"><input type="checkbox" data-ledger-income ${scope.includeIncome ? 'checked' : ''}>同时包含收入汇总</label>
          <p class="sub">本次仅分析所选月份。自然月从 1 日开始；财务月使用设置中的月起始日。</p>
          <div class="life-ledger-preview" data-ledger-preview aria-live="polite">正在本机汇总…</div>
          <p class="life-ledger-destination">服务：${esc(destination.baseUrl)}<br>模型：${esc(destination.model)}</p>
          <p class="sub">同意后，仅以上问题和汇总会离开设备，服务方的数据处理规则适用。每次分析、重试或重新回答都需要重新确认。</p>
          <p class="sub" data-ledger-error role="status"></p>
          <div class="life-ledger-actions"><button class="btn ghost" data-ledger-cancel>先不发送</button><button class="btn primary" data-ledger-approve disabled>${enabled ? '同意并发送' : '启用 AI 并发送'}</button></div>
        </div>`;
      const preview = el.querySelector<HTMLElement>('[data-ledger-preview]')!;
      const error = el.querySelector<HTMLElement>('[data-ledger-error]')!;
      const approve = el.querySelector<HTMLButtonElement>('[data-ledger-approve]')!;
      const refresh = async () => {
        const currentVersion = ++version;
        review = undefined; approve.disabled = true; error.textContent = ''; preview.textContent = '正在本机汇总…';
        el.querySelector<HTMLElement>('[data-ledger-month]')!.textContent = scope.month.replace('-', ' 年 ') + ' 月';
        el.querySelectorAll<HTMLButtonElement>('[data-ledger-period]').forEach(button => {
          const selected = button.dataset.ledgerPeriod === scope.period;
          button.classList.toggle('active', selected); button.setAttribute('aria-pressed', String(selected));
        });
        try {
          const next = await getLifeLedgerReview(question, scope);
          if (settled || signal.aborted || currentVersion !== version) return;
          review = next;
          preview.textContent = lifeLedgerReviewText(next);
          const count = next.summary.totals.expenseCount + next.summary.totals.refundCount + (next.summary.income?.count ?? 0);
          approve.disabled = count === 0;
          if (!count) error.textContent = '所选范围暂无账单，不会发送 AI 请求。可以换个月份查看。';
        } catch (reason) { if (!settled && currentVersion === version) { preview.textContent = ''; error.textContent = reason instanceof Error ? reason.message : '账本汇总暂时不可用'; } }
      };
      el.querySelectorAll('[data-ledger-close],[data-ledger-cancel]').forEach(button => button.addEventListener('click', () => finish(false)));
      el.querySelector('[data-ledger-prev]')!.addEventListener('click', () => { scope = { ...scope, month: shiftMonthKey(scope.month, -1) }; void refresh(); });
      el.querySelector('[data-ledger-next]')!.addEventListener('click', () => { scope = { ...scope, month: shiftMonthKey(scope.month, 1) }; void refresh(); });
      el.querySelector('[data-ledger-month]')!.addEventListener('click', () => {
        const [year, month] = scope.month.split('-').map(Number);
        picker = openMonthWheel({ title: '分析月份', initial: { year, month }, onCancel: () => { picker = undefined; }, onConfirm: result => {
          picker = undefined;
          if (settled) return;
          scope = { ...scope, month: monthKey(result.year, result.month - 1) }; void refresh();
        } });
        document.body.appendChild(picker);
      });
      el.querySelectorAll<HTMLButtonElement>('[data-ledger-period]').forEach(button => button.addEventListener('click', () => {
        scope = { ...scope, period: button.dataset.ledgerPeriod as 'calendar' | 'accounting' }; void refresh();
      }));
      el.querySelector<HTMLInputElement>('[data-ledger-income]')!.onchange = event => {
        scope = { ...scope, includeIncome: (event.target as HTMLInputElement).checked }; void refresh();
      };
      approve.onclick = async () => {
        if (!review || approve.disabled || settled || signal.aborted) return;
        const selected = review;
        approve.disabled = true;
        try {
          if (!enabled) await setSetting('life.aiEnabled', true);
          if (settled || signal.aborted) return;
          finish({ ledgerGrant: approveLifeLedgerReview(selected, destination), expectedDestination: destination });
        } catch { if (!settled) { error.textContent = '暂时无法启用 AI，请重试'; approve.disabled = false; } }
      };
      void refresh();
    } });
  });
}
