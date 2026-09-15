import { expect, it } from 'vitest';
import { widgetSummary } from '../src/core/widgetSummary';

it('桌面摘要只含月汇总、不包含账单或账户数据', () => {
  expect(widgetSummary({ expense: 12345, budget: 10000, from: 1, to: 2, locked: false, now: 10 })).toEqual({
    expense: '123.45', remaining: '-23.45', from: 1, to: 2, updatedAt: 10, private: false,
  });
});
it('未设置预算显示未设置，启用应用锁不缓存金额', () => {
  expect(widgetSummary({expense: 0, from: 1, to: 2, locked: false, now: 10}).remaining).toBe('未设置');
  expect(widgetSummary({expense: 123, budget: 500, from: 1, to: 2, locked: true, now: 10})).toEqual({
    expense: '••••', remaining: '••••', from: 1, to: 2, updatedAt: 10, private: true,
  });
});
