import { describe, expect, it } from 'vitest';
import { buildAccountPlans, allowedAccountGroups } from '../src/features/import/accountMapping';
import type { WacaiRow } from '../src/features/import/wacai';
const row = (name: string): WacaiRow => ({ rowNo: 8, type: 'income', accountName: name,
  occurredAt: 1, amountFen: 100, tags: [], reimburseDone: false, note: '' });

describe('导入账户类型建议与选择', () => {
  it.each([
    ['虚构手上现金', 'cash'], ['虚构备用金', 'cash'], ['虚构零钱包', 'online'],
    ['农行虚构账户', 'debit'], ['虚构银行理财账户', 'debit'], ['虚构银行基金账户', 'investment'],
    ['支付宝虚构理财', 'online'], ['虚构白条', 'online'], ['虚构月付', 'online'],
    ['虚构信用卡', 'credit'], ['虚构储值卡', 'stored'], ['未知虚构账户', 'other'],
  ])('%s → %s', (name, group) => {
    expect(buildAccountPlans([row(name)], [])[0].group).toBe(group);
  });
  it('可人工选现金等全部类型；借贷双方仍遵守角色约束', () => {
    expect(allowedAccountGroups('general')).toContain('cash');
    expect(allowedAccountGroups('general')).toHaveLength(8);
    expect(allowedAccountGroups('loan')).toEqual(['receivable']);
    expect(allowedAccountGroups('fund')).not.toContain('receivable');
  });
  it('匹配已有账户不改变其分组、余额或隐藏状态', () => {
    const existing = { id: 1, name: '虚构现金', group: 'online' as const, balance: 550, hidden: true,
      countInNetWorth: true, sortOrder: 1, createdAt: 1, updatedAt: 1 };
    const before = structuredClone(existing);
    expect(buildAccountPlans([row(existing.name)], [existing])[0].choice).toBe(1);
    expect(existing).toEqual(before);
  });
});
