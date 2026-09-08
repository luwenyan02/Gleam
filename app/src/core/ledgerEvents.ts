import type { Entry } from './types';
import { accountEffects } from './entryEffects';

/** 展示层事件，不写入 IndexedDB；id 始终指向原账单。 */
export interface LedgerItem extends Entry { kind: 'entry' | 'reimbursement' }

function reimbursement(entry: Entry): LedgerItem | undefined {
  if (entry.deletedAt !== 0 || entry.type !== 'expense' || entry.reimburseStatus !== 'done'
    || !entry.reimbursedAmount || entry.reimbursedAt == null || entry.reimburseAccountId == null) return;
  return { ...entry, kind:'reimbursement', type:'income', amount:entry.reimbursedAmount,
    occurredAt:entry.reimbursedAt, accountId:entry.reimburseAccountId,
    fromAccountId:undefined,toAccountId:undefined,refundFlag:undefined,refundOfEntryId:undefined,
    reimburseStatus:'none',reimbursedAmount:undefined,reimbursedAt:undefined,reimburseAccountId:undefined };
}

export function ledgerItems(entries: readonly Entry[], countAsIncome: boolean): LedgerItem[] {
  return entries.filter(e=>e.deletedAt===0).flatMap(e=>{
    const original: LedgerItem = {...e,kind:'entry'};
    const received = countAsIncome ? reimbursement(e) : undefined;
    return received ? [original,received] : [original];
  }).sort((a,b)=>b.occurredAt-a.occurredAt||b.id-a.id);
}

export interface AccountFlow { entry: LedgerItem; at: number; delta: number }
export interface AccountStatementRow extends AccountFlow { balanceAfter: number }

/** 从当前余额反推每笔后的余额；先处理全部流水再按月展示，保留期初余额。 */
export function accountStatement(flows: readonly AccountFlow[], currentBalance: number): AccountStatementRow[] {
  const ordered = [...flows].sort((a, b) => b.at - a.at || b.entry.id - a.entry.id
    // 同时点的原支出和报销共用 id，到账在时间线上晚于原支出。
    || Number(b.entry.kind === 'reimbursement') - Number(a.entry.kind === 'reimbursement'));
  let balance = currentBalance;
  return ordered.map(flow => {
    const row = { ...flow, balanceAfter: balance };
    balance -= flow.delta;
    return row;
  });
}

/** 现金流始终包含到账事件，与报表计收入口径无关。 */
export function accountFlows(entries: readonly Entry[], accountId: number): AccountFlow[] {
  return ledgerItems(entries,true).flatMap(entry=>{
    // 报销已展开为独立事件，原记录只计算本金，避免重复到账。
    const base = entry.kind === 'entry' ? { ...entry, reimbursedAmount: undefined } : entry;
    const delta = accountEffects(base).filter(effect => effect.accountId === accountId).reduce((sum, effect) => sum + effect.delta, 0);
    return delta ? [{entry,at:entry.occurredAt,delta}] : [];
  });
}

export function accountMonthRows(flows: readonly AccountFlow[], balance: number, now: number, months: number) {
  const current=new Date(now);
  return Array.from({length:months},(_,offset)=>{
    const from=new Date(current.getFullYear(),current.getMonth()-offset,1);
    const to=new Date(current.getFullYear(),current.getMonth()-offset+1,1).getTime();
    const events=flows.filter(e=>e.at>=from.getTime()&&e.at<to);
    return { key:`${from.getFullYear()}-${String(from.getMonth()+1).padStart(2,'0')}`,
      income:events.reduce((s,e)=>s+Math.max(0,e.delta),0),
      expense:events.reduce((s,e)=>s+Math.max(0,-e.delta),0),
      closing:balance-flows.filter(e=>e.at>=to).reduce((s,e)=>s+e.delta,0),
      entries:events.map(e=>e.entry) };
  });
}
