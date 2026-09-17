import { describe, expect, it } from 'vitest';
import { lifeWeekForTimestamp, previousLifeWeek, shiftLifeWeek } from '../src/core/lifeWeek';

describe('生活周刊自然周', () => {
  it('按本地周一到下周一划分，跨年时生成稳定 weekKey', () => {
    const week = lifeWeekForTimestamp(new Date(2027, 0, 1, 12).getTime());
    expect(week.key).toBe('2026-12-28');
    expect(new Date(week.from)).toEqual(new Date(2026, 11, 28));
    expect(new Date(week.to)).toEqual(new Date(2027, 0, 4));
    expect(week.label).toBe('12月28日–1月3日');
  });

  it('上一自然周与前后移动不受财务月起始日影响', () => {
    expect(previousLifeWeek(new Date(2026, 8, 16, 9).getTime()).key).toBe('2026-09-07');
    expect(shiftLifeWeek('2026-12-28', 1).key).toBe('2027-01-04');
    expect(shiftLifeWeek('2027-01-04', -1).key).toBe('2026-12-28');
  });

  it('拒绝日期溢出和非周一 weekKey', () => {
    expect(() => shiftLifeWeek('2026-02-30', 1)).toThrow('weekKey');
    expect(() => shiftLifeWeek('2026-09-15', 1)).toThrow('周一');
    expect(() => lifeWeekForTimestamp(Number.NaN)).toThrow('时间');
  });
});
