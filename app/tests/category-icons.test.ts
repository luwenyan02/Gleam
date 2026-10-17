import { describe, expect, it } from 'vitest';
import { categoryIcon } from '../src/core/categoryIcons';
import { renderCategoryButton } from '../src/features/entry/entryCategoryPicker';
import type { Category } from '../src/core/types';

describe('导入分类的图标', () => {
  it.each([
    ['expense', '饮料水果', 'ic-fruit'], ['expense', '停车费', 'ic-park'],
    ['expense', '羽毛球', 'ic-racket'], ['expense', '飞机', 'ic-plane'],
    ['income', '工资薪水', 'ic-brief'], ['income', '红包', 'ic-envelope'],
    ['income', '报销款', 'ic-file'], ['income', '公积金', 'ic-house'],
  ] as const)('为 %s 的 %s 提供对应图标', (kind, name, expected) => {
    expect(categoryIcon({ kind, name, icon: kind === 'expense' ? 'ic-tag' : 'ic-coin' })).toBe(expected);
    expect(categoryIcon({ kind, name })).toBe(expected);
  });
  it.each([
    ['电子数码', 'ic-device'], ['电器', 'ic-appliance'], ['化妆护肤', 'ic-cosmetic'],
    ['宝宝用品', 'ic-baby'], ['报刊书籍', 'ic-book'], ['文具玩具', 'ic-toy'],
    ['保健用品', 'ic-pill'], ['购车款', 'ic-car'], ['摄影文印', 'ic-camera'],
    ['食品', 'ic-food'], ['家具家纺', 'ic-sofa'], ['珠宝首饰', 'ic-diamond'],
    ['烟酒', 'ic-wine'], ['房款房贷', 'ic-key'], ['美发美容', 'ic-scissors'],
    ['家政服务', 'ic-broom'], ['房子装修', 'ic-tools'], ['买水社区水站', 'ic-water'],
    ['挂号门诊', 'ic-stethoscope'], ['住院费', 'ic-hospital'], ['家教补习', 'ic-teacher'],
    ['股票', 'ic-stock'], ['保险', 'ic-shield'], ['利息支出', 'ic-percent'],
    ['礼金红包', 'ic-envelope'], ['慈善捐款', 'ic-heart'], ['迟到', 'ic-clock'],
    ['进货采购', 'ic-box'], ['材料辅料', 'ic-layers'], ['办公费用', 'ic-printer'],
    ['人工支出', 'ic-users'], ['网游电玩', 'ic-gamepad'], ['保养维修', 'ic-tools'],
  ])('按实际含义匹配 %s', (name, icon) => {
    expect(categoryIcon({kind:'expense',name,icon:'ic-tag'})).toBe(icon);
  });
  it('未知名称按所属大类兜底，不猜测个人名称的含义', () => {
    expect(categoryIcon({kind:'expense',name:'虚构项目甲',icon:'ic-tag'}, '投资')).toBe('ic-chart');
    expect(categoryIcon({kind:'expense',name:'虚构项目甲',icon:'ic-tag'}, '购物')).toBe('ic-bag');
    expect(categoryIcon({kind:'expense',name:'虚构车位',icon:'ic-tag'}, '投资')).toBe('ic-park');
    expect(categoryIcon({kind:'expense',name:'虚构广场',icon:'ic-tag'}, '投资')).toBe('ic-building');
    expect(categoryIcon({kind:'expense',name:'虚构新城',icon:'ic-tag'}, '投资')).toBe('ic-building');
    expect(categoryIcon({kind:'expense',name:'虚构国际',icon:'ic-tag'}, '投资')).toBe('ic-building');
    expect(categoryIcon({kind:'expense',name:'儿童日常消费',icon:'ic-tag'}, '医教')).toBe('ic-baby');
    expect(categoryIcon({kind:'expense',name:'儿童日常消费',icon:'ic-tag'}, '购物')).toBe('ic-bag');
    expect(categoryIcon({kind:'expense',name:'虚构项目甲',icon:'ic-cup'}, '投资')).toBe('ic-cup');
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
    const custom = {id:2,kind:'expense',name:'虚构项目',icon:'ic-tag'} as Category;
    expect(renderCategoryButton(custom, false, '投资')).toContain('#ic-chart');
    expect(custom.icon).toBe('ic-tag');
  });
});
