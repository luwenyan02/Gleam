import type { IconId } from '../assets/icons';
import type { Category } from './types';

// 与默认分类一致；兼容导入账单的常见名称，仅替换通用占位图标。
const expense: Record<string, IconId> = {
  餐饮:'ic-bowl', 早餐:'ic-sun', 午餐:'ic-bowl', 晚餐:'ic-moon', 夜宵:'ic-moon',
  饮料水果:'ic-fruit', 咖啡:'ic-cup', 零食:'ic-cone', 买菜原料:'ic-cart',
  交通:'ic-bus', 地铁:'ic-metro', 公交:'ic-bus', 打车:'ic-car', 停车费:'ic-park', 飞机:'ic-plane',
  购物:'ic-cart', 超市:'ic-cart', 服饰鞋包:'ic-shirt', 家居百货:'ic-bottle', 电子数码:'ic-camera',
  居住:'ic-house', 住宿房租:'ic-house', 水电燃气:'ic-bolt',
  娱乐:'ic-film', 运动健身:'ic-pulse', 羽毛球:'ic-pulse', 电影演出:'ic-film', 网游电玩:'ic-film',
  保养维修:'ic-set', 医疗药品:'ic-med', 学习培训:'ic-cap', 人情礼物:'ic-gift', 其他:'ic-coin',
};
const income: Record<string, IconId> = {
  工资:'ic-brief', 工资薪水:'ic-brief', 奖金:'ic-coin', 兼职:'ic-pen',
  理财:'ic-coin', 利息:'ic-coin', 红包:'ic-gift', 退款:'ic-swap',
  报销:'ic-file', 报销款:'ic-file', 公积金:'ic-house', 其他:'ic-wallet',
};

/** 只影响显示或新分类默认值，不重写已有分类记录。 */
export function categoryIcon(category: Pick<Category, 'name' | 'kind'> & { icon?: string }): string {
  const fallback = category.kind === 'expense' ? 'ic-tag' : 'ic-coin';
  if (category.icon && category.icon !== fallback) return category.icon;
  const icons = category.kind === 'expense' ? expense : income;
  const name = category.name.trim();
  return Object.hasOwn(icons, name) ? icons[name] : (category.icon || fallback);
}
