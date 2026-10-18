import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../src/core/db';
import type { Entry } from '../src/core/types';
import { on } from '../src/core/store';
import { mergeCategories, previewCategoryMerge } from '../src/core/repo/categoryMergeRepo';

beforeEach(async () => {
  await db.delete(); await db.open();
  await db.categories.bulkAdd([
    { id:1,name:'人情',kind:'expense',icon:'ic-tag',sortOrder:1,createdAt:1,updatedAt:1 },
    { id:2,name:'人情支出',kind:'expense',icon:'ic-tag',sortOrder:2,createdAt:1,updatedAt:1 },
    { id:3,name:'礼金红包',kind:'expense',parentId:1,icon:'ic-envelope',sortOrder:3,createdAt:1,updatedAt:1 },
    { id:4,name:'礼金红包',kind:'expense',parentId:2,icon:'ic-envelope',sortOrder:4,createdAt:1,updatedAt:1 },
    { id:5,name:'工资',kind:'income',icon:'ic-brief',sortOrder:5,createdAt:1,updatedAt:1 },
  ]);
  await db.accounts.add({id:1,name:'虚构钱包',group:'cash',balance:123456,hidden:false,sortOrder:1,createdAt:1,updatedAt:1});
});
function entry(id:number,patch:Partial<Entry>={}):Entry {
  return {id,type:'expense',categoryId:3,accountId:1,amount:1000,occurredAt:100,deletedAt:0,reimburseStatus:'none',createdAt:1,updatedAt:1,...patch};
}
async function snapshot() {
  return Promise.all([db.categories.toArray(),db.entries.toArray(),db.quickTemplates.toArray(),db.recurringRules.toArray(),db.categoryBudgets.toArray(),db.settings.toArray(),db.accounts.toArray()]);
}

