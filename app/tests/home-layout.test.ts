import { expect, it } from 'vitest';
import { normalizeHomeLayout } from '../src/core/repo/homeLayoutRepo';
it('旧数据默认保留四模块顺序与五个快捷入口', () => {
  expect(normalizeHomeLayout(undefined)).toEqual({ order: ['month', 'quick', 'today', 'past'], quick: ['note', 'detail', 'cal', 'cycle', 'ai'] });
});
it('去重和过滤损坏配置，补齐模块但允许空快捷项', () => {
  expect(normalizeHomeLayout({ order: ['past', 'past', 'bad'], quick: [] })).toEqual({ order: ['past', 'month', 'quick', 'today'], quick: [] });
  expect(normalizeHomeLayout({ quick: ['note', 'note', 'budget', 'cal', 'cycle', 'ai', 'reimburse', 'bad'] }).quick).toEqual(['note', 'budget', 'cal', 'cycle', 'ai']);
});
