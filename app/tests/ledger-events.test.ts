import { describe, expect, it } from 'vitest';
import type { Entry } from '../src/core/types';
import { ledgerItems, accountFlows, accountMonthRows } from '../src/core/ledgerEvents';
import { filterLedgerEntries, summarizeLedgerEntries } from '../src/core/ledgerQuery';

const row: Entry = { id: 1, type: 'expense', amount: 10000, occurredAt: new Date(2026, 7, 5).getTime(),
  accountId: 1, categoryId: 2, reimburseStatus: 'done', reimbursedAmount: 6000,
  reimburseAccountId: 2, reimbursedAt: new Date(2026, 8, 5).getTime(), deletedAt: 0, createdAt: 1, updatedAt: 1 };

describe('账单与到账事件', () => {
  it('计收入口径跨月下钻包含到账事件，可追溯原账单且不修改实体', () => {
    const items = ledgerItems([row], true);
    const income = filterLedgerEntries(items, {from: new Date(2026, 8, 1).getTime(), to:new Date(2026,9,1).getTime(), types:['income'],accountIds:[2]});
    expect(income).toHaveLength(1);
    expect(income[0]).toMatchObject({id:1,kind:'reimbursement',amount:6000,accountId:2});
    expect(summarizeLedgerEntries(income).income).toBe(6000);
    expect(row.type).toBe('expense');
  });
  it('冲抵口径只在原账单周期扣减，不产生收入或二次扣减', () => {
    const items = ledgerItems([row], false);
    expect(items).toHaveLength(1);
    expect(summarizeLedgerEntries(items, {reimburseMode:'offset'})).toMatchObject({expense:4000,income:0});
    expect(ledgerItems([{...row,deletedAt:1}], true)).toHaveLength(0);
  });
  it('现金流按到账账户及时间计算；期末可从当前余额正确倒推', () => {
    const sameAccount = {...row, reimburseAccountId:1, occurredAt:new Date(2026,8,3).getTime()};
    const flows = accountFlows([sameAccount],1);
    expect(flows.map(f=>f.delta).sort((a,b)=>a-b)).toEqual([-10000,6000]);
    const months = accountMonthRows(flows,-4000,new Date(2026,8,7).getTime(),8);
    expect(months[0]).toMatchObject({income:6000,expense:10000,closing:-4000});
    expect(months[1].closing).toBe(0);
    expect(accountFlows([row],2)).toMatchObject([{delta:6000,at:row.reimbursedAt}]);
  });
});
