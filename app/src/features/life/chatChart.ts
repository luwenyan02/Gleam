import { validateChatChart, type ChatChart } from '../../core/chatChart';

const palette = ['#D84924', '#087F73', '#725BE8', '#3985D5', '#A36522', '#C64276'];
const font = 'system-ui,-apple-system,"PingFang SC","Noto Sans CJK SC","Microsoft YaHei",sans-serif';
const esc = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const chunks = (text: string, length: number): string[] => {
  const letters = Array.from(text);
  return Array.from({ length: Math.ceil(letters.length / length) }, (_, i) => letters.slice(i * length, (i + 1) * length).join(''));
};
const amount = (chart: ChatChart, value: number | bigint): string => {
  if (chart.valueDivisor === 100) {
    const cents = typeof value === 'bigint' ? value : BigInt(value);
    const absolute = cents < 0n ? -cents : cents;
    return `${cents < 0n ? '-' : ''}${(absolute / 100n).toLocaleString('zh-CN')}.${String(absolute % 100n).padStart(2, '0')}${chart.unit ?? ''}`;
  }
  const formatted = typeof value === 'number' && value !== 0 && Math.abs(value) < 1e-6 ? String(value) : value.toLocaleString('zh-CN', { maximumFractionDigits: 20 });
  return `${formatted}${chart.unit ?? ''}`;
};
const selection = (chart: ChatChart, index: number) => `${chart.labels[index]}：${chart.series.map(row => `${row.name} ${amount(chart, row.values[index])}`).join('；')}`;

type Shape =
  | { kind: 'line'; x: number; y: number; x2: number; y2: number; color: string; width: number }
  | { kind: 'rect'; x: number; y: number; w: number; h: number; color: string }
  | { kind: 'circle'; x: number; y: number; r: number; color: string }
  | { kind: 'arc'; x: number; y: number; r: number; start: number; end: number; color: string; width: number; hit: number }
  | { kind: 'text'; x: number; y: number; text: string; color: string; align: 'start' | 'middle' | 'end'; size: number };
interface Geometry { width: number; height: number; shapes: Shape[]; hits?: Array<{ index: number; x: number; width: number }> }

/** Shared primitives keep the SVG preview and the Canvas export on the same scale. */
function geometry(chart: ChatChart): Geometry {
  const shapes: Shape[] = [];
  if (chart.type === 'donut') {
    const total = chart.series[0].values.reduce((sum, value) => sum + value, 0);
    let start = -Math.PI / 2;
    chart.series[0].values.forEach((value, i) => {
      const end = start + value / total * Math.PI * 2;
      if (value > 0) shapes.push({ kind: 'arc', x: 160, y: 120, r: 80, start, end, width: 36, color: palette[i % palette.length], hit: i });
      start = end;
    });
    shapes.push({ kind: 'text', x: 160, y: 117, text: '合计', color: '#424852', size: 13, align: 'middle' });
    const compactTotal = (total / (chart.valueDivisor ?? 1)).toLocaleString('zh-CN', { notation: 'compact', maximumFractionDigits: 2 });
    shapes.push({ kind: 'text', x: 160, y: 139, text: compactTotal, color: '#202124', size: 13, align: 'middle' });
    return { width: 320, height: 250, shapes };
  }
  const width = Math.max(320, 104 + chart.labels.length * 88);
  const values = chart.series.flatMap(row => row.values);
  const min = Math.min(0, ...values);
  const dataMax = Math.max(0, ...values);
  const max = dataMax === min ? min + 1 : dataMax;
  const range = max - min;
  const y = (value: number) => 24 + (max - value) / range * 180;
  const left = 104, right = width - 16, step = (right - left) / chart.labels.length;
  const x = (i: number) => left + step * (i + 0.5);
  for (let tick = 0; tick <= 4; tick++) {
    const value = max - range * tick / 4;
    const py = 24 + 45 * tick;
    shapes.push({ kind: 'line', x: left, y: py, x2: right, y2: py, color: '#E6E9EE', width: 1 });
    const label = (value / (chart.valueDivisor ?? 1)).toLocaleString('zh-CN', { notation: 'compact', maximumFractionDigits: 1 });
    shapes.push({ kind: 'text', x: left - 8, y: py + 4, text: label, color: '#424852', size: 12, align: 'end' });
  }
  shapes.push({ kind: 'line', x: left, y: y(0), x2: right, y2: y(0), color: '#535862', width: 1 });
  chart.series.forEach((row, s) => {
    const color = palette[s];
    row.values.forEach((value, i) => {
      if (chart.type === 'bar') {
        const w = Math.min(22, (step - 16) / chart.series.length);
        shapes.push({ kind: 'rect', x: x(i) + (s - chart.series.length / 2) * w, y: Math.min(y(0), y(value)), w: Math.max(2, w - 3), h: Math.max(1, Math.abs(y(value) - y(0))), color });
      } else {
        if (i) shapes.push({ kind: 'line', x: x(i - 1), y: y(row.values[i - 1]), x2: x(i), y2: y(value), color, width: 2.5 });
        shapes.push({ kind: 'circle', x: x(i), y: y(value), r: 4, color });
      }
    });
  });
  let maxLines = 1;
  chart.labels.forEach((label, i) => {
    const lines = chunks(label, 6); maxLines = Math.max(maxLines, lines.length);
    lines.forEach((text, j) => shapes.push({ kind: 'text', x: x(i), y: 228 + j * 17, text, color: '#424852', size: 12, align: 'middle' }));
  });
  return { width, height: 240 + maxLines * 17, shapes, hits: chart.labels.map((_, index) => ({ index, x: left + step * index, width: step })) };
}

