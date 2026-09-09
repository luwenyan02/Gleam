import { describe, expect, it } from 'vitest';
import {
  findBatchDuplicateRowNumbers,
  shouldImportDuplicateCandidate,
  type DuplicateCandidate,
} from '../src/features/import/import';
import type { WacaiRow } from '../src/features/import/wacai';

function row(rowNo: number, fields: Partial<WacaiRow> = {}): WacaiRow {
  return {
    rowNo,
    type: 'expense',
    occurredAt: new Date(2026, 8, 9, 9).getTime(),
    amountFen: 1200,
    categoryKey: '餐饮/午餐',
    accountName: '虚构现金',
    tags: [],
    reimburseDone: false,
    note: '',
    ...fields,
  };
}

describe('导入疑似重复预检', () => {
  it('同额同秒同账户仅标记后出现的行为疑似重复', () => {
    expect(findBatchDuplicateRowNumbers([
      row(2, { note: '虚构午餐一' }),
      row(3, { note: '虚构午餐二' }),
    ])).toEqual([3]);
  });

  it('账户或账务方向不同不列为疑似重复', () => {
    expect(findBatchDuplicateRowNumbers([
      row(2),
      row(3, { accountName: '虚构银行卡' }),
      row(4, { type: 'transfer', categoryKey: undefined, accountName: undefined, fromAccountName: '虚构现金', toAccountName: '虚构银行卡' }),
      row(5, { type: 'transfer', categoryKey: undefined, accountName: undefined, fromAccountName: '虚构银行卡', toAccountName: '虚构现金' }),
    ])).toEqual([]);
  });

  it('疑似重复默认跳过，用户确认后进入实际导入集合', () => {
    const candidates: DuplicateCandidate[] = [{ rowNo: 3, reason: '同批存在相同时间、金额和账户' }];
    expect(shouldImportDuplicateCandidate(3, candidates, new Set())).toBe(false);
    expect(shouldImportDuplicateCandidate(3, candidates, new Set([3]))).toBe(true);
    expect(shouldImportDuplicateCandidate(2, candidates, new Set())).toBe(true);
  });
});
