import { describe, expect, it } from 'vitest';
import type { Entry } from '../src/core/types';
import { entryRowText } from '../src/features/detail/entryRowText';
import { canRefund } from '../src/features/detail/entrySwipe';

const categories = new Map([[1,{name:'公交',icon:'ic-bus'}]]);
const accounts = new Map([[1,'演示现金'],[2,'演示小林']]);
const entry: Entry = {id:1,type:'expense',amount:1200,accountId:1,categoryId:1,
  occurredAt:new Date(2026,8,7,15,50).getTime(),createdAt:1,updatedAt:1,deletedAt:0,reimburseStatus:'none'};

describe('首页/搜索/账户共用的明细文案', () => {
  it('分类只出现在标题，副行固定显示日期时间与账户', () => {
    expect(entryRowText(entry,categories,accounts)).toMatchObject({title:'公交',meta:'9月7日 15:50 · 演示现金',icon:'ic-bus',neutral:false});
  });
  it('退款通过标题表达，不再重复分类和退款标签', () => {
    expect(entryRowText({...entry,refundFlag:true},categories,accounts)).toMatchObject({title:'公交退款',meta:'9月7日 15:50 · 演示现金',neutral:true});
  });
  it('支出状态与备注保留，完全重复的备注只在展示时去重', () => {
    const input={...entry,note:'公交',reimburseStatus:'pending' as const};
    expect(entryRowText(input,categories,accounts)).toMatchObject({note:'',meta:'9月7日 15:50 · 演示现金 · 待报销'});
    expect(input.note).toBe('公交');
    expect(entryRowText({...entry,note:'虚构行程',reimburseStatus:'done'},categories,accounts)).toMatchObject({note:'虚构行程',meta:'9月7日 15:50 · 演示现金 · 已报销（到账资料缺失）'});
  });
  it('转账和借贷标题只保留种类，方向在副行', () => {
    const pair={...entry,fromAccountId:1,toAccountId:2};
    expect(entryRowText({...pair,type:'transfer'},categories,accounts)).toMatchObject({title:'转账',meta:'9月7日 15:50 · 演示现金 → 演示小林'});
    expect(entryRowText({...pair,type:'loan',loanKind:'lend'},categories,accounts)).toMatchObject({title:'借出',meta:'9月7日 15:50 · 演示现金 → 演示小林'});
  });
  it('报销到账使用到账事件的账户与日期，余额调整标题不被备注重复', () => {
    expect(entryRowText({...entry,kind:'reimbursement',type:'income',accountId:2},categories,accounts)).toMatchObject({title:'报销到账',meta:'9月7日 15:50 · 演示小林'});
    expect(entryRowText({...entry,type:'transfer',toAccountId:1,note:'余额对账调整'},categories,accounts)).toMatchObject({title:'余额对账调整',note:''});
    const adjustment={...entry,type:'expense' as const,accountId:1,note:'余额对账调整',reconcileBeforeBalance:1200,reconcileTargetBalance:800};
    expect(entryRowText(adjustment,categories,accounts)).toMatchObject({title:'余额对账调整',icon:'ic-swap',note:''});
    expect(canRefund(adjustment)).toBe(false);
  });

  it('历史已报销记录缺少到账资料时明确提示资料缺失', () => {
    expect(entryRowText({...entry,reimburseStatus:'done'},categories,accounts)).toMatchObject({
      meta:'9月7日 15:50 · 演示现金 · 已报销（到账资料缺失）',
    });
  });
});