function svgShape(shape: Shape): string {
  switch (shape.kind) {
    case 'rect': return `<rect x="${shape.x}" y="${shape.y}" width="${shape.w}" height="${shape.h}" fill="${shape.color}"/>`;
    case 'line': return `<line x1="${shape.x}" y1="${shape.y}" x2="${shape.x2}" y2="${shape.y2}" stroke="${shape.color}" stroke-width="${shape.width}"/>`;
    case 'circle': return `<circle cx="${shape.x}" cy="${shape.y}" r="${shape.r}" fill="${shape.color}"/>`;
    case 'text': return `<text x="${shape.x}" y="${shape.y}" fill="${shape.color}" text-anchor="${shape.align}" font-size="${shape.size}">${esc(shape.text)}</text>`;
    case 'arc': {
      // Two half arcs also handle a single 100% segment without a degenerate path.
      const middle = (shape.start + shape.end) / 2;
      const point = (angle: number) => `${shape.x + shape.r * Math.cos(angle)} ${shape.y + shape.r * Math.sin(angle)}`;
      return `<path data-chart-hit="${shape.hit}" d="M ${point(shape.start)} A ${shape.r} ${shape.r} 0 0 1 ${point(middle)} A ${shape.r} ${shape.r} 0 0 1 ${point(shape.end)}" fill="none" stroke="${shape.color}" stroke-width="${shape.width}"/>`;
    }
  }
}

function legends(chart: ChatChart): Array<{ color: string; text: string }> {
  return chart.type === 'donut'
    ? [{ color: '#424852', text: `合计 ${amount(chart, chart.valueDivisor === 100 ? chart.series[0].values.reduce((sum, value) => sum + BigInt(value), 0n) : chart.series[0].values.reduce((sum, value) => sum + value, 0))}` }, ...chart.labels.map((label, i) => ({ color: palette[i % palette.length], text: `${label} ${amount(chart, chart.series[0].values[i])}` }))]
    : chart.series.map((row, i) => ({ color: palette[i], text: row.name }));
}

export function chatChartHtml(input: ChatChart): string {
  const chart = validateChatChart(input), plot = geometry(chart);
  return `<section class="chat-chart" aria-label="${esc(chart.title)}">
    <h4 class="chat-chart-title">${esc(chart.title)}</h4>
    ${chart.unit ? `<p class="chat-chart-unit">单位：${esc(chart.unit)}</p>` : ''}
    <div class="chat-chart-plot" tabindex="0" role="region" aria-label="图表，可横向滚动；精确值见下方选值和数据表">
      <svg viewBox="0 0 ${plot.width} ${plot.height}" style="min-width:${plot.width}px" role="img" aria-label="${esc(chart.title)}，${chart.type === 'donut' ? '环形图' : chart.type === 'bar' ? '柱状图' : '折线图'}"><title>${esc(chart.title)}</title>${plot.shapes.map(svgShape).join('')}${plot.hits?.map(hit => `<rect data-chart-hit="${hit.index}" x="${hit.x}" y="20" width="${hit.width}" height="190" fill="transparent"/>`).join('') ?? ''}</svg>
    </div>
    <ul class="chat-chart-legend">${legends(chart).map(item => `<li><span style="background:${item.color}" aria-hidden="true"></span>${esc(item.text)}</li>`).join('')}</ul>
    <p class="chat-chart-hint">点击图形或选择分类查看数值，可左右滑动</p>
    <div class="chat-chart-picker" role="group" aria-label="选择分类">${chart.labels.map((label, index) => `<button type="button" data-chart-select="${index}" data-chart-value="${esc(selection(chart, index))}" aria-pressed="${index === 0}">${esc(label)}</button>`).join('')}</div>
    <p class="chat-chart-value" data-chat-chart-value aria-live="polite" aria-atomic="true">${esc(selection(chart, 0))}</p>
    <details class="chat-chart-data"><summary>查看数据表</summary><div class="chat-chart-table" tabindex="0" role="region" aria-label="${esc(chart.title)}数据表"><table><caption>${esc(chart.title)}${chart.unit ? `（${esc(chart.unit)}）` : ''}</caption><thead><tr><th scope="col">分类</th>${chart.series.map(row => `<th scope="col">${esc(row.name)}</th>`).join('')}</tr></thead><tbody>${chart.labels.map((label, i) => `<tr><th scope="row">${esc(label)}</th>${chart.series.map(row => `<td>${esc(amount(chart, row.values[i]))}</td>`).join('')}</tr>`).join('')}</tbody></table></div></details>
  </section>`;
}

