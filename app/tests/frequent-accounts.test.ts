import { expect, it } from 'vitest';
import type { Account, Entry } from '../src/core/types';
import { rankFrequentAccounts, entryDateLabel } from '../src/features/entry/entryWorkspace';
const now = new Date(2026, 9, 18, 12, 30).getTime();
const accounts = Array.from({ length: 15 }, (_, i) => ({ id: i + 1, group: 'cash', hidden: false } as Account));
const row = (accountId: number, changes: Partial<Entry> = {}) => ({ accountId, type: 'expense', amount: 100, occurredAt: now - 1000, deletedAt: 0, ...changes } as Entry);
it('ranks only eligible same-type last-year usage, with recent ties and no cold-start padding', () => {
 const rows = [row(1),row(2),row(2),row(3,{type:'income'}),row(4,{deletedAt:1}),row(5,{occurredAt:new Date(2025,9,17).getTime()}),row(6,{occurredAt:now+1}),row(7,{refundFlag:true}),row(8,{amount:0})];
 expect(rankFrequentAccounts(accounts, rows, 'expense', now).map(a=>a.id)).toEqual([2,1]);
 expect(rankFrequentAccounts(accounts, [], 'expense', now)).toEqual([]);
});
it('caps at 12, excludes hidden accounts, and counts both sides of transfers only once', () => {
 const rows=accounts.map(a=>row(a.id));
 expect(rankFrequentAccounts(accounts, rows, 'expense', now)).toHaveLength(12);
 expect(rankFrequentAccounts([{...accounts[0],hidden:true},accounts[1]],rows,'expense',now).map(a=>a.id)).toEqual([2]);
 expect(rankFrequentAccounts(accounts,[row(1,{type:'transfer',accountId:undefined,fromAccountId:2,toAccountId:3})],'transfer',now).map(a=>a.id)).toEqual([2,3]);
});
it('formats today compactly and other dates with a full year', () => {
 expect(entryDateLabel(now, now)).toBe('今天 12:30');
 expect(entryDateLabel(new Date(2025,0,2,8,5).getTime(),now)).toBe('2025/01/02 08:05');
});
