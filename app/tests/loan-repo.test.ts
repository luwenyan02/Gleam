import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/core/db';
import { addAccount, deleteAccount, getNetWorth } from '../src/core/repo/accountRepo';
import { addEntry, updateEntry, softDeleteEntry, restoreEntry, importEntriesBatch, findLoanDuplicates } from '../src/core/repo/entryRepo';
import { loanDirection } from '../src/core/loanLedger';
import { ensureLoanAccount, listLoanAccounts } from '../src/core/repo/loanRepo';
import { netWorthTrend } from '../src/core/repo/statsRepo';
import { setSetting } from '../src/core/repo/settingsRepo';
import type { LoanKind } from '../src/core/types';

let fund: number, loan: number, other: number;
const input = (kind: LoanKind, amount=10000, target=loan) => ({type:'loan' as const,loanKind:kind,amount,occurredAt:123,...loanDirection(kind,fund,target)});
beforeEach(async()=>{
  await db.delete(); await db.open();
  fund=await addAccount({name:'演示现金',group:'cash',balance:100000});
  loan=await addAccount({name:'演示应收应付',group:'receivable',balance:0});
  other=await addAccount({name:'另一往来',group:'receivable',balance:0});
});
describe('借贷双账户事务',()=>{
  it('净资产走势只按当前纳入口径的账户倒推，不把被排除的一侧抵消掉',async()=>{
    await setSetting('netWorth.includeHidden',false);
    await db.accounts.update(loan,{hidden:true,countInNetWorth:false});
    await addEntry({...input('lend'),occurredAt:Date.now()-1000});
    expect((await getNetWorth()).net).toBe(90000);
    const trend=await netWorthTrend();
    expect(trend.at(-1)?.net).toBe(90000);
    expect(trend.at(-2)?.net).toBe(100000);
  });
  it('四类往来、编辑、删除和恢复均原子更新两边，净资产保持不变',async()=>{
    const id=await addEntry(input('lend'));
    expect((await db.accounts.get(fund))?.balance).toBe(90000);
    expect((await db.accounts.get(loan))?.balance).toBe(10000);
    expect((await getNetWorth()).net).toBe(100000);
    expect((await netWorthTrend()).every(point=>point.net===100000)).toBe(true);
    await updateEntry(id,{amount:6000,...loanDirection('lend',fund,other)});
    expect((await db.accounts.get(loan))?.balance).toBe(0);
    expect((await db.accounts.get(other))?.balance).toBe(6000);
    await softDeleteEntry(id); expect((await db.accounts.get(fund))?.balance).toBe(100000);
    await restoreEntry(id); expect((await db.accounts.get(fund))?.balance).toBe(94000);
    await addEntry(input('collect',6000,other));
    await addEntry(input('borrow')); expect((await db.accounts.get(loan))?.balance).toBe(-10000);
    expect(await getNetWorth()).toEqual({assets:110000,debts:10000,net:100000});
    await addEntry(input('repay')); expect((await db.accounts.get(loan))?.balance).toBe(0);
    expect((await db.accounts.get(fund))?.balance).toBe(100000);
    expect(await db.loanContacts.count()).toBe(0);
  });
  it('错误对方使整个导入事务回滚，不留下账单或半边余额',async()=>{
    await expect(importEntriesBatch([{input:input('lend')},{input:input('borrow',10000,999)}],{source:'wacai',fileName:'fiction.xlsx',counts:{loan:2}})).rejects.toThrow();
    expect(await db.entries.count()).toBe(0); expect(await db.importBatches.count()).toBe(0);
    expect((await db.accounts.get(fund))?.balance).toBe(100000);
    await expect(addEntry({...input('lend'),toAccountId:fund})).rejects.toThrow();
  });
  it('新建往来只复用应收应付分组，不占用同名资金账户或暗中选择隐藏账户',async()=>{
    const id=await ensureLoanAccount('演示现金');
    expect(id).not.toBe(fund); expect((await db.accounts.get(id))?.group).toBe('receivable');
    expect(await ensureLoanAccount('演示现金')).toBe(id);
    expect((await listLoanAccounts()).some(account=>account.id===id)).toBe(true);
    await db.accounts.update(id,{hidden:true});
    await expect(ensureLoanAccount('演示现金')).rejects.toThrow('已隐藏');
  });
  it('应收应付两端均参与查重和账户关联保护',async()=>{
    const id=await addEntry(input('lend'));
    expect(await findLoanDuplicates(123,10000,'lend',fund,loan)).toHaveLength(1);
    expect(await findLoanDuplicates(123,10000,'lend',fund,other)).toHaveLength(0);
    expect(await findLoanDuplicates(123,10000,'repay',fund,loan)).toHaveLength(0);
    await expect(deleteAccount(loan)).rejects.toThrow();
    await softDeleteEntry(id); await deleteAccount(loan);
    await expect(restoreEntry(id)).rejects.toThrow();
    expect((await db.accounts.get(fund))?.balance).toBe(100000);
    expect((await db.entries.get(id))?.deletedAt).not.toBe(0);
  });
});
