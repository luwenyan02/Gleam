import type { Account, AccountGroup } from '../../core/types';
import type { WacaiRow } from './wacai';

export type AccountUsage = 'general' | 'fund' | 'loan';
export type AccountPlanRole = 'general' | 'fund' | 'loan';

export interface AccountPlan {
  key: string;
  name: string;
  role: AccountPlanRole;
  usages: AccountUsage[];
  matchedId?: number;
  choice: number | 'auto' | undefined;
  ambiguous: boolean;
  group: AccountGroup;
}

export function accountUsageKey(usage: AccountUsage, name: string): string {
  return `${usage}:${name}`;
}

function guessGroup(name: string): AccountGroup {
  if (/信用|贷记|花呗|白条/.test(name)) return 'credit';
  if (/证券|基金|股票|投资|理财/.test(name)) return 'investment';
  if (/应收|应付|欠款/.test(name)) return 'receivable';
  if (/储值|预付|购物卡|公交卡|饭卡|校园卡/.test(name)) return 'stored';
  if (/微信|支付宝|钱包|余额|零钱|网商|云闪付/.test(name)) return 'online';
  if (/银行|储蓄|借记|存折|卡/.test(name)) return 'debit';
  return 'other';
}

function planFor(
  name: string,
  role: AccountPlanRole,
  usages: AccountUsage[],
  accounts: Account[],
): AccountPlan {
  const candidates = accounts.filter((account) => account.name === name && (
    role === 'loan' ? account.group === 'receivable'
      : role === 'fund' ? account.group !== 'receivable'
        : true
  ));
  const matchedId = candidates.length === 1 ? candidates[0].id : undefined;
  const ambiguous = candidates.length > 1;
  const guessed = guessGroup(name);
  const group: AccountGroup = role === 'loan'
    ? 'receivable'
    : role === 'fund' && guessed === 'receivable' ? 'other' : guessed;
  return {
    key: `${role}:${name}`,
    name,
    role,
    usages,
    matchedId,
    choice: matchedId ?? (ambiguous ? undefined : 'auto'),
    ambiguous,
    group,
  };
}

/**
 * 将账户名按实际用途合并为映射计划：
 * - 普通收支/转账可使用任意分组；
 * - 借贷资金侧排除应收应付；借贷对方侧只能是应收应付；
 * - 同名普通用途与借贷一侧并存且本地无反角色重名时共用计划；
 *   若已有跨分组同名账户，保留 general 独立选择，不由借贷角色暗中决定。
 */
export function buildAccountPlans(rows: WacaiRow[], accounts: Account[]): AccountPlan[] {
  const usagesByName = new Map<string, Set<AccountUsage>>();
  const addUsage = (name: string | undefined, usage: AccountUsage): void => {
    if (!name) return;
    const usages = usagesByName.get(name);
    if (usages) usages.add(usage);
    else usagesByName.set(name, new Set([usage]));
  };

  for (const row of rows) {
    if (row.type === 'transfer') {
      addUsage(row.fromAccountName, 'general');
      addUsage(row.toAccountName, 'general');
    } else if (row.type === 'loan') {
      addUsage(row.accountName, 'fund');
      addUsage(row.loanAccountName, 'loan');
    } else {
      addUsage(row.accountName, 'general');
    }
  }

  const plans: AccountPlan[] = [];
  for (const [name, usageSet] of usagesByName) {
    const hasFund = usageSet.has('fund');
    const hasLoan = usageSet.has('loan');
    const hasGeneral = usageSet.has('general');
    if (hasFund && hasLoan) {
      plans.push(planFor(name, 'fund', ['fund'], accounts));
      plans.push(planFor(name, 'loan', ['loan'], accounts));
      if (hasGeneral) plans.push(planFor(name, 'general', ['general'], accounts));
      continue;
    }
    const role: AccountPlanRole = hasLoan ? 'loan' : hasFund ? 'fund' : 'general';
    const hasCrossRoleAccount = hasGeneral && role !== 'general' && accounts.some((account) => (
      account.name === name && (role === 'loan' ? account.group !== 'receivable' : account.group === 'receivable')
    ));
    if (hasCrossRoleAccount) {
      plans.push(planFor(name, role, [role], accounts));
      plans.push(planFor(name, 'general', ['general'], accounts));
      continue;
    }
    plans.push(planFor(name, role, [...usageSet], accounts));
  }
  return plans;
}
