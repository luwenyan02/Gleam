import { LOAN_KIND_META, type Entry } from '../../core/types';
import { entryDisplayAmount } from '../../core/entryAmount';
import { formatFen } from '../../core/money';
import { displayEntryNote } from '../detail/entryRowText';

export interface EntryMemoryContext {
  categoryName?: string;
  merchantName?: string;
  accountName?: string;
  fromAccountName?: string;
  toAccountName?: string;
}

const yuan = (amount: number) => formatFen(amount).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
const quote = (name: string) => `「${name}」`;

/** 只组织账单中已有的事实，不从备注推断地点、人物或消费感受。 */
export function entryMemoryText(entry: Entry, context: EntryMemoryContext): string {
  const date = new Date(entry.occurredAt);
  const timestamp = `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  const category = context.categoryName?.trim();
  const merchant = context.merchantName?.trim();
  const account = context.accountName?.trim();
  const categoryLabel = category ? quote(category) : '';
  const amount = yuan(Math.abs(entry.amount));
  const accountClause = (verb: string) => account ? `，${verb}${quote(account)}` : '';
  let sentence: string;
  if (entry.reconcileBeforeBalance != null && entry.reconcileTargetBalance != null) {
    sentence = `${account ? quote(account) : ''}余额由${yuan(entry.reconcileBeforeBalance)}元调整为${yuan(entry.reconcileTargetBalance)}元`;
  } else if (entry.type === 'transfer' || entry.type === 'loan') {
    let from = context.fromAccountName?.trim(), to = context.toAccountName?.trim();
    if (entry.amount < 0) [from, to] = [to, from];
    const path = from && to ? `从${quote(from)}转到${quote(to)}`
      : from ? `从${quote(from)}转出` : to ? `转入${quote(to)}` : '';
    if (entry.type === 'transfer') sentence = path ? `${path}${amount}元` : `转账${amount}元`;
    else sentence = `${entry.loanKind ? LOAN_KIND_META[entry.loanKind].name : '借贷'}${entry.amount < 0 ? '冲回' : ''}${amount}元${path ? `，${path}` : ''}`;
  } else if (entry.type === 'income') {
    sentence = entry.amount < 0
      ? `${categoryLabel}收入冲回${amount}元${accountClause('记在')}`
      : `收到${categoryLabel}收入${amount}元${merchant ? `，来自${quote(merchant)}` : ''}${accountClause('入账')}`;
  } else if (entry.refundFlag && entry.amount < 0) {
    sentence = `${categoryLabel}退款冲回${amount}元${accountClause('记在')}`;
  } else if (entryDisplayAmount(entry) > 0 || (entry.refundFlag && entry.amount === 0)) {
    sentence = `收到${categoryLabel}退款${amount}元${merchant ? `，来自${quote(merchant)}` : ''}${accountClause('退回')}`;
  } else {
    sentence = merchant ? `在${quote(merchant)}消费${amount}元${category ? `（${category}）` : ''}`
      : `${categoryLabel || '这笔消费'}花了${amount}元`;
    if (account) sentence += `，用${quote(account)}支付`;
  }
  const note = displayEntryNote(entry.note);
  return `${timestamp}，${sentence}。${note && note !== category && note !== '余额对账调整' ? `\n备注：${note}` : ''}`;
}
