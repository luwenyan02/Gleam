import type { EntryType, LoanKind } from './types';

export interface EntryIdentityInput {
  type: EntryType;
  amount: number;
  occurredAt: number;
  accountId?: number;
  fromAccountId?: number;
  toAccountId?: number;
  loanKind?: LoanKind;
}

/**
 * 导入批次内的流水身份键，与各类型已入库查重的字段口径一致。
 * 只由导入/AI 批处理显式调用，不影响普通手动记账。
 */
export function entryIdentity(input: EntryIdentityInput): string {
  if (input.type === 'transfer') {
    return JSON.stringify([
      input.type, input.occurredAt, input.amount,
      input.fromAccountId ?? null, input.toAccountId ?? null,
    ]);
  }
  if (input.type === 'loan') {
    return JSON.stringify([
      input.type, input.occurredAt, input.amount, input.loanKind ?? null,
      input.fromAccountId ?? null, input.toAccountId ?? null,
    ]);
  }
  return JSON.stringify([
    input.type, input.occurredAt, input.amount, input.accountId ?? null,
  ]);
}
