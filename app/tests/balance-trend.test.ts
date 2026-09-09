import { describe, expect, it } from 'vitest';
import { balanceTrendHtml } from '../src/features/account/balanceTrend';

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