const bound = new WeakSet<HTMLElement>();
export function bindChatCharts(container: HTMLElement): void {
  if (bound.has(container)) return;
  bound.add(container);
  const select = (button: HTMLElement) => {
    const chart = button.closest<HTMLElement>('.chat-chart');
    if (!chart) return;
    chart.querySelectorAll<HTMLElement>('[data-chart-select]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    const output = chart.querySelector<HTMLElement>('.chat-chart-value');
    if (output) output.textContent = button.dataset.chartValue ?? '';
  };
  container.addEventListener('click', event => {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement | SVGElement>('[data-chart-select], [data-chart-hit]') : null;
    if (!target || !container.contains(target)) return;
    const button = target.hasAttribute('data-chart-select') ? target as HTMLElement
      : Array.from(target.closest('.chat-chart')?.querySelectorAll<HTMLElement>('[data-chart-select]') ?? []).find(item => item.dataset.chartSelect === target.dataset.chartHit);
    if (button) select(button);
  });
  container.addEventListener('keydown', event => {
    const button = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-chart-select]') : null;
    if (!button || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const buttons = Array.from(button.closest('.chat-chart-picker')!.querySelectorAll<HTMLButtonElement>('button'));
    const current = buttons.indexOf(button as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
    event.preventDefault(); buttons[next].focus(); select(buttons[next]);
    buttons[next].scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  });
}

function drawShape(ctx: CanvasRenderingContext2D, shape: Shape): void {
  ctx.fillStyle = shape.color; ctx.strokeStyle = shape.color;
  switch (shape.kind) {
    case 'text': ctx.font = `${shape.size}px ${font}`; ctx.textAlign = shape.align === 'middle' ? 'center' : shape.align === 'end' ? 'right' : 'left'; ctx.fillText(shape.text, shape.x, shape.y); break;
    case 'rect': ctx.fillRect(shape.x, shape.y, shape.w, shape.h); break;
    case 'circle': ctx.beginPath(); ctx.arc(shape.x, shape.y, shape.r, 0, Math.PI * 2); ctx.fill(); break;
    case 'line': ctx.lineWidth = shape.width; ctx.beginPath(); ctx.moveTo(shape.x, shape.y); ctx.lineTo(shape.x2, shape.y2); ctx.stroke(); break;
    case 'arc': ctx.lineWidth = shape.width; ctx.beginPath(); ctx.arc(shape.x, shape.y, shape.r, shape.start, shape.end); ctx.stroke(); break;
  }
}

export async function chatChartPng(input: ChatChart): Promise<Blob> {
  const chart = validateChatChart(input), plot = geometry(chart);
  const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('当前设备无法生成图表图片');
  const width = Math.max(640, plot.width + 48);
  const shapes: Shape[] = [];
  let top = 38;
  const textLines = (text: string, maxWidth: number, size: number): string[] => {
    ctx.font = `${size}px ${font}`;
    const lines: string[] = []; let line = '';
    for (const char of Array.from(text)) {
      if (line && ctx.measureText(line + char).width > maxWidth) { lines.push(line); line = ''; }
      line += char;
    }
    if (line) lines.push(line);
    return lines;
  };
  const addText = (text: string, size: number, indent = 24) => {
    for (const line of textLines(text, width - indent - 24, size)) {
      shapes.push({ kind: 'text', x: indent, y: top, text: line, color: '#202124', size, align: 'start' }); top += size + 9;
    }
  };
  addText(chart.title, 23);
  if (chart.unit) addText(`单位：${chart.unit}`, 14);
  const plotTop = top + 8; top = plotTop + plot.height + 28;
  for (const item of legends(chart)) {
    shapes.push({ kind: 'rect', x: 24, y: top - 12, w: 12, h: 12, color: item.color });
    addText(item.text, 15, 46);
  }
  // A complete value list makes saved images useful without interactive selection.
  top += 12;
  chart.labels.forEach((_, i) => addText(selection(chart, i), 14));
  canvas.width = width * 2; canvas.height = (top + 20) * 2;
  ctx.scale(2, 2); ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, width, top + 20);
  ctx.save(); ctx.translate((width - plot.width) / 2, plotTop); plot.shapes.forEach(shape => drawShape(ctx, shape)); ctx.restore();
  shapes.forEach(shape => drawShape(ctx, shape));
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('图表图片生成失败')), 'image/png');
  });
}
