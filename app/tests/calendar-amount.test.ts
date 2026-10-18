import { describe, expect, it } from 'vitest';
import { compactCalendarAmount } from '../src/features/calendar/calendarAmount';

describe('日历格金额简写', () => {
  it('普通金额不加千分位以适应七列布局，小于一元保留精度', () => {
    expect(compactCalendarAmount(123_456)).toBe('1234');
    expect(compactCalendarAmount(999_999)).toBe('9999');
    expect(compactCalendarAmount(50)).toBe('0.5');
    expect(compactCalendarAmount(1)).toBe('0.01');
    expect(compactCalendarAmount(0)).toBe('0');
  });

  it('大金额采用万/亿单位，正负金额输出同样绝对值供调用处保留方向', () => {
    expect(compactCalendarAmount(1_000_000)).toBe('1万');
    expect(compactCalendarAmount(-1_234_567)).toBe('1.2万');
    expect(compactCalendarAmount(10_000_000_000)).toBe('1亿');
    expect(compactCalendarAmount(999_990_000)).toBe('1000万');
    expect(compactCalendarAmount(9_999_999_999)).toBe('1亿');
    for (const fen of [1, 999_999, 999_900_000, 999_999_999, 9_999_999_999, 99_999_999_999, Number.MAX_SAFE_INTEGER]) {
      expect(compactCalendarAmount(fen).length).toBeLessThanOrEqual(5);
    }
  });
});
