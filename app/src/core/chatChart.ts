/** A deliberately finite, data-only chart protocol. Money stays in integer cents. */
export interface ChatChart {
  version: 1;
  type: 'bar' | 'line' | 'donut';
  title: string;
  labels: string[];
  series: Array<{ name: string; values: number[] }>;
  unit?: string;
  valueDivisor?: 1 | 100;
}

function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).some(key => !keys.includes(key))) throw new Error('图表字段无效');
  return value as Record<string, unknown>;
}
function shortText(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || Array.from(value).length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('图表文字无效');
  return value;
}
export function validateChatChart(input: unknown): ChatChart {
  const obj = record(input, ['version', 'type', 'title', 'labels', 'series', 'unit', 'valueDivisor']);
  if (obj.version !== 1 || (obj.type !== 'bar' && obj.type !== 'line' && obj.type !== 'donut')) throw new Error('图表版本或类型无效');
  if (obj.valueDivisor !== undefined && obj.valueDivisor !== 1 && obj.valueDivisor !== 100) throw new Error('图表单位无效');
  if (!Array.isArray(obj.labels) || obj.labels.length < 1 || obj.labels.length > 24) throw new Error('图表分类数量无效');
  const labels = Array.from(obj.labels, label => shortText(label, 48));
  if (!Array.isArray(obj.series) || obj.series.length < 1 || obj.series.length > 4) throw new Error('图表系列数量无效');
  const series = Array.from(obj.series, item => {
    const row = record(item, ['name', 'values']);
    if (!Array.isArray(row.values) || row.values.length !== labels.length) throw new Error('图表数值数量无效');
    const values = Array.from(row.values, value => {
      if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER || (obj.valueDivisor === 100 && !Number.isSafeInteger(value))) throw new Error('图表数值无效');
      return value;
    });
    return { name: shortText(row.name, 40), values };
  });
  if (obj.type === 'donut' && (series.length !== 1 || series[0].values.some(value => value < 0) || series[0].values.every(value => value === 0))) throw new Error('环形图需要一组非负且总额大于零的数据');
  return { version: 1, type: obj.type as ChatChart['type'], title: shortText(obj.title, 80), labels, series,
    ...(obj.unit !== undefined ? { unit: shortText(obj.unit, 16) } : {}),
    ...(obj.valueDivisor !== undefined ? { valueDivisor: obj.valueDivisor as 1 | 100 } : {}) };
}

export function parseChatChartResponse(text: string): { text: string; chart?: ChatChart } {
  // Ambiguous/multiple or unfinished artifacts stay visible as ordinary text.
  const openings = text.match(/^[ \t]*```gleam-chart[ \t]*\r?$/gm);
  if (openings?.length !== 1) return { text };
  const match = /^[ \t]*```gleam-chart[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```[ \t]*(?=\r?$)/m.exec(text);
  if (!match || match[1].length > 32_768) return { text };
  try {
    const chart = validateChatChart(JSON.parse(match[1]));
    return { text: text.slice(0, match.index) + text.slice(match.index + match[0].length), chart };
  } catch { return { text }; }
}
