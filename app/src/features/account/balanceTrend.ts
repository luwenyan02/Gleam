import { esc } from '../../core/esc';
import { formatFen, formatFenCny } from '../../core/money';
import { openMonthWheel } from '../../shared/dateTimeWheel';
import { iconHtml } from '../../assets/icons';

/** 仅负责展示；历史月为月末值，最后一月为当前值，金额仍来自同一仓库。 */
export interface TrendViewState { open: boolean; endingMonth?: string }

export function currentTrendMonth(): string {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

/** 由父页面委托事件，重绘、切页时保留折叠与历史月份。 */
export function bindTrendControls(root: HTMLElement, state: TrendViewState, refresh: () => void | Promise<void>): void {
  root.addEventListener('toggle', event => {
    const target = event.target as HTMLElement;
    if (target.matches('.balance-trend')) state.open = (target as HTMLDetailsElement).open;
  }, true);
  root.addEventListener('click', event => {
    const monthButton = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-trend-month]');
    if (monthButton) {
      const [year, month] = monthButton.value.split('-').map(Number);
      const [maxYear, maxMonth] = currentTrendMonth().split('-').map(Number);
      const picker = openMonthWheel({
        title: '选择趋势结束月份',
        initial: { year, month },
        minDate: { year: 1900, month: 1 },
        maxDate: { year: maxYear, month: maxMonth },
        onConfirm: result => {
          state.endingMonth = `${result.year}-${String(result.month).padStart(2, '0')}`;
          void Promise.resolve(refresh()).then(() => {
            root.querySelector<HTMLButtonElement>('[data-trend-month]')?.focus();
          });
        },
      });
      document.body.appendChild(picker);
      return;
    }
    const button = (event.target as HTMLElement).closest<HTMLElement>('[data-trend-shift]');
    if (!button) return;
    const date = new Date(`${state.endingMonth ?? currentTrendMonth()}-01T12:00:00`);
    date.setMonth(date.getMonth() + Number(button.dataset.trendShift));
    const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    state.endingMonth = month < '1900-01' ? '1900-01' : month > currentTrendMonth() ? currentTrendMonth() : month;
    refresh();
  });
}

export function balanceTrendHtml(trend: { month: string; net: number }[], metric = '净资产', state: TrendViewState = { open: false }): string {
  if (trend.length < 2) return '';
  const values = trend.map(point => point.net);
  let low = Math.min(0, ...values), high = Math.max(0, ...values);
  if (high === low) { low = -100; high = 100; }
  const magnitude = 10 ** Math.floor(Math.log10((high - low) / 2));
  const step = Math.ceil((high - low) / 2 / magnitude) * magnitude;
  low = Math.floor(low / step) * step;
  high = Math.ceil(high / step) * step;
  const y = (net: number) => 8 + (high - net) / (high - low) * 96;
  const points = trend.map((point, i) => ({ x: 8 + i * 284 / (trend.length - 1), y: y(point.net) }));
  const last = points[points.length - 1];
  const ticks = [high, (high + low) / 2, low];
  const compact = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 2 });
  const axisLabel = (fen: number) => compact.format(Number(formatFen(fen).replaceAll(',', '')));
  const monthLabel = (month: string) => `${Number(month.split('-')[1])}月`;
  const delta = values[values.length - 1] - values[values.length - 2];
  const change = delta === 0 ? '无变化' : `${delta > 0 ? '+' : ''}${formatFenCny(delta)}`;
  const endMonth = trend[trend.length - 1].month;
  const current = endMonth === currentTrendMonth();
  return `<details class="balance-trend" ${state.open ? 'open' : ''} aria-label="${esc(metric)}走势">
    <summary class="balance-trend-heading"><strong>${esc(metric)}走势</strong><span class="trend-expand">展开</span><span class="trend-collapse">收起</span></summary>
    <div class="balance-trend-controls">
      <button type="button" data-trend-shift="-6" aria-label="前六个月" ${endMonth <= '1900-01' ? 'disabled' : ''}>‹</button>
      <button type="button" class="trend-month-button" data-trend-month aria-label="选择趋势结束月份" aria-haspopup="dialog" value="${esc(endMonth)}">${iconHtml('ic-cal', 16)}<span>${esc(endMonth.split('-')[0])}年${Number(endMonth.split('-')[1])}月</span></button>
      <button type="button" data-trend-shift="6" aria-label="后六个月" ${current ? 'disabled' : ''}>›</button>
    </div>
    <p class="balance-trend-range">${esc(trend[0].month)} — ${esc(endMonth)} · 元</p>
    <div class="balance-trend-chart">
      <div class="balance-trend-axis" aria-hidden="true">${ticks.map(tick => `<span>${axisLabel(tick)}</span>`).join('')}</div>
      <div class="balance-trend-plot">
        <svg viewBox="0 0 300 112" preserveAspectRatio="none" role="img" aria-label="${esc(metric)}月度走势，具体金额见下方每月金额">
          ${ticks.map(tick => `<line class="balance-trend-grid${tick === 0 ? ' zero' : ''}" x1="8" x2="292" y1="${y(tick)}" y2="${y(tick)}"/>`).join('')}
          <polyline class="balance-trend-line" points="${points.map(point => `${point.x},${point.y}`).join(' ')}"/>
        </svg>
        <span class="balance-trend-dot" style="left:${last.x / 3}%;top:${last.y / 112 * 100}%" aria-hidden="true"></span>
      </div>
      <div class="balance-trend-months" aria-hidden="true">${trend.map((point, i) => `<span${i === trend.length - 1 ? ' class="current"' : ''}>${monthLabel(point.month)}</span>`).join('')}</div>
    </div>
    <div class="balance-trend-change"><span>较上月末</span><strong class="num">${change}</strong></div>
    <details class="balance-trend-details"><summary>每月金额<span>${current ? '本月截至当前' : '各月月末值'}</span></summary>
      <ul class="balance-trend-values">${trend.map(point => `<li><span>${esc(point.month.split('-')[0])}年${monthLabel(point.month)}</span><strong class="num">${formatFenCny(point.net)}</strong></li>`).join('')}</ul>
    </details>
  </details>`;
}
