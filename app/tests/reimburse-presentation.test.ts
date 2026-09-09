import { describe, expect, it } from 'vitest';
import type { Entry } from '../src/core/types';
import {
  reimbursementDetailText,
  reimbursementRecordPresentation,
} from '../src/features/reimburse/reimburse';

const base: Entry = {
  id: 1,
  type: 'expense',
  amount: 12_000,
  accountId: 1,
  categoryId: 1,
  occurredAt: new Date(2026, 8, 7, 15, 50).getTime(),
  createdAt: 1,
  updatedAt: 1,
  deletedAt: 0,
  reimburseStatus: 'done',
};

describe('报销展示口径', () => {
  it('已报销但没有到账金额、账户和时间时不虚构到账', () => {
    expect(reimbursementRecordPresentation(base, undefined)).toEqual({
      meta: '9月7日 · 历史标记为已报销 · 到账资料缺失',
      amountText: '资料缺失',
      amountClass: '',
    });
    expect(reimbursementDetailText(base)).toBe('已报销（到账资料缺失）');
  });

  it('不足额到账按一次结清展示实收和差额', () => {
    const entry = {
      ...base,
      reimbursedAmount: 7_000,
      reimbursedAt: new Date(2026, 8, 9, 9).getTime(),
      reimburseAccountId: 2,
    };
    expect(reimbursementRecordPresentation(entry, '虚构银行卡')).toEqual({
      meta: '9月7日 · 9月9日报销到账 → 虚构银行卡 · 一次结清，实收 ¥70.00，差额 ¥50.00',
      amountText: '+¥70.00',
      amountClass: 'in',
    });
    expect(reimbursementDetailText(entry)).toBe('已报销 · 实收 ¥70.00 · 差额 ¥50.00（一次结清）');
  });
});