describe('分类合并', () => {
  it('预览完整路径与有效/回收站记录数，不提前修改数据',async()=>{
    await db.entries.bulkAdd([entry(1),entry(2,{deletedAt:2}),entry(3,{categoryId:4})]);
    const before=await snapshot();const plan=await previewCategoryMerge(3,4);
    expect(plan.sourcePath).toBe('人情／礼金红包');expect(plan.targetPath).toBe('人情支出／礼金红包');
    expect(plan.entries).toBe(2);expect(plan.deletedEntries).toBe(1);expect(await snapshot()).toEqual(before);
  });
  it('迁移普通账单、退款、已报销与回收站引用，保持金额、账户和账务字段',async()=>{
    await db.entries.bulkAdd([entry(1,{reimburseStatus:'done',reimbursedAmount:300,reimbursedAt:110,reimburseAccountId:1}),entry(2,{refundFlag:true,refundOfEntryId:1,amount:200}),entry(3,{deletedAt:5})]);
    const rows=await db.entries.toArray();const accounts=await db.accounts.toArray();
    await mergeCategories(3,4);
    expect(await db.categories.get(3)).toBeUndefined();expect(await db.categories.get(4)).toBeDefined();
    expect(await db.entries.toArray()).toEqual(rows.map(row=>({...row,categoryId:4,updatedAt:expect.any(Number)})));
    expect(await db.accounts.toArray()).toEqual(accounts);
  });
  it('迁移模板、周期规则、最近分类、待确认周期账及完整路径 AI 草稿',async()=>{
    await db.quickTemplates.add({id:1,name:'虚构模板',amount:100,categoryId:3,sortOrder:1,createdAt:1,updatedAt:1});
    await db.recurringRules.add({id:1,name:'虚构规则',type:'expense',amount:100,categoryId:3,accountId:1,amountConfirm:true,freq:'monthly',days:[1],enabled:false,nextRunAt:100,createdAt:1,updatedAt:1});
    await db.settings.bulkPut([
      {key:'entry.lastUsed',value:{expenseCategoryId:3,incomeCategoryId:5,accountId:1},updatedAt:1},
      {key:'recurring.pendingConfirms',value:[{ruleId:1,categoryId:3,amount:100}],updatedAt:1},
      {key:'ai.pendingItems',value:[{tempId:'a',type:'expense',categoryName:'人情/礼金红包'},{tempId:'b',type:'income',categoryName:'人情/礼金红包'},{tempId:'c',type:'expense',categoryName:'礼金红包'}],updatedAt:1},
    ]);
    await mergeCategories(3,4);
    expect((await db.quickTemplates.get(1))?.categoryId).toBe(4);expect((await db.recurringRules.get(1))?.categoryId).toBe(4);
    expect((await db.settings.get('entry.lastUsed'))?.value).toMatchObject({expenseCategoryId:4,incomeCategoryId:5,accountId:1});
    expect((await db.settings.get('recurring.pendingConfirms'))?.value).toEqual([{ruleId:1,categoryId:4,amount:100}]);
    expect((await db.settings.get('ai.pendingItems'))?.value).toEqual([{tempId:'a',type:'expense',categoryName:'人情支出/礼金红包'},{tempId:'b',type:'income',categoryName:'人情/礼金红包'},{tempId:'c',type:'expense',categoryName:'礼金红包'}]);
  });
  it('AI 草稿中的唯一旧小类名迁移为完整目标路径，避免目标重名歧义',async()=>{
    await db.categories.update(3,{name:'虚构礼物支出'});
    await db.categories.add({id:6,name:'礼金红包',kind:'expense',parentId:1,icon:'ic-tag',sortOrder:6,createdAt:1,updatedAt:1});
    await db.settings.put({key:'ai.pendingItems',value:[{tempId:'x',type:'expense',categoryName:'虚构礼物支出'}],updatedAt:1});
    await mergeCategories(3,4);
    expect((await db.settings.get('ai.pendingItems'))?.value).toEqual([{tempId:'x',type:'expense',categoryName:'人情支出/礼金红包'}]);
  });
  it('合并大类迁移小类并累加同月分类预算，保留总预算',async()=>{
    await db.entries.bulkAdd([entry(1,{categoryId:1}),entry(2)]);
    await db.categoryBudgets.bulkAdd([{id:1,categoryId:1,month:'2026-10',limit:5000,createdAt:1,updatedAt:1},{id:2,categoryId:2,month:'2026-10',limit:7000,createdAt:1,updatedAt:1},{id:3,categoryId:1,month:'2026-09',limit:1000,createdAt:1,updatedAt:1}]);
    await db.budgets.add({id:1,month:'2026-10',totalLimit:50000,autoRenew:false,createdAt:1,updatedAt:1});
    const plan=await previewCategoryMerge(1,2);expect(plan.children).toBe(1);expect(plan.duplicateChildNames).toBe(1);
    await mergeCategories(1,2,plan.revision);
    expect((await db.categories.get(3))?.parentId).toBe(2);expect((await db.entries.get(1))?.categoryId).toBe(2);expect((await db.entries.get(2))?.categoryId).toBe(3);
    expect((await db.categoryBudgets.where('month').equals('2026-10').toArray()).map(r=>[r.categoryId,r.limit])).toEqual([[2,12000]]);
    expect((await db.categoryBudgets.where('month').equals('2026-09').first())?.categoryId).toBe(2);
    expect((await db.budgets.get(1))?.totalLimit).toBe(50000);
  });
  it.each([[3,3],[3,5],[3,2],[1,3],[3,999]])('拒绝非法目标 %i → %i 且不变更数据',async(from,to)=>{
    const before=await snapshot();await expect(mergeCategories(from,to)).rejects.toThrow();expect(await snapshot()).toEqual(before);
  });
  it('目标已删除或预览范围变化时要求重新确认',async()=>{
    const plan=await previewCategoryMerge(3,4);await db.entries.add(entry(1));const before=await snapshot();
    await expect(mergeCategories(3,4,plan.revision)).rejects.toThrow('重新');expect(await snapshot()).toEqual(before);
    await db.categories.delete(4);await expect(mergeCategories(3,4)).rejects.toThrow();
  });
  it('预算累加溢出时不执行任何迁移',async()=>{
    await db.entries.add(entry(1,{categoryId:1}));await db.categoryBudgets.bulkAdd([{id:1,categoryId:1,month:'2026-10',limit:Number.MAX_SAFE_INTEGER,createdAt:1,updatedAt:1},{id:2,categoryId:2,month:'2026-10',limit:1,createdAt:1,updatedAt:1}]);
    const before=await snapshot();await expect(mergeCategories(1,2)).rejects.toThrow();expect(await snapshot()).toEqual(before);
  });
  it('中途写入失败整体回滚，不广播成功事件',async()=>{
    await db.entries.add(entry(1));const before=await snapshot();const events:string[]=[];const off=on('categories-changed',()=>events.push('categories'));
    const spy=vi.spyOn(db.categories,'delete').mockRejectedValueOnce(new Error('虚构删除失败'));
    try{await expect(mergeCategories(3,4)).rejects.toThrow('虚构删除失败');expect(await snapshot()).toEqual(before);expect(events).toEqual([]);}finally{spy.mockRestore();off();}
  });
});
