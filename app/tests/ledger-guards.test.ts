import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/core/db';
import { addAccount, deleteAccount } from '../src/core/repo/accountRepo';
import { addEntry, createRefund, restoreEntry, settleReimbursement, softDeleteEntry, updateEntry } from '../src/core/repo/entryRepo';

let cash:number,bank:number;
beforeEach(async()=>{
  await db.delete();await db.open();
  cash=await addAccount({name:'防御验证现金',group:'cash',balance:10000});
  bank=await addAccount({name:'防御验证银行卡',group:'debit',balance:0});
});
const expense=(amount=1000)=>({type:'expense' as const,amount,occurredAt:1,accountId:cash});

describe('账务仓库入口不变量',()=>{
  it('不存在账户的支出和半边转账均拒绝，不写入孤儿账单',async()=>{
    await expect(addEntry({...expense(),accountId:99999})).rejects.toThrow();
    await expect(addEntry({type:'transfer',amount:1000,occurredAt:1,fromAccountId:cash,toAccountId:99999})).rejects.toThrow();
    expect(await db.entries.count()).toBe(0);
    expect((await db.accounts.get(cash))?.balance).toBe(10000);
  });
  it('通用新增也必须验证退款原单和总可退额',async()=>{
    await expect(addEntry({...expense(),refundFlag:true,refundOfEntryId:99999})).rejects.toThrow();
    const original=await addEntry(expense());
    await createRefund({originalEntryId:original,amount:600,occurredAt:2});
    await expect(addEntry({...expense(500),refundFlag:true,refundOfEntryId:original})).rejects.toThrow();
    expect((await db.accounts.get(cash))?.balance).toBe(9600);
  });
  it('删除关联账户后，恢复旧账拒绝而不是恢复为悬空账单',async()=>{
    const id=await addEntry(expense());await softDeleteEntry(id);await db.accounts.delete(cash);
    await expect(restoreEntry(id)).rejects.toThrow();
    expect((await db.entries.get(id))?.deletedAt).not.toBe(0);
  });
  it.each([-500,0,1.5,NaN,Infinity,1001])('报销金额 %s 不能污染余额或状态',async amount=>{
    const id=await addEntry({...expense(),reimburseStatus:'pending'});
    await expect(settleReimbursement([id],bank,new Map([[id,amount]]))).rejects.toThrow();
    expect((await db.accounts.get(bank))?.balance).toBe(0);
    expect((await db.entries.get(id))?.reimburseStatus).toBe('pending');
  });
  it('报销目标账户不存在时拒绝；批内后续金额非法时整批回滚',async()=>{
    const one=await addEntry({...expense(),reimburseStatus:'pending'});
    const two=await addEntry({...expense(),reimburseStatus:'pending'});
    await expect(settleReimbursement([one],99999)).rejects.toThrow();
    await expect(settleReimbursement([one,two],bank,new Map([[one,500],[two,-1]]))).rejects.toThrow();
    expect((await db.accounts.get(bank))?.balance).toBe(0);
    expect((await db.entries.get(one))?.reimburseStatus).toBe('pending');
  });
  it('已报销支出不能编辑成小于到账额，也不能改成收入',async()=>{
    const id=await addEntry({...expense(),reimburseStatus:'pending'});
    await settleReimbursement([id],bank,new Map([[id,600]]));
    await expect(updateEntry(id,{amount:500})).rejects.toThrow();
    await expect(updateEntry(id,{type:'income'})).rejects.toThrow();
    expect((await db.entries.get(id))?.amount).toBe(1000);
    expect((await db.accounts.get(cash))?.balance).toBe(9000);
    expect((await db.accounts.get(bank))?.balance).toBe(600);
  });
  it('原消费减少后，不能恢复一笔超过当前可退额的旧退款',async()=>{
    const id=await addEntry(expense());
    const refund=await createRefund({originalEntryId:id,amount:800,occurredAt:2});
    await softDeleteEntry(refund);await updateEntry(id,{amount:500});
    await expect(restoreEntry(refund)).rejects.toThrow();
    expect((await db.accounts.get(cash))?.balance).toBe(9500);
    expect((await db.entries.get(refund))?.deletedAt).not.toBe(0);
  });
  it('退款不能同时报销，也不能给旧的异常退款再结算报销',async()=>{
    const original=await addEntry(expense());
    await expect(addEntry({...expense(500),refundFlag:true,refundOfEntryId:original,
      reimburseStatus:'done',reimbursedAmount:500,reimburseAccountId:cash,reimbursedAt:2})).rejects.toThrow();
    const refund=await createRefund({originalEntryId:original,amount:500,occurredAt:2});
    await db.entries.update(refund,{reimburseStatus:'pending'});
    await expect(settleReimbursement([refund],cash)).rejects.toThrow();
    expect((await db.accounts.get(cash))?.balance).toBe(9500);
  });
  it('对账备注仅允许真实单边调整，不能放行无账户或同账户转账',async()=>{
    const input={type:'transfer' as const,amount:100,occurredAt:1,note:'余额对账调整'};
    await expect(addEntry(input)).rejects.toThrow();
    await expect(addEntry({...input,fromAccountId:cash,toAccountId:cash})).rejects.toThrow();
    await addEntry({...input,toAccountId:cash});
    expect((await db.accounts.get(cash))?.balance).toBe(10100);
    // 用户在普通双边转账中恰好写同样的备注，也仍按正常转账校验。
    await addEntry({...input,fromAccountId:cash,toAccountId:bank});
    expect((await db.accounts.get(cash))?.balance).toBe(10000);
    expect((await db.accounts.get(bank))?.balance).toBe(100);
  });
  it('级联恢复也校验每条退款金额，异常旧数据使整笔恢复回滚',async()=>{
    const original=await addEntry(expense());
    const refund=await createRefund({originalEntryId:original,amount:500,occurredAt:2});
    await softDeleteEntry(original);
    await db.entries.update(refund,{amount:-400});
    await expect(restoreEntry(original)).rejects.toThrow();
    expect((await db.accounts.get(cash))?.balance).toBe(10000);
    expect((await db.entries.get(original))?.deletedAt).not.toBe(0);
  });
});
