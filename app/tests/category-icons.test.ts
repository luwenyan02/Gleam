import { describe, expect, it } from 'vitest';
import { categoryIcon } from '../src/core/categoryIcons';
import { renderCategoryButton } from '../src/features/entry/entryCategoryPicker';
import type { Category } from '../src/core/types';

describe('导入分类的图标', () => {
  it.each([
    ['expense', '饮料水果', 'ic-fruit'], ['expense', '停车费', 'ic-park'],
    ['expense', '羽毛球', 'ic-pulse'], ['expense', '飞机', 'ic-plane'],
    ['income', '工资薪水', 'ic-brief'], ['income', '红包', 'ic-gift'],
    ['income', '报销款', 'ic-file'], ['income', '公积金', 'ic-house'],
  ] as const)('为 %s 的 %s 提供对应图标', (kind, name, expected) => {
    expect(categoryIcon({ kind, name, icon: kind === 'expense' ? 'ic-tag' : 'ic-coin' })).toBe(expected);
    expect(categoryIcon({ kind, name })).toBe(expected);
  });
  it('保留专用图标、未知分类及不同类型的同名分类', () => {
    expect(categoryIcon({kind:'expense',name:'饮料水果',icon:'ic-cup'})).toBe('ic-cup');
    expect(categoryIcon({kind:'expense',name:'虚构自定义分类',icon:'ic-tag'})).toBe('ic-tag');
    expect(categoryIcon({kind:'income',name:'虚构自定义分类'})).toBe('ic-coin');
    expect(categoryIcon({kind:'income',name:'停车费',icon:'ic-coin'})).toBe('ic-coin');
  });
  it('旧分类直接显示对应图标，不修改原始数据', () => {
    const category = {id:1,kind:'expense',name:'饮料水果',icon:'ic-tag'} as Category;
    expect(renderCategoryButton(category, true)).toContain('#ic-fruit');
    expect(category.icon).toBe('ic-tag');
  });
});
