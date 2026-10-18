import { describe, expect, it } from 'vitest';
import { balanceTrendHtml, smoothTrendPath } from '../src/features/account/balanceTrend';

describe('平滑趋势线保持真实走势', () => {
  for (const ys of [[8, 104, 8, 8, 8], [8, 8, 8], [104, 8, 100, 8, 104], [8, 16, 96, 104], [104, 96, 16, 8]]) {
    it(`经过每个观测点且不制造超出相邻值的峰谷 ${ys}`, () => {
      const points = ys.map((y, i) => ({ x: i * 50, y }));
      const before = structuredClone(points);
      const commands = smoothTrendPath(points).match(/[MC][^MC]+/g)!;
      const numbers = (command: string) => command.slice(1).trim().split(/[\s,]+/).map(Number);
      expect(numbers(commands[0])).toEqual([points[0].x, points[0].y]);
      expect(commands).toHaveLength(points.length);
      for (let i = 1; i < commands.length; i++) {
        const [x1, y1, x2, y2, x, y] = numbers(commands[i]);
        const start = points[i - 1], end = points[i];
        expect([x, y]).toEqual([end.x, end.y]);
        expect([x1, y1, x2, y2, x, y].every(Number.isFinite)).toBe(true);
        let previous = start.y;
        for (let t = 0; t <= 1; t += 0.025) {
          const value = (1 - t) ** 3 * start.y + 3 * (1 - t) ** 2 * t * y1 + 3 * (1 - t) * t ** 2 * y2 + t ** 3 * y;
          expect(value).toBeGreaterThanOrEqual(Math.min(start.y, end.y) - 1e-8);
          expect(value).toBeLessThanOrEqual(Math.max(start.y, end.y) + 1e-8);
          if (end.y >= start.y) expect(value).toBeGreaterThanOrEqual(previous - 1e-8);
          else expect(value).toBeLessThanOrEqual(previous + 1e-8);
          previous = value;
        }
      }
      expect(points).toEqual(before);
    });
  }
  it('空序列及单点不编造连接线', () => {
    expect(smoothTrendPath([])).toBe('');
    expect(smoothTrendPath([{ x: 8, y: 30 }])).toBe('M 8,30');
  });
});

describe('账户趋势展示', () => {
  for (const amounts of [[0, 0, 0], [-300, -200, -100], [100, 200, 300], [-100, 0, 100], [1, 1, 1], [9000000000000, 0, -9000000000000]]) {
    it(`支持零值、正负值与大金额 ${amounts}`, () => {
      const trend = amounts.map((net, i) => ({ month: `2026-0${i + 1}`, net }));
      const before = structuredClone(trend);
      const html = balanceTrendHtml(trend);
      expect(html).not.toMatch(/NaN|Infinity/);
      expect(html).toContain('各月月末值');
      expect(html.match(/<li>/g)).toHaveLength(3);
      expect(trend).toEqual(before);
    });
  }
  it('准确保留每月金额的分位和跨年日期', () => {
    const html = balanceTrendHtml([{ month: '2025-12', net: 101 }, { month: '2026-01', net: -102 }]);
    expect(html).toContain('2025年12月');
    expect(html).toContain('2026年1月');
    expect(html).toContain('-¥1.02');
    expect(html).toContain('-¥2.03');
  });
  it('数据不足时不生成误导折线', () => {
    expect(balanceTrendHtml([])).toBe('');
  });
});
