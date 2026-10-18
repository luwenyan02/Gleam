import { describe, expect, it } from 'vitest';
import type { Entry } from '../src/core/types';
import { entryMemoryText } from '../src/features/life/entryMemoryText';

const entry = (patch: Partial<Entry> = {}): Entry => ({ id: 1, type: 'expense', amount: 15900, occurredAt: new Date(2026, 9, 17, 22, 8).getTime(), deletedAt: 0, reimburseStatus: 'none', createdAt: 1, updatedAt: 1, ...patch });
const prefix = '2026年10月17日 22:08，';

describe('账单记忆的初始描述', () => {
  it('组合真实商家、分类、金额、账户及可见备注，不推断备注中的地点', () => {
    expect(entryMemoryText(entry({ note: '朋友聚餐；收付款人：虚构昵称' }), {
      categoryName: '夜宵', merchantName: '虚构烤鱼店', accountName: '微信',
    })).toBe(`${prefix}在「虚构烤鱼店」消费159元（夜宵），用「微信」支付。\n备注：朋友聚餐`);
    expect(entryMemoryText(entry({ note: '虚构烤鱼店的双人套餐' }), { categoryName: '夜宵', accountName: '微信' }))
      .toBe(`${prefix}「夜宵」花了159元，用「微信」支付。\n备注：虚构烤鱼店的双人套餐`);
  });
  it('缺少分类、商家和账户时仍能自然描述，分金额精确且保留备注原文', () => {
    expect(entryMemoryText(entry({ amount: 123456, note: '<b>自选菜</b>\n一起吃饭' }), {}))
      .toBe(`${prefix}这笔消费花了1,234.56元。\n备注：<b>自选菜</b>\n一起吃饭`);
    expect(entryMemoryText(entry({ amount: 1230 }), { categoryName: '午餐' })).toContain('12.3元');
    expect(entryMemoryText(entry({ amount: 0 }), {})).toBe(`${prefix}这笔消费花了0元。`);
  });
  it('关联退款与导入负支出均写为退款，不写成负数消费', () => {
    for (const patch of [{ amount: 250, refundFlag: true }, { amount: -250 }]) {
      expect(entryMemoryText(entry(patch), { categoryName: '夜宵', accountName: '微信' }))
        .toBe(`${prefix}收到「夜宵」退款2.5元，退回「微信」。`);
    }
    expect(entryMemoryText(entry({ amount: -250, refundFlag: true }), { categoryName: '夜宵', accountName: '微信' }))
      .toBe(`${prefix}「夜宵」退款冲回2.5元，记在「微信」。`);
  });
  it('收入与冲回分别表达收款和扣回，不套用消费话术', () => {
    expect(entryMemoryText(entry({ type: 'income', amount: 500000 }), { categoryName: '工资', accountName: '工资卡', merchantName: '虚构公司' }))
      .toBe(`${prefix}收到「工资」收入5,000元，来自「虚构公司」，入账「工资卡」。`);
    expect(entryMemoryText(entry({ type: 'income', amount: -500 }), { categoryName: '奖励', accountName: '钱包' }))
      .toBe(`${prefix}「奖励」收入冲回5元，记在「钱包」。`);
  });
  it('转账保留双边账户，负额冲回按实际反方向描述', () => {
    const context = { fromAccountName: '银行卡', toAccountName: '零钱' };
    expect(entryMemoryText(entry({ type: 'transfer', amount: 10000 }), context))
      .toBe(`${prefix}从「银行卡」转到「零钱」100元。`);
    expect(entryMemoryText(entry({ type: 'transfer', amount: -10000 }), context))
      .toBe(`${prefix}从「零钱」转到「银行卡」100元。`);
  });
  it('借贷按原类型及双边账户描述，不算普通收入或消费', () => {
    expect(entryMemoryText(entry({ type: 'loan', loanKind: 'collect', amount: 5000 }), { fromAccountName: '虚构应收', toAccountName: '钱包' }))
      .toBe(`${prefix}收款50元，从「虚构应收」转到「钱包」。`);
    expect(entryMemoryText(entry({ type: 'loan', loanKind: 'repay', amount: 5000 }), {})).toBe(`${prefix}还款50元。`);
  });
  it('余额对账描述原余额和目标余额，不误写为消费', () => {
    expect(entryMemoryText(entry({ amount: 100, reconcileBeforeBalance: -500, reconcileTargetBalance: -600 }), { accountName: '现金' }))
      .toBe(`${prefix}「现金」余额由-5元调整为-6元。`);
  });
});
