import { formatFen, formatFenCny } from '../../core/money';
import { getSpendingRhythm } from '../../core/repo/spendingRhythmRepo';
import { openLedgerSearch } from '../search/search';

export function spendingRhythmHtml(): string {
  return `<details class="card spending-rhythm" id="hm-rhythm" hidden>
    <summary>
      <span class="rhythm-heading"><strong>消费节奏</strong><span class="rhythm-period">最近 7 天</span></span>
      <span class="rhythm-total">净支出 <strong class="num" id="rhythm-total">—</strong></span>
    </summary>
    <div class="rhythm-days" aria-label="每日净支出，点日期查看明细"></div>
  </details>`;
}

export function bindSpendingRhythm(el: HTMLElement): void {
  el.querySelector('#hm-rhythm')!.addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-rhythm-from]');
    if (!button) return;
    openLedgerSearch({ from: Number(button.dataset.rhythmFrom), to: Number(button.dataset.rhythmTo), types: ['expense'] }, `${button.dataset.rhythmDate} · 支出明细`);
  });
}

export async function refreshSpendingRhythm(el: HTMLElement): Promise<void> {
  const result = await getSpendingRhythm();
  if (!el.isConnected) return;
  const card = el.querySelector<HTMLElement>('#hm-rhythm')!;
  card.querySelector('#rhythm-total')!.textContent = formatFenCny(result.expense);
  const days = card.querySelector<HTMLElement>('.rhythm-days')!;
  // Retain button identity, focus, scroll position and expanded state on same-day refresh.
  const keys = result.days.map(day => day.key).join(',');
  if (days.dataset.keys !== keys) {
    days.innerHTML = result.days.map(day => `<button type="button" class="rhythm-day" data-rhythm-from="${day.from}" data-rhythm-to="${day.to}" data-rhythm-date="${day.key}">
      <span class="rhythm-date"></span><span class="rhythm-chart" aria-hidden="true"><span class="rhythm-bar"></span></span>
      <span class="num rhythm-amount"></span><span class="rhythm-count"></span>
    </button>`).join('');
    days.dataset.keys = keys;
  }
  const maximum = Math.max(1, ...result.days.map(day => Math.abs(day.expense)));
  result.days.forEach((day, index) => {
    const button = days.children[index] as HTMLButtonElement;
    const date = new Date(day.from);
    const label = index === 6 ? '今天' : `${date.getMonth() + 1}/${date.getDate()}`;
    button.querySelector('.rhythm-date')!.textContent = label;
    button.querySelector('.rhythm-amount')!.textContent = day.expenseCount ? formatFen(day.expense) : '—';
    button.querySelector('.rhythm-count')!.textContent = day.expenseCount ? `${day.expenseCount} 笔` : '无记录';
    button.setAttribute('aria-label', `${day.key}，${day.expenseCount ? `净支出 ${formatFenCny(day.expense)}，${day.expenseCount} 笔` : '无支出记录'}，查看明细`);
    button.classList.toggle('is-negative', day.expense < 0);
    button.classList.toggle('is-today', index === 6);
    button.style.setProperty('--rhythm-bar-height', `${Math.abs(day.expense) / maximum * 26}px`);
  });
}
