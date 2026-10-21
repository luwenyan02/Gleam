import { validateChatChart, type ChatChart } from './chatChart';
import { lifeLedgerCategoryShares, lifeLedgerPeriods, lifeLedgerScopeLabel, type LifeLedgerReview } from './repo/lifeLedgerContextRepo';

export function isChatChartQuestion(question: string): boolean {
  return /图表|柱状图|条形图|折线图|饼图|环形图|(?:画|绘制|生成|做|转成).{0,40}图/.test(question);
}

/** 金额只来自本轮已确认的本机快照；不采用模型给出的图表数值。 */
export function ledgerChatChart(review: LifeLedgerReview): ChatChart | undefined {
  if (!isChatChartQuestion(review.question)) return;
  try { return ledgerChart(review); } catch { return undefined; }
}

function ledgerChart(review: LifeLedgerReview): ChatChart {
  const periods = lifeLedgerPeriods(review);
  const summary = review.summary;
  const trend = periods.length > 1 || /收支|收入/.test(review.question);
  let labels: string[];
  let series: ChatChart['series'];
  if (trend) {
    labels = periods.map(period => period.scope.period === 'recent' ? '近30天' : period.scope.month);
    series = [{ name: '净支出', values: periods.map(period => period.totals.expenseFen) }];
    if (periods.every(period => period.income)) series.push({ name: '收入', values: periods.map(period => period.income!.incomeFen) });
  } else {
    const categories = summary.categories;
    labels = categories.slice(0, categories.length > 24 ? 23 : 24).map(row => {
      const label = Array.from(row.name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim() || '未命名分类');
      return label.length > 48 ? label.slice(0, 47).join('') + '…' : label.join('');
    });
    const values = categories.slice(0, labels.length).map(row => row.expenseFen);
    if (categories.length > 24) {
      labels.push('其他');
      values.push(categories.slice(23).reduce((total, row) => total + row.expenseFen, 0));
    }
    if (!labels.length) { labels.push('暂无支出'); values.push(0); }
    series = [{ name: '净支出', values }];
  }
  const donut = !trend && lifeLedgerCategoryShares(summary).every(value => value !== null)
    && /饼图|环形图|占比/.test(review.question) && series.length === 1
    && series[0].values.every(value => value >= 0) && series[0].values.some(value => value > 0);
  return validateChatChart({ version: 1, type: donut ? 'donut' : /折线/.test(review.question) ? 'line' : 'bar',
    title: `${lifeLedgerScopeLabel(summary.scope)}${summary.analysis?.kind === 'trend' ? ' · 近6月' : summary.analysis?.kind === 'compare' ? ' · 月度对比' : ''}${trend ? '收支' : '支出分类'}`,
    labels, series, unit: '元', valueDivisor: 100 });
}

export function chatChartInstruction(question: string, ledger: boolean): string {
  if (!isChatChartQuestion(question)) return '';
  if (ledger) return '\n用户请求绘图：客户端会用本次已确认的本机汇总生成图表；你只解释数据，不输出图表代码或另造数值。';
  return '\n用户请求绘图：有明确数据时，简短说明后附一个完整的 ```gleam-chart 代码块，内容为JSON：'
    + '{"version":1,"type":"bar","title":"标题","labels":["甲","乙"],"series":[{"name":"数值","values":[1,2]}],"unit":"个"}。'
    + 'type只支持bar、line、donut；1至24个分类、1至4组等长有限数值，标题不超过80字、分类48字、系列40字、单位16字；donut只允许一组非负且总量大于零的数据。'
    + '选择合适图形；超过24类先说明并合并。只使用用户明确提供或已核实的数据，不编造账本、比例、预测或缺失数值；无数据先索取。'
    + '不输出可执行脚本、图片URL或Python；无需调用生图服务。';
}
