import { describe, expect, it } from 'vitest';
import { positiveComposition, compositionPercent } from '../src/features/report/reportComposition';

describe('报表正净额占比', () => {
  it('退款净额单列，图和排行使用相同正净额基数且可核对净支出', () => {
    const composition = positiveComposition([{ amount: 6_000 }, { amount: 4_000 }, { amount: -2_000 }]);
    expect(composition).toEqual({ positive: 10_000, refund: 2_000, net: 8_000 });
    expect(compositionPercent(6_000, composition.positive)).toBe(60);
    expect(compositionPercent(4_000, composition.positive)).toBe(40);
    expect(compositionPercent(-2_000, composition.positive)).toBeNull();
  });

  it('净支出为零或负数时正净额仍能正常分配占比', () => {
    for (const refund of [-10_000, -15_000]) {
      const composition = positiveComposition([{ amount: 10_000 }, { amount: refund }]);
      expect(compositionPercent(10_000, composition.positive)).toBe(100);
      expect(composition.net).toBe(10_000 + refund);
    }
  });

  it('仅退款、零金额和空列表不生成 NaN 或无穷占比', () => {
    for (const rows of [[], [{ amount: 0 }], [{ amount: -100 }]]) {
      const composition = positiveComposition(rows);
      expect(composition.positive).toBe(0);
      expect(compositionPercent(0, composition.positive)).toBeNull();
      expect(compositionPercent(-100, composition.positive)).toBeNull();
    }
  });

  it('单维度重复关联的金额构成自成基数，不改写各项金额', () => {
    const rows = [{ amount: 10_000 }, { amount: 10_000 }, { amount: -3_000 }];
    const before = JSON.stringify(rows);
    const composition = positiveComposition(rows);
    expect(compositionPercent(10_000, composition.positive)).toBe(50);
    expect(JSON.stringify(rows)).toBe(before);
  });
});
