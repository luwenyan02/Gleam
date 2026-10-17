import type { IconId } from '../assets/icons';
import type { Category } from './types';

// 名称精确匹配优先，避免把个人名称中的单字误判成某种消费。
const expense: Record<string, IconId> = {
  餐饮: 'ic-food', 早餐: 'ic-sun', 午餐: 'ic-bowl', 晚餐: 'ic-moon', 夜宵: 'ic-moon',
  饮料水果: 'ic-fruit', 水果: 'ic-fruit', 饮料: 'ic-cup', 咖啡: 'ic-cup', 零食: 'ic-cone',
  油盐酱醋: 'ic-bottle', 超市买东西: 'ic-cart', 食品: 'ic-food', 买菜原料: 'ic-basket', 餐饮其他: 'ic-food',
  交通: 'ic-bus', 汽车支出: 'ic-car', 地铁: 'ic-metro', 公交: 'ic-bus', 打车: 'ic-car', 停车费: 'ic-park',
  自行车: 'ic-bike', 电动车: 'ic-bike', 电动车充电: 'ic-bolt', 船舶: 'ic-ship',
  过路过桥: 'ic-road', 罚款赔偿: 'ic-gavel', 车险: 'ic-shield', 租车: 'ic-car',
  长途汽车: 'ic-bus', 车款车贷: 'ic-car', 飞机: 'ic-plane', 火车: 'ic-metro', 购车款: 'ic-car', 加油: 'ic-fuel', 交通其他: 'ic-bus',
  购物: 'ic-bag', 超市: 'ic-cart', 购物其他: 'ic-bag', 服饰鞋包: 'ic-shirt', 家居百货: 'ic-basket',
  电子数码: 'ic-device', 电器: 'ic-appliance', 化妆护肤: 'ic-cosmetic', 宝宝用品: 'ic-baby',
  报刊书籍: 'ic-book', 文具玩具: 'ic-toy', 文具: 'ic-pen', 玩具: 'ic-toy', 保健用品: 'ic-pill',
  摄影文印: 'ic-camera', 家具家纺: 'ic-sofa', 珠宝首饰: 'ic-diamond', 烟酒: 'ic-wine',
  居住: 'ic-house', 居家: 'ic-house', 住宿房租: 'ic-house', 房款房贷: 'ic-key',
  美发美容: 'ic-scissors', 生活其他: 'ic-house', 居家其他: 'ic-house', 水电燃气: 'ic-bolt',
  电费: 'ic-bolt', 水费: 'ic-water', 燃气费: 'ic-bolt', 家政服务: 'ic-broom',
  婚庆摄影: 'ic-camera', 房子装修: 'ic-tools', 买水社区水站: 'ic-water', 物业费: 'ic-building',
  材料建材: 'ic-layers', 税费手续费: 'ic-file', 取暖费: 'ic-heat', 物业: 'ic-building',
  快递邮政: 'ic-truck', 漏记款: 'ic-pen', 电脑宽带: 'ic-wifi', 金融服务费: 'ic-bank',
  生活费: 'ic-wallet', 手机电话: 'ic-phone', 通讯: 'ic-phone', 话费: 'ic-phone', 手机话费: 'ic-phone', 网费: 'ic-wifi',
  娱乐: 'ic-film', 运动健身: 'ic-dumbbell', 羽毛球: 'ic-racket', 电影演出: 'ic-film',
  聚会玩乐: 'ic-users', 洗浴足浴: 'ic-bath', 旅游度假: 'ic-plane', 电影: 'ic-film',
  麻将棋牌: 'ic-dice', 茶酒咖啡: 'ic-cup', 花鸟宠物: 'ic-paw', 电视: 'ic-device',
  网游电玩: 'ic-gamepad', 旅游: 'ic-plane', 娱乐其他: 'ic-film', 保养维修: 'ic-tools',
  医教: 'ic-cap', 学杂教材: 'ic-book', 培训考试: 'ic-cap', 挂号门诊: 'ic-stethoscope',
  医疗药品: 'ic-med', 幼儿教育: 'ic-baby', 医教其他: 'ic-cap', 家教补习: 'ic-teacher',
  学费: 'ic-cap', 养生保健: 'ic-leaf', 住院费: 'ic-hospital', 图书: 'ic-book', 学习培训: 'ic-cap',
  投资: 'ic-chart', 利息支出: 'ic-percent', 股票: 'ic-stock', 保险: 'ic-shield',
  投资其他: 'ic-chart', 投资贷款: 'ic-bank', 彩票: 'ic-ticket',
  人情: 'ic-heart', 人情支出: 'ic-heart', 孝敬: 'ic-heart', 礼金红包: 'ic-envelope',
  人情礼物: 'ic-gift', 物品: 'ic-gift', 代付款: 'ic-card', 慈善捐款: 'ic-heart',
  迟到: 'ic-clock', 人情其他: 'ic-heart',
  工作: 'ic-brief', 公司垫付: 'ic-card', 支出: 'ic-wallet', 生意: 'ic-brief', 进货采购: 'ic-box', 材料辅料: 'ic-layers', 办公费用: 'ic-printer',
  生意其他: 'ic-brief', 人工支出: 'ic-users', 其他: 'ic-wallet',
};
const income: Record<string, IconId> = {
  工资: 'ic-brief', 工资薪水: 'ic-brief', 奖金: 'ic-award', 兼职: 'ic-pen',
  理财: 'ic-chart', 投资收益: 'ic-chart', 利息: 'ic-percent', 红包: 'ic-envelope',
  礼金红包: 'ic-envelope', 退款: 'ic-swap', 报销: 'ic-file', 报销款: 'ic-file',
  公积金: 'ic-house', 租金: 'ic-key', 房租: 'ic-key', 补贴: 'ic-collect',
  销售款: 'ic-shop', 退款返款: 'ic-swap', 赔付款: 'ic-shield', 礼金: 'ic-envelope',
  基金: 'ic-chart', 福利补贴: 'ic-collect', 股票: 'ic-stock', 兼职外快: 'ic-pen',
  余额宝: 'ic-coin', 应收款: 'ic-loan-in', 保险理赔: 'ic-shield', 生意收入: 'ic-shop', 经营收入: 'ic-shop', 其他: 'ic-wallet',
};

/** 只影响显示或新分类默认值，不重写已有分类记录或覆盖专用图标。 */
export function categoryIcon(
  category: Pick<Category, 'name' | 'kind'> & { icon?: string },
  parentName?: string,
): string {
  const fallback = category.kind === 'expense' ? 'ic-tag' : 'ic-coin';
  if (category.icon && category.icon !== fallback) return category.icon;
  const icons = category.kind === 'expense' ? expense : income;
  const name = category.name.trim();
  if (Object.hasOwn(icons, name)) return icons[name];
  // 有明确用途后缀的自定义名称可识别用途；其余只采用所属大类。
  if (category.kind === 'expense') {
    if (name.endsWith('车位')) return 'ic-park';
    if (name.endsWith('房贷')) return 'ic-key';
    const parent = parentName?.trim();
    if (parent === '投资' && /(?:广场|新城|花园|住宅|公寓|楼盘|房产|国际)$/.test(name)) return 'ic-building';
    if (parent === '医教' && name.endsWith('日常消费')) return 'ic-baby';
    if (parent && Object.hasOwn(expense, parent)) return expense[parent];
  }
  return category.icon || fallback;
}
