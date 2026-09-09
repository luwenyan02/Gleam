import { describe, expect, it } from 'vitest';
import { expandCategoryIds, parseAmountRange, validateDateRange } from '../src/core/queryValidation';

describe('统一筛选输入', () => {
  it('大类包含子类且不重复', () => {
    expect(expandCategoryIds([1, 2], [{ id: 1 }, { id: 2, parentId: 1 }, { id: 3, parentId: 1 }, { id: 4 }])).toEqual([1, 2, 3]);
  });
  it('金额区间使用精确分并允许单侧不限', () => {
    expect(parseAmountRange('0.01', '12.34')).toEqual({ amountMin: 1, amountMax: 1234 });
    expect(parseAmountRange('', '0')).toEqual({ amountMin: undefined, amountMax: 0 });
  });
  it.each([['-1', '2'], ['1e2', '200'], ['1.001', '2'], ['3', '2']])('拒绝非法区间 %s %s', (min, max) => {
    expect(() => parseAmountRange(min, max)).toThrow();
  });
  it('拒绝倒置日期且允许单日', () => {
    expect(() => validateDateRange(2, 1)).toThrow();
    expect(() => validateDateRange(1, 1)).not.toThrow();
  });
});
