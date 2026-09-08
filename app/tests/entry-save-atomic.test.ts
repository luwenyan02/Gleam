import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../src/core/db';
import { on } from '../src/core/store';
import { addAccount } from '../src/core/repo/accountRepo';
import { addEntry } from '../src/core/repo/entryRepo';
import { addLifeNote } from '../src/core/repo/lifeRepo';
import { ensureMerchant } from '../src/core/repo/merchantRepo';
import { persistEntry } from '../src/features/entry/entrySaveService';

let accountId: number, merchantId: number;
const stops: (()=>void)[] = [];
beforeEach(async()=>{
  await db.delete();await db.open();
  accountId=await addAccount({name:'原子保存演示现金',group:'cash',balance:10000});
  merchantId=await ensureMerchant('原子保存演示店');
});
afterEach(()=>{vi.restoreAllMocks();stops.splice(0).forEach(stop=>stop());});
function request(){return {
  entry:{type:'expense' as const,amount:1200,occurredAt:Date.now(),accountId,merchantId,note:'虚构保存'},
  tagIds:[99],
  lifeNote:{kind:'diary' as const,title:'随手记',body:'虚构关联日记',linkedAmount:1200,occurredAt:Date.now()},
};}

describe('复合记账保存原子性',()=>{
  it('商家更新失败回滚整笔；重试只生成一笔账单与一篇关联日记',async()=>{
    const events:string[]=[];
    for(const name of ['entries-changed','accounts-changed','life-changed'] as const)stops.push(on(name,()=>events.push(name)));
    vi.spyOn(db.merchants,'update').mockRejectedValueOnce(new Error('模拟商家写入失败'));
    await expect(persistEntry(request())).rejects.toThrow('模拟商家');
    expect(await db.entries.count()).toBe(0);
    expect(await db.entryTags.count()).toBe(0);
    expect(await db.lifeNotes.count()).toBe(0);
    expect((await db.accounts.get(accountId))?.balance).toBe(10000);
    expect(events).toEqual([]);
    await expect(persistEntry(request())).resolves.toBe('created');
    const saved=await db.entries.toArray();
    expect(saved).toHaveLength(1);
    expect(saved[0].lifeNoteId).toBe((await db.lifeNotes.toArray())[0]?.id);
    expect(await db.lifeNotes.count()).toBe(1);
    expect((await db.accounts.get(accountId))?.balance).toBe(8800);
    expect((await db.merchants.get(merchantId))?.useCount).toBe(1);
  });
  it('账单写入失败不留下生活记录，重试时保存关联',async()=>{
    vi.spyOn(db.entries,'add').mockRejectedValueOnce(new Error('模拟账单写入失败'));
    await expect(persistEntry(request())).rejects.toThrow('模拟账单');
    expect(await db.lifeNotes.count()).toBe(0);
    expect((await db.accounts.get(accountId))?.balance).toBe(10000);
    await persistEntry(request());
    expect(await db.lifeNotes.count()).toBe(1);
    expect((await db.entries.toArray())[0].lifeNoteId).toBeDefined();
  });
  it('编辑保存的附属操作失败时恢复旧金额、账户与关联',async()=>{
    const entryId=await addEntry({...request().entry,merchantId:undefined,amount:500});
    const before=await db.entries.get(entryId);
    vi.spyOn(db.merchants,'update').mockRejectedValueOnce(new Error('模拟商家更新失败'));
    await expect(persistEntry({...request(),editingId:entryId})).rejects.toThrow();
    expect(await db.entries.get(entryId)).toEqual(before);
    expect((await db.accounts.get(accountId))?.balance).toBe(9500);
    expect(await db.lifeNotes.count()).toBe(0);
  });
  it('嵌套写事务未提交/最终回滚时不发布成功事件',async()=>{
    const notifications:boolean[]=[];
    stops.push(on('entries-changed',()=>notifications.push(!!Dexie.currentTransaction)));
    stops.push(on('life-changed',()=>notifications.push(!!Dexie.currentTransaction)));
    await expect(db.transaction('rw',[db.entries,db.accounts,db.entryTags,db.lifeNotes],async()=>{
      await addEntry(request().entry);
      await addLifeNote(request().lifeNote);
      expect(notifications).toEqual([]);
      throw new Error('模拟外层回滚');
    })).rejects.toThrow();
    expect(notifications).toEqual([]);
    expect(await db.entries.count()).toBe(0);
    await db.transaction('rw',[db.entries,db.accounts,db.entryTags,db.lifeNotes],async()=>{
      await addEntry(request().entry);await addLifeNote(request().lifeNote);
    });
    expect(notifications).toEqual([false,false]);
  });
});
