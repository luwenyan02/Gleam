import { describe, expect, it } from 'vitest';
import type { Account, Entry, LoanKind } from '../src/core/types';
import { loanDirection, loanAccountId, loanFundAccountId, validateLoanAccounts } from '../src/core/loanLedger';
import { accountEffects } from '../src/core/entryEffects';
import { accountFlows } from '../src/core/ledgerEvents';
import { summarizeLedgerEntries } from '../src/core/ledgerQuery';

const fund: Account = { id:1, name:'演示现金', group:'cash', balance:100000, hidden:false, countInNetWorth:true, sortOrder:1, createdAt:1, updatedAt:1 };
const loan: Account = { ...fund, id:2, name:'演示小林', group:'receivable', balance:0 };
function row(kind: LoanKind): Entry {
  return {id:1,type:'loan',loanKind:kind,amount:10000,occurredAt:1,deletedAt:0,reimburseStatus:'none',createdAt:1,updatedAt:1,...loanDirection(kind,1,2)};
}
describe('借贷使用双账户',()=>{
  it('其他账单残留借贷标签时，仍按自身类型计算收支方向',()=>{
    expect(accountEffects({...row('borrow'),type:'expense',accountId:1})).toEqual([{accountId:1,delta:-10000}]);
    expect(accountEffects({...row('lend'),type:'income',accountId:1})).toEqual([{accountId:1,delta:10000}]);
  });
  for (const kind of ['lend','repay','borrow','collect'] as const) {
    it(`${kind} 两边相反且不改变净资产或收支`,()=>{
      const entry=row(kind), outgoing=kind==='lend'||kind==='repay';
      expect(loanAccountId(entry)).toBe(2); expect(loanFundAccountId(entry)).toBe(1);
      expect(accountEffects(entry)).toEqual([
        {accountId:outgoing?1:2,delta:-10000},{accountId:outgoing?2:1,delta:10000},
      ]);
      expect(accountEffects(entry).reduce((sum,e)=>sum+e.delta,0)).toBe(0);
      expect(accountFlows([entry],2)[0].delta).toBe(outgoing?10000:-10000);
      expect(summarizeLedgerEntries([entry])).toMatchObject({income:0,expense:0,balance:0});
      expect(()=>validateLoanAccounts(entry,new Map([[1,fund],[2,loan]]))).not.toThrow();
    });
  }
  it('拒绝同账户、非应收应付对方、应收应付作资金账户及不存在的账户',()=>{
    expect(()=>validateLoanAccounts({...row('lend'),toAccountId:1},new Map([[1,fund]]))).toThrow();
    expect(()=>validateLoanAccounts(row('lend'),new Map([[1,fund],[2,{...loan,group:'cash'}]]))).toThrow('应收应付');
    expect(()=>validateLoanAccounts(row('lend'),new Map([[1,{...fund,group:'receivable'}],[2,loan]]))).toThrow('资金账户');
    expect(()=>validateLoanAccounts(row('lend'),new Map([[1,fund]]))).toThrow('不存在');
  });
});
