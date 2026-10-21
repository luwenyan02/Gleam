import { describe, expect, it, vi } from 'vitest';
import { parseChatChartResponse, validateChatChart, type ChatChart } from '../src/core/chatChart';
import { chatChartHtml, chatChartPng } from '../src/features/life/chatChart';
const chart: ChatChart = { version: 1, type: 'bar', title: '每月收支', labels: ['一月', '二月'], series: [{ name: '净额', values: [12345, -200] }], unit: '元', valueDivisor: 100 };
const fence = (value: unknown) => '```gleam-chart\n' + JSON.stringify(value) + '\n```';
describe('本地图表有限协议', () => {
  it('仅移除完整有效的图表，保留正文和原始整数分', () => {
    expect(parseChatChartResponse('分析\n' + fence(chart) + '\n说明')).toEqual({ text: '分析\n\n说明', chart });
    expect(validateChatChart(chart).series[0].values).toEqual([12345, -200]);
  });
  it('代码、URL字段、损坏、未完成及多图表均回退原文', () => {
    for (const text of ['```gleam-chart\n{}', fence({ ...chart, url: 'https://example.com' }), '```gleam-chart\nalert(1)\n```', fence(chart) + '\n' + fence(chart)]) expect(parseChatChartResponse(text)).toEqual({ text });
  });
  it('严格拒绝未知字段、非有限值、过长文本和越界维度', () => {
    for (const invalid of [null, [], { ...chart, version: 2 }, { ...chart, extra: 1 }, { ...chart, title: 'a'.repeat(81) }, { ...chart, labels: [] }, { ...chart, labels: Array(25).fill('月') }, { ...chart, series: [] }, { ...chart, series: Array(5).fill(chart.series[0]) }, { ...chart, series: [{ name: '额', values: [1] }] }, ...[NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 1.25].map(value => ({ ...chart, series: [{ name: '额', values: [value, 0] }] })), { ...chart, valueDivisor: 10 }, { ...chart, unit: '<script>\n' }]) expect(() => validateChatChart(invalid)).toThrow();
  });
  it('严格限制嵌套字段和文字边界，允许有限的小数非金额', () => {
    for (const invalid of [{ ...chart, labels: ['a'.repeat(49), '月'] }, { ...chart, series: [{ name: 'a'.repeat(41), values: [1, 2] }] }, { ...chart, series: [{ name: '额', values: [1, 2], url: 'x' }] }, { ...chart, unit: 'a'.repeat(17) }, { ...chart, type: { toString() { throw new Error('不该执行'); } } }]) expect(() => validateChatChart(invalid)).toThrow();
    expect(validateChatChart({ ...chart, valueDivisor: 1, series: [{ name: '额', values: [0.125, 0] }] }).series[0].values[0]).toBe(0.125);
  });
  it('拒绝稀疏数组和过大响应体，兼容CRLF围栏', () => {
    for (const invalid of [{ ...chart, labels: Array(2) }, { ...chart, series: Array(1) }, { ...chart, series: [{ name: '额', values: Array(2) }] }]) expect(() => validateChatChart(invalid)).toThrow();
    const oversized = '```gleam-chart\n' + ' '.repeat(32769) + JSON.stringify(chart) + '\n```';
    expect(parseChatChartResponse(oversized)).toEqual({ text: oversized });
    expect(parseChatChartResponse(fence(chart).replaceAll('\n', '\r\n')).chart).toEqual(chart);
  });
  it('环形图仅接受单组非负且非全零数据', () => {
    for (const values of [[0, 0], [-1, 2]]) expect(() => validateChatChart({ ...chart, type: 'donut', series: [{ name: '分类', values }] })).toThrow();
    expect(() => validateChatChart({ ...chart, type: 'donut', series: [chart.series[0], chart.series[0]] })).toThrow();
    expect(validateChatChart({ ...chart, type: 'donut', series: [{ name: '分类', values: [0, 100] }] }).type).toBe('donut');
  });
  it('接受边界维度并返回独立副本', () => {
    const input = { ...chart, labels: Array.from({ length: 24 }, (_, i) => String(i)), series: Array.from({ length: 4 }, (_, i) => ({ name: String(i), values: Array(24).fill(0) })) };
    const parsed = validateChatChart(input); parsed.series[0].values[0] = 1;
    expect(input.series[0].values[0]).toBe(0);
  });
});
describe('本地图表呈现与导出', () => {
  it('转义SVG，提供精确金额、键盘选值与数据表', () => {
    const html = chatChartHtml({ ...chart, title: '<img src=x>', labels: ['<b>一月</b>', '二月'] });
    expect(html).toContain('&lt;img src=x&gt;'); expect(html).not.toContain('<img');
    expect(html).toContain('<svg'); expect(html).toContain('123.45元'); expect(html).toContain('-2.00元');
    expect(html).toContain('data-chart-select="0"'); expect(html).toContain('aria-live="polite"'); expect(html).toContain('<table');
    expect(html).not.toMatch(/NaN|Infinity|foreignObject|https?:\/\//);
  });
  it('柱形折线提供不小于44px的分类命中区，环形仅给非零片段命中', () => {
    for (const type of ['bar', 'line'] as const) {
      const html = chatChartHtml({ ...chart, type });
      const hits = [...html.matchAll(/<rect data-chart-hit="(\d+)"[^>]*width="([^"]+)"[^>]*>/g)];
      expect(hits.map(hit => hit[1])).toEqual(['0', '1']);
      expect(hits.every(hit => Number(hit[2]) >= 44)).toBe(true);
      expect(hits.every(hit => !/role="button"|tabindex/.test(hit[0]))).toBe(true);
    }
    const donut = chatChartHtml({ ...chart, type: 'donut', series: [{ name: '额', values: [0, 100] }] });
    expect(donut).not.toContain('data-chart-hit="0"');
    expect(donut).toContain('data-chart-hit="1"');
    expect(donut).toContain('data-chart-select="0"');
  });
  it('最大安全整数分的尾数不因浮点除法丢失，环形图合计也保留精度', () => {
    const large = { ...chart, type: 'donut' as const, series: [{ name: '额', values: [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER] }] };
    const html = chatChartHtml(large);
    expect(html).toContain('90,071,992,547,409.91元');
    expect(html).toContain('180,143,985,094,819.82元');
  });
  it('零值、负数、长标签、多系列和单项环形图几何均有限', () => {
    for (const type of ['bar', 'line'] as const) {
      const html = chatChartHtml({ ...chart, type, labels: ['很长的分类名称需要完整显示', '零值'], series: [{ name: '甲', values: [0, 0] }, { name: '乙', values: [-100, 100] }] });
      expect(html).not.toMatch(/NaN|Infinity/); expect(html).toContain('很长的分类名称需要完整显示');
    }
    expect(chatChartHtml({ ...chart, type: 'donut', labels: ['全部'], series: [{ name: '额', values: [100] }] })).not.toMatch(/NaN|Infinity/);
  });
  it('Canvas不可用或编码失败时返回明确失败', async () => {
    vi.stubGlobal('document', { createElement: () => ({ getContext: () => null }) });
    try { await expect(chatChartPng(chart)).rejects.toThrow('无法生成'); } finally { vi.unstubAllGlobals(); }
    const context = new Proxy({}, { get: (_, key) => key === 'measureText' ? (text: string) => ({ width: text.length * 10 }) : () => {}, set: () => true });
    vi.stubGlobal('document', { createElement: () => ({ getContext: () => context, toBlob: (callback: (blob: null) => void) => callback(null) }) });
    try { await expect(chatChartPng(chart)).rejects.toThrow('生成失败'); } finally { vi.unstubAllGlobals(); }
  });
  it('PNG直接用Canvas绘制，保留中文标题、图例和精确值', async () => {
    const calls: string[] = [];
    const context = new Proxy({}, { get: (_, key) => key === 'measureText' ? (text: string) => ({ width: text.length * 10 }) : (...args: unknown[]) => { if (key === 'fillText') calls.push(String(args[0])); }, set: () => true });
    const png = new Blob(['png'], { type: 'image/png' });
    vi.stubGlobal('document', { createElement: vi.fn(() => ({ width: 0, height: 0, getContext: () => context, toBlob: (callback: (value: Blob) => void) => callback(png) })) });
    try {
      expect(await chatChartPng(chart)).toBe(png); expect(calls.join('')).toContain('每月收支'); expect(calls.join('')).toContain('净额'); expect(calls.join('')).toContain('123.45元');
    } finally { vi.unstubAllGlobals(); }
  });
});
