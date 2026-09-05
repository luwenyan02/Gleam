/**
 * 拾光 · 首次启动种子数据（seed）
 * 依据 PRD 附录 A 写入默认分类（支出两级 / 收入单级）、默认账户（现金）与默认设置。
 * 以 'app.seeded' 设置为幂等标记，仅首次启动执行一次。
 * 图标映射与原型 index.html 保持一致。
 */
import { db, stamp } from './db';
import type { Account, Category } from './types';
import { SETTING_DEFAULTS } from './types';
import { setSetting, getSetting } from './repo/settingsRepo';

/** 支出大类 → 小类（附录 A），图标沿用原型映射 */
const EXPENSE_TREE: { name: string; icon: string; children: { name: string; icon: string }[] }[] = [
  {
    name: '餐饮', icon: 'ic-bowl',
    children: [
      { name: '早餐', icon: 'ic-sun' },
      { name: '午餐', icon: 'ic-bowl' },
      { name: '晚餐', icon: 'ic-moon' },
      { name: '饮料水果', icon: 'ic-fruit' },
      { name: '咖啡', icon: 'ic-cup' },
      { name: '零食', icon: 'ic-cone' },
    ],
  },
  {
    name: '交通', icon: 'ic-bus',
    children: [
      { name: '地铁', icon: 'ic-metro' },
      { name: '公交', icon: 'ic-bus' },
      { name: '打车', icon: 'ic-car' },
      { name: '停车费', icon: 'ic-park' },
    ],
  },
  {
    name: '购物', icon: 'ic-cart',
    children: [
      { name: '超市', icon: 'ic-cart' },
      { name: '服饰鞋包', icon: 'ic-shirt' },
      { name: '家居百货', icon: 'ic-bottle' },
    ],
  },
  {
    name: '居住', icon: 'ic-house',
    children: [
      { name: '住宿房租', icon: 'ic-house' },
      { name: '水电燃气', icon: 'ic-bolt' },
    ],
  },
  {
    name: '娱乐', icon: 'ic-film',
    children: [
      { name: '运动健身', icon: 'ic-pulse' },
      { name: '电影演出', icon: 'ic-film' },
    ],
  },
  {
    name: '其他', icon: 'ic-coin',
    children: [
      { name: '医疗药品', icon: 'ic-med' },
      { name: '学习培训', icon: 'ic-cap' },
      { name: '人情礼物', icon: 'ic-gift' },
    ],
  },
];

/** 收入分类（单级，附录 A），图标沿用原型映射 */
const INCOME_CATEGORIES: { name: string; icon: string }[] = [
  { name: '工资', icon: 'ic-brief' },
  { name: '奖金', icon: 'ic-coin' },
  { name: '兼职', icon: 'ic-pen' },
  { name: '理财', icon: 'ic-coin' },
  { name: '红包', icon: 'ic-gift' },
  { name: '退款', icon: 'ic-swap' },
  { name: '报销', icon: 'ic-file' },
  { name: '其他', icon: 'ic-wallet' },
];

/**
 * 首次启动写入种子数据（幂等：'app.seeded' 为 true 时直接返回）。
 * 在 main.ts 打开 DB 后、scheduler 补跑前调用。
 */
export async function seedIfNeeded(): Promise<void> {
  if (await getSetting('app.seeded')) return;
  await db.transaction('rw', [db.categories, db.accounts, db.settings], async () => {
    // 默认分类：支出两级
    let sort = 1;
    for (const group of EXPENSE_TREE) {
      const parentId = await db.categories.add(
        stamp({ name: group.name, icon: group.icon, kind: 'expense', sortOrder: sort++ }) as Category,
      );
      for (const child of group.children) {
        await db.categories.add(
          stamp({ name: child.name, icon: child.icon, kind: 'expense', parentId, sortOrder: sort++ }) as Category,
        );
      }
    }
    // 收入单级
    for (const cat of INCOME_CATEGORIES) {
      await db.categories.add(stamp({ name: cat.name, icon: cat.icon, kind: 'income', sortOrder: sort++ }) as Category);
    }
    // 默认账户：现金
    await db.accounts.add(
      stamp({ name: '现金', group: 'cash', balance: 0, hidden: false, countInNetWorth: true, sortOrder: 1 }) as Account,
    );
    // 默认设置全量落库（含 seeded 标记）
    for (const [key, value] of Object.entries(SETTING_DEFAULTS)) {
      await setSetting(key as keyof typeof SETTING_DEFAULTS, key === 'app.seeded' ? true : (value as never));
    }
  });
}
