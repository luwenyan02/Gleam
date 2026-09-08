import { describe, expect, it } from 'vitest';
import { entryIdentity, type EntryIdentityInput } from '../src/core/entryIdentity';

const base: EntryIdentityInput = {
  type: 'expense', amount: 1200, occurredAt: 1788397200000, accountId: 1,
};

describe('导入批内流水身份键', () => {
  it('普通收支包含类型和账户', () => {
    expect(entryIdentity(base)).not.toBe(entryIdentity({ ...base, type: 'income' }));
    expect(entryIdentity(base)).not.toBe(entryIdentity({ ...base, accountId: 2 }));
  });

  it('转账包含转出和转入账户', () => {
    const transfer: EntryIdentityInput = {
      type: 'transfer', amount: 1200, occurredAt: base.occurredAt,
      fromAccountId: 1, toAccountId: 2,
    };
    expect(entryIdentity(transfer)).not.toBe(entryIdentity({ ...transfer, toAccountId: 3 }));
    expect(entryIdentity(transfer)).not.toBe(entryIdentity({ ...transfer, fromAccountId: 2, toAccountId: 1 }));
  });

  it('借贷包含双边账户和借贷种类', () => {
    const loan: EntryIdentityInput = {
      type: 'loan', loanKind: 'lend', amount: 1200, occurredAt: base.occurredAt,
      fromAccountId: 1, toAccountId: 2,
    };
    expect(entryIdentity(loan)).not.toBe(entryIdentity({ ...loan, loanKind: 'repay' }));
    expect(entryIdentity(loan)).not.toBe(entryIdentity({ ...loan, toAccountId: 3 }));
  });

  it('所有查重字段相同时生成同一键', () => {
    expect(entryIdentity(base)).toBe(entryIdentity({ ...base }));
  });
});
