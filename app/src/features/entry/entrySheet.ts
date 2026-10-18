/**
 * 拾光 · 记一笔全高度工作台（PRD 4.1）
 * 通过 shell 的 openSheet 承载。四类型分段切换（收入/支出/转账/借贷），
 * 计算器键盘连续四则运算（从左到右、无优先级），速记模板、标签/商家/报销退款标记、
 * 历史日期补账、「同时写生活记录」联动，编辑模式预填全部字段。
 *
 * 对外契约：openEntrySheet(options)（日历补账 / 速记 / 明细编辑复用）。
 */
import { openEntryAccountPicker } from './entryAccountPicker';
import { entryKeyFeedback } from './entryKeyFeedback';
import { iconHtml } from '../../assets/icons';
import { categoryIcon } from '../../core/categoryIcons';
import { esc } from '../../core/esc';
import { parseYuanToFen, formatFen } from '../../core/money';
import {
  LOAN_KINDS, LOAN_KIND_META,
  type Account, type Category, type Entry, type EntryType, type LoanKind,
  type Merchant, type Tag,
} from '../../core/types';
import {
  getEntry, getEntryTagIds, dayKey, listEntries,
  type NewEntry,
} from '../../core/repo/entryRepo';
import { listExpenseTree, listCategories } from '../../core/repo/categoryRepo';
import { getAccount, listAccounts } from '../../core/repo/accountRepo';
import { listTemplates, rememberTemplate } from '../../core/repo/templateRepo';
import { listTags, ensureTag } from '../../core/repo/tagRepo';
import { listMerchants, ensureMerchant } from '../../core/repo/merchantRepo';
import { listLoanAccounts, getLoanAccount } from '../../core/repo/loanRepo';
import type { NewLifeNote } from '../../core/repo/lifeRepo';
import { getSetting, setSetting } from '../../core/repo/settingsRepo';
import { openSheet, closeSheet } from '../shell/sheet';
import { setFabAction } from '../shell/shell';
import { showToast } from '../shell/toast';
import { openDateTimeWheel } from '../../shared/dateTimeWheel';
import { openPickList, type PickListItem } from '../../shared/pickList';
import { manageOverlay } from '../../shared/overlay';
import {
  createRepeatDraft,
  entryDateLabel,
  rankFrequentCategories,
  recommendAccountId,
  resolveInitialEntryType,
  resolveRecommendedAccountId,
  resolveRecommendedCategoryId,
  toggleTagSelection,
} from './entryWorkspace';
import {
  OPERATOR_SYMBOL, applyCalculation, appendDigit, chooseOperator, deleteDigit,
  type CalculatorOperator, type CalculatorState,
} from './entryCalculator';
import { renderAdvancedFields } from './entryAdvancedFields';
import { orderLoanFlow, renderTypeForms } from './entryTypeForms';
import {
  renderCategoryButton, renderCategoryToggle, selectQuickCategories,
} from './entryCategoryPicker';
import { persistEntry } from './entrySaveService';
import { listEntryAttachments } from '../../core/repo/entryAttachmentRepo';
import { mountReceiptEditor, type ReceiptDraft } from './receiptEditor';
import { rankMerchantSuggestions } from '../../core/repo/entityInsightsRepo';
import { loanDirection, loanAccountId as relatedLoanAccountId, loanFundAccountId } from '../../core/loanLedger';
import { bindNoteCompletion, matchNoteCategoryId } from './entryNoteMatching';
import { openShortVoice } from './shortVoice';
import { mapCategoryNameToId } from '../../core/repo/aiRepo';
import './entry.css';

/**
 * 打开「记一笔」抽屉的选项。
 */
export interface EntrySheetOptions {
  receiptDrafts?: ReceiptDraft[];
  /**
   * 编辑模式：传入已有账单 id，抽屉预填该账单全部字段
   * （类型/金额/分类/账户/日期/备注/标签/商家/报销退款标记），保存走 entryRepo.updateEntry。
   */
  entryId?: number;
  /**
   * 预设记账日期（毫秒时间戳）。日历页对空缺日期「补一笔」时传入；
   * 缺省为今天（当前时刻）。补账账单按此日期归入当日流水，不进「今天」分组。
   */
  presetDate?: number;
  /** 从账户详情进入时预设资金账户。 */
  presetAccountId?: number;
  /**
   * 速记模板 id：打开后按模板一键预填分类与金额（templateRepo.QuickTemplate）。
   * 首页「速记」快捷入口使用；与 entryId 同时传入时忽略。
   */
  templateId?: number;
  /** 预设记账类型；编辑模式始终以原账单类型为准。 */
  presetType?: EntryType;
  /** 从已有账单创建新草稿，带入金额、备注、日期与业务选择，不修改原账单。 */
  repeatFromEntryId?: number;
  /** 草稿预填：类型/金额/分类/账户/日期/备注/商家名；保存成功后回调账单 id。 */
  draft?: {
    type?: EntryType;
    amount?: number;
    categoryId?: number;
    accountId?: number;
    occurredAt?: number;
    note?: string;
    merchantName?: string;
  };
  onSaved?: (entryId: number) => void;
}

/* ── 抽屉内部状态 ─────────────────── */

interface SheetCtx {
  templateId?: number;
  type: EntryType;
  /** 当前操作数（元，字符串） */
  amt: string;
  prev: number | null;
  /** 连续运算的精确左操作数，仅存在于当前抽屉内存。 */
  prevAmount: string | null;
  op: CalculatorOperator | null;
  /** 支出/收入选中分类 id */
  categoryId?: number;
  loanKind: LoanKind;
  /** 支出/收入/借贷资金账户 */
  accountId?: number;
  fromId?: number;
  toId?: number;
  loanAccountId?: number;
  /** 记账日期（毫秒时间戳） */
  date: number;
  bx: boolean;
  tk: boolean;
  tagIds: number[];
  merchantId?: number;
  /** 关联退款编辑模式：保留原支出 id，普通记账不设置 */
  refundOfEntryId?: number;
  /** 编辑模式的账单 id */
  editingId?: number;
  /** 编辑前的商家 id（避免重复计数） */
  origMerchantId?: number;
  /**
   * 编辑「已报销」支出时保留的原报销字段。存在即表示该账单 reimburseStatus='done'，
   * 保存时须原样写回，否则 updateEntry 回滚旧影响后不再重放报销到账 → 到账账户余额丢失。
   */
  reimbursedDone?: { reimbursedAmount?: number; reimburseAccountId?: number; reimbursedAt?: number };
  /** 数据快照 */
  expenseTree: { parent: Category; children: Category[] }[];
  incomeCats: Category[];
  accounts: Account[];
  tags: Tag[];
  merchants: Merchant[];
  loanAccounts: Account[];
  lastUsed: {
    expenseCategoryId: number | null;
    incomeCategoryId: number | null;
    accountId: number | null;
    type?: EntryType | null;
  };
  quickExpenseCats: Category[];
  quickIncomeCats: Category[];
  recommendationHistory: Entry[];
  recommendationNow: number;
  categorySelectionLocked: boolean;
  /** 已完成备注明确命中的分类；日期推荐不能覆盖它。 */
  noteCategoryId?: number;
  categorySelections: Partial<Record<'expense' | 'income', {
    categoryId?: number; locked: boolean; noteCategoryId?: number;
  }>>;
  disposeNoteCompletion?: () => void;
  disposeVoice?: () => void;
  accountSelectionLocked: boolean;
  showAllCategories: boolean;
  advancedOpen: boolean;
  receipts?: ReturnType<typeof mountReceiptEditor>;
}

let ctx: SheetCtx | null = null;
let sheetEl: HTMLElement | null = null;

/** 注册 FAB：首页「+」打开记一笔（main.ts 调用一次） */
export function initEntry(): void {
  setFabAction(() => void openEntrySheet());
}

/**
 * 打开「记一笔」底部抽屉。
 *
 * 供其他模块复用的公共入口：
 * - 首页 FAB / 快捷「速记」：openEntrySheet() 或 openEntrySheet({ templateId })
 * - 日历补账：openEntrySheet({ presetDate })
 * - 明细/详情编辑：openEntrySheet({ entryId })
 *
 * @param options 见 {@link EntrySheetOptions}
 */
export async function openEntrySheet(options: EntrySheetOptions = {}): Promise<void> {
  savedCallback = options.onSaved;
  const openedAt = Date.now();
  const [tree, incomeCats, accounts, templates, tags, merchants, loanAccounts, lastUsed, recentEntries] = await Promise.all([
    listExpenseTree(), listCategories('income'), listAccounts(false),
    listTemplates(), listTags(), listMerchants(), listLoanAccounts(false), getSetting('entry.lastUsed'),
    listEntries({ from: openedAt - 90 * 24 * 60 * 60 * 1000, to: openedAt + 1 }),
  ]);
  // 隐藏账户不进入默认列表，但显式入口与历史账单的已选账户必须可见还原。
  async function includeSelectedAccount(id: number | undefined): Promise<void> {
    if (id == null || accounts.some(account => account.id === id)) return;
    const account = await getAccount(id);
    if (!account) return;
    accounts.push(account);
    if (account.group === 'receivable') loanAccounts.push(account);
  }
  await includeSelectedAccount(options.presetAccountId);
  if (options.entryId == null) {
    await includeSelectedAccount(templates.find(template => template.id === options.templateId)?.accountId);
  }

  const expenseCats = tree.flatMap((group) => group.children.length ? group.children : [group.parent]);
  const accountIds = new Set(accounts.map((account) => account.id));
  const hasPresetAccount = options.presetAccountId != null && accountIds.has(options.presetAccountId);
  const presetAccountId = hasPresetAccount ? options.presetAccountId : undefined;
  const preferredAccountId = presetAccountId != null
    ? presetAccountId
    : lastUsed.accountId != null && accountIds.has(lastUsed.accountId)
      ? lastUsed.accountId
      : accounts[0]?.id;
  const presetLoan = accounts.find(account => account.id === presetAccountId)?.group === 'receivable';
  const initialType = presetLoan ? 'loan' : resolveInitialEntryType(options.presetType, lastUsed.type);
  const initialDate = options.presetDate ?? openedAt;
  const quickExpenseCats = rankFrequentCategories(expenseCats, recentEntries, {
    now: openedAt, targetAt: initialDate, entryType: 'expense',
  });
  const quickIncomeCats = rankFrequentCategories(incomeCats, recentEntries, {
    now: openedAt, targetAt: initialDate, entryType: 'income',
  });
  const initialCategoryId = initialType === 'income'
    ? quickIncomeCats[0]?.id
    : quickExpenseCats[0]?.id;
  const historyAccountId = initialType === 'expense' || initialType === 'income'
    ? recommendAccountId(accounts, recentEntries, {
      now: openedAt,
      entryType: initialType,
      categoryId: initialCategoryId,
      fallbackId: lastUsed.accountId,
    })
    : undefined;
  const initialAccountId = initialType === 'expense' || initialType === 'income'
    ? resolveRecommendedAccountId(preferredAccountId, historyAccountId, hasPresetAccount)
    : initialType === 'loan' && accounts.find(account => account.id === preferredAccountId)?.group === 'receivable'
      ? accounts.find(account => account.group !== 'receivable')?.id
      : preferredAccountId;
  const c: SheetCtx = {
    type: initialType,
    amt: '', prev: null, prevAmount: null, op: null,
    categoryId: initialCategoryId,
    loanKind: 'borrow',
    accountId: initialAccountId,
    fromId: preferredAccountId,
    toId: accounts.find((account) => account.id !== preferredAccountId)?.id ?? preferredAccountId,
    loanAccountId: presetLoan ? options.presetAccountId : loanAccounts[0]?.id,
    date: initialDate,
    bx: false, tk: false,
    tagIds: [],
    expenseTree: tree, incomeCats, accounts, tags, merchants, loanAccounts, lastUsed,
    quickExpenseCats,
    quickIncomeCats,
    recommendationHistory: recentEntries,
    recommendationNow: openedAt,
    categorySelectionLocked: false,
    categorySelections: {},
    accountSelectionLocked: hasPresetAccount,
    showAllCategories: false,
    advancedOpen: false,
  };

  const sourceId = options.entryId ?? options.repeatFromEntryId;
  let sourceEntry: Entry | undefined;
  let initialNote = '';
  if (sourceId != null) {
    sourceEntry = await getEntry(sourceId);
    if (!sourceEntry) { showToast('账单不存在或已删除'); return; }
    if (sourceEntry.sourceAdjustment) { showToast('挖财原始冲回/零额记录保留原值，可删除后重新导入'); return; }
    await Promise.all([...new Set([sourceEntry.accountId, sourceEntry.fromAccountId, sourceEntry.toAccountId])].map(includeSelectedAccount));
    const tagIds = await getEntryTagIds(sourceEntry.id);
    c.type = sourceEntry.type;
    if (sourceEntry.categoryId != null) {
      c.categoryId = sourceEntry.categoryId;
      c.categorySelectionLocked = true;
    }
    const sourceAccountId = sourceEntry.type === 'loan'
      ? loanFundAccountId(sourceEntry) ?? sourceEntry.accountId
      : sourceEntry.accountId;
    if (sourceAccountId != null) {
      c.accountId = sourceAccountId;
      c.accountSelectionLocked = true;
    }
    c.fromId = sourceEntry.fromAccountId ?? c.fromId;
    c.toId = sourceEntry.toAccountId ?? c.toId;
    c.loanKind = sourceEntry.loanKind ?? 'borrow';
    c.loanAccountId = sourceEntry.type === 'loan' ? relatedLoanAccountId(sourceEntry) : c.loanAccountId;
    c.date = sourceEntry.occurredAt;
    c.tagIds = [...new Set(tagIds)];
    c.merchantId = sourceEntry.merchantId;
    refreshEntryRecommendations(c);
  }

  if (options.entryId != null && sourceEntry) {
    const editEntry = sourceEntry;
    c.editingId = editEntry.id;
    c.amt = String(editEntry.amount / 100);
    c.bx = editEntry.reimburseStatus === 'pending';
    c.tk = !!editEntry.refundFlag;
    c.refundOfEntryId = editEntry.refundOfEntryId;
    if (editEntry.type === 'expense' && editEntry.reimburseStatus === 'done') {
      c.reimbursedDone = {
        reimbursedAmount: editEntry.reimbursedAmount,
        reimburseAccountId: editEntry.reimburseAccountId,
        reimbursedAt: editEntry.reimbursedAt,
      };
    }
    c.origMerchantId = editEntry.merchantId;
    c.advancedOpen = c.bx || c.tagIds.length > 0 || c.merchantId != null || editEntry.lifeNoteId != null;
    initialNote = editEntry.note ?? '';
  } else if (options.repeatFromEntryId != null && sourceEntry) {
    c.amt = String(sourceEntry.amount / 100);
    initialNote = sourceEntry.note ?? '';
  } else if (options.draft) {
    const draft = options.draft;
    if (draft.occurredAt != null) c.date = draft.occurredAt;
    if (draft.type === 'expense' || draft.type === 'income') c.type = draft.type;
    if (c.type === 'expense' || c.type === 'income') {
      if (draft.categoryId != null) { c.categoryId = draft.categoryId; c.categorySelectionLocked = true; }
      if (draft.accountId != null) { c.accountId = draft.accountId; c.accountSelectionLocked = true; }
      if (draft.amount != null) c.amt = String(draft.amount / 100);
      if (draft.merchantName) {
        const found = merchants.find((m) => m.name === draft.merchantName);
        if (found) c.merchantId = found.id;
      }
    }
    refreshEntryRecommendations(c);
    initialNote = draft.note ?? '';
  } else if (options.templateId != null) {
    const tpl = templates.find((t) => t.id === options.templateId);
    if (tpl) {
      c.templateId = tpl.id;
      c.type = 'expense';
      c.categoryId = tpl.categoryId;
      c.categorySelectionLocked = true;
      c.amt = String(tpl.amount / 100);
      if (tpl.accountId != null && !hasPresetAccount) {
        const account = accounts.find(candidate => candidate.id === tpl.accountId && candidate.group !== 'receivable');
        c.accountId = account?.id;
        c.accountSelectionLocked = true;
        if (!account) showToast('模板账户不可用，请重新选择账户');
      }
      refreshEntryRecommendations(c);
    }
  }

  applyNoteCategory(c, initialNote);
  const initialReceipts = c.editingId == null ? options.receiptDrafts ?? [] : await listEntryAttachments(c.editingId);
  if (initialReceipts.length) c.advancedOpen = true;
  ctx = c;
  openSheet({
    ariaLabel: c.editingId ? '编辑账单' : '记一笔',
    render(el) {
      sheetEl = el;
      renderSheet(el, initialNote);
      c.receipts = mountReceiptEditor(el.querySelector<HTMLElement>('#receipt-editor')!, initialReceipts);
    },
    onClose() {
      c.disposeVoice?.();
      c.disposeNoteCompletion?.();
      c.receipts?.dispose();
      sheetEl?.classList.remove('entry-workspace', 'note-editing', 'categories-expanded');
      ctx = null;
      sheetEl = null;
    },
  });
}

/* ── 渲染 ─────────────────────────── */

/** 系统分享优先补入当前草稿，不能覆盖用户正在填写的账单。 */
export async function attachSharedReceipts(receipts: ReceiptDraft[]): Promise<void> {
  if (ctx?.receipts) {
    ctx.receipts.add(receipts);
    ctx.advancedOpen = true;
    refreshMeta();
    return;
  }
  await openEntrySheet({ receiptDrafts: receipts });
}

function renderSheet(el: HTMLElement, note: string): void {
  const c = ctx!;
  el.classList.add('entry-workspace');
  el.classList.remove('note-editing');
  el.innerHTML = `
    <header class="sheet-head">
      <div class="seg" id="seg" role="tablist" aria-label="记账类型">
        ${(['expense', 'income', 'transfer', 'loan'] as EntryType[]).map((t) => {
          const names: Record<EntryType, string> = { income: '收入', expense: '支出', transfer: '转账', loan: '借贷' };
          return `<button data-type="${t}" role="tab" class="${t === c.type ? 'active' : ''}" aria-selected="${t === c.type}">${names[t]}</button>`;
        }).join('')}
      </div>
      <button class="icon-btn" id="btn-voice" aria-label="语音记账">${iconHtml('ic-mic')}</button>
      <button class="icon-btn" id="sheet-close" aria-label="关闭记一笔">${iconHtml('ic-close')}</button>
    </header>
    <div class="pick-card">
      <span class="pick-ic" id="pick-ic"></span>
      <span class="pick-name" id="pick-name"></span>
      <span class="amt num empty" id="amt">0.00</span>
    </div>
    <div class="sheet-scroll">
      <div class="entry-section-head" id="category-head">
        <span>常用分类</span><small></small>
      </div>
      <div id="cat-jump" class="category-jump" aria-label="分类大类定位" hidden></div>
      <div id="cat-grid" class="cat-grid" role="listbox" aria-label="选择分类"></div>
      ${renderTypeForms()}
      <div class="entry-note-field">
        <input class="note" id="note" type="text" placeholder="写点备注（可选）" aria-label="备注">
        <button type="button" id="note-clear" aria-label="清空备注"${note ? '' : ' hidden'}>${iconHtml('ic-close', 16)}</button>
      </div>
      <div class="meta-row primary-meta">
        <div class="entry-date-actions"><button class="chip" id="date-chip"><span id="date-txt"></span></button><button class="chip" type="button" id="date-today" aria-label="日期改为今天" hidden>今天</button></div>
        <button class="chip" id="acct-btn"><span id="acct-name"></span></button>
        <button class="chip" type="button" id="mark-bx" aria-pressed="false">报销</button>
        <button class="chip advanced-toggle" type="button" data-act="toggle-advanced" aria-expanded="false" aria-controls="advanced-fields">
          ${iconHtml('ic-set', 16)}<span id="advanced-label">更多</span>
        </button>
      </div>
      ${renderAdvancedFields()}
    </div>
    <div class="entry-keyboard" id="entry-keyboard">
    <div class="keypad-tools"><button type="button" id="amount-clear" data-k="clear" aria-label="清空金额和算式">清空</button></div>
    <div class="keypad" id="keypad" aria-label="计算器键盘">
      <button data-k="1">1</button><button data-k="2">2</button><button data-k="3">3</button><button data-k="+" class="op" aria-label="加">+</button><button data-k="del" class="op" aria-label="删除一位">${iconHtml('ic-del')}</button>
      <button data-k="4">4</button><button data-k="5">5</button><button data-k="6">6</button><button data-k="-" class="op" aria-label="减">−</button><button data-k="again" class="again">再记</button>
      <button data-k="7">7</button><button data-k="8">8</button><button data-k="9">9</button><button data-k="md" class="op" aria-label="乘除">×÷</button><button data-k="save" class="save">保存</button>
      <button data-k="0" class="zero">0</button><button data-k=".">.</button><button data-k="=" class="op" aria-label="等于">=</button>
    </div></div>`;

  (el.querySelector<HTMLInputElement>('#note')!).value = note;
  bindEvents(el);
  renderCats();
  refreshAmt();
  refreshMeta();
}

const q = <T extends HTMLElement = HTMLElement>(sel: string): T => sheetEl!.querySelector<T>(sel)!;

function categoryParentName(category: Category): string | undefined {
  return ctx?.expenseTree.find(group => group.parent.id === category.parentId)?.parent.name;
}

function findCategory(id: number | undefined): Category | undefined {
  if (id == null || !ctx) return undefined;
  for (const g of ctx.expenseTree) {
    if (g.parent.id === id) return g.parent;
    const hit = g.children.find((ch) => ch.id === id);
    if (hit) return hit;
  }
  return ctx.incomeCats.find((cat) => cat.id === id);
}

function accountName(id: number | undefined): string {
  return ctx?.accounts.find((a) => a.id === id)?.name ?? '选择账户';
}

/** 按当前草稿时间刷新分类顺序与系统默认值；锁定项来自显式来源或本次手选。 */
function refreshEntryRecommendations(c: SheetCtx): void {
  const expenseCats = c.expenseTree.flatMap((group) => group.children.length ? group.children : [group.parent]);
  c.quickExpenseCats = rankFrequentCategories(expenseCats, c.recommendationHistory, {
    now: c.recommendationNow,
    targetAt: c.date,
    entryType: 'expense',
  });
  c.quickIncomeCats = rankFrequentCategories(c.incomeCats, c.recommendationHistory, {
    now: c.recommendationNow,
    targetAt: c.date,
    entryType: 'income',
  });

  if (c.type !== 'expense' && c.type !== 'income') return;
  const ranked = c.type === 'expense' ? c.quickExpenseCats : c.quickIncomeCats;
  c.categoryId = resolveRecommendedCategoryId(c.categoryId, ranked,
    c.categorySelectionLocked || c.noteCategoryId != null);
  const recommendedAccountId = recommendAccountId(c.accounts, c.recommendationHistory, {
    now: c.recommendationNow,
    entryType: c.type,
    categoryId: c.categoryId,
    fallbackId: c.lastUsed.accountId,
  });
  c.accountId = resolveRecommendedAccountId(
    c.accountId,
    recommendedAccountId,
    c.accountSelectionLocked,
  );
}

/** 顶部选中卡（图标 + 名称）随类型/分类同步 */
function updatePick(): void {
  const c = ctx!;
  if (c.type === 'transfer') {
    q('#pick-ic').innerHTML = iconHtml('ic-swap');
    q('#pick-name').textContent = '转账';
    return;
  }
  if (c.type === 'loan') {
    const meta = LOAN_KIND_META[c.loanKind];
    q('#pick-ic').innerHTML = iconHtml(meta.icon);
    q('#pick-name').textContent = meta.name;
    return;
  }
  const cat = findCategory(c.categoryId);
  q('#pick-ic').innerHTML = iconHtml(cat ? categoryIcon(cat, categoryParentName(cat)) : 'ic-coin');
  q('#pick-name').textContent = cat?.name ?? '选择分类';
}

/** 按类型渲染分类宫格与各区块显隐（附录 B 验收规则） */
function renderCats(): void {
  const c = ctx!;
  const isTransfer = c.type === 'transfer';
  const isLoan = c.type === 'loan';
  const categoryHead = q('#category-head');
  categoryHead.hidden = isTransfer;
  categoryHead.querySelector('span')!.textContent = isLoan
    ? '借贷类型'
    : c.showAllCategories ? '全部分类' : '常用分类';
  categoryHead.querySelector('small')!.textContent = isLoan
    ? '选择这笔往来的资金方向'
    : c.showAllCategories ? '选择后自动回到常用分类' : '';
  categoryHead.querySelector('small')!.hidden = !isLoan && !c.showAllCategories;
  q('#cat-grid').hidden = isTransfer;
  q('#transfer-block').hidden = !isTransfer;
  q('#loan-block').hidden = !isLoan;
  q('#mark-bx').hidden = c.type !== 'expense' || c.refundOfEntryId != null;
  // 退款必须从原支出详情发起并建立关联，不允许再手工创建孤立退款标记。
  q('#mark-tk').hidden = true;
  q('#chip-tag').hidden = q('#chip-shop').hidden = isTransfer || isLoan;
  q('#acct-btn').hidden = isTransfer || isLoan;
  sheetEl?.classList.toggle('categories-expanded', c.showAllCategories && !isTransfer && !isLoan);

  const grid = q('#cat-grid');
  const jump = q('#cat-jump');
  jump.hidden = !c.showAllCategories || c.type !== 'expense';
  if (!jump.hidden) {
    jump.innerHTML = `<button class="chip" type="button" data-cat-collapse aria-label="返回常用分类" title="收起，返回常用分类">${iconHtml('ic-left', 18)}</button><div class="category-group-nav">${c.type === 'expense' ? c.expenseTree.map((group, index) => `<button class="chip${index === 0 ? ' active' : ''}" type="button" data-cat-jump="${group.parent.id}" aria-label="定位到分类大类：${esc(group.parent.name)}" aria-pressed="${index === 0}">${esc(group.parent.name)}</button>`).join('') : ''}</div>`;
  }
  if (isLoan) {
    if (c.accounts.find(account => account.id === c.accountId)?.group === 'receivable') c.accountId = c.accounts.find(account => account.group !== 'receivable')?.id;
    grid.innerHTML = LOAN_KINDS.map((k) => {
      const meta = LOAN_KIND_META[k];
      const sel = k === c.loanKind;
      return `<button class="cat${sel ? ' sel' : ''}" data-kind="${k}" type="button" role="option" aria-selected="${sel}">
        <span class="cat-ic">${iconHtml(meta.icon)}</span><span>${meta.name}</span></button>`;
    }).join('');
    q('#loan-acct-lbl').textContent = c.loanKind === 'borrow' || c.loanKind === 'collect' ? '转入账户' : '转出账户';
    orderLoanFlow(q('#loan-flow'), c.loanKind === 'lend' || c.loanKind === 'repay');
    q('#loan-acct b').textContent = accountName(c.accountId);
    q('#loan-who b').textContent = c.loanAccounts.find((p) => p.id === c.loanAccountId)?.name ?? '选择应收应付账户';
    void updateLoanHint();
  } else if (c.type === 'expense') {
    if (c.showAllCategories) {
      grid.innerHTML = c.expenseTree.map((group) => {
        const choices = group.children.length ? group.children : [group.parent];
        return `<div class="cat-sec" data-cat-section="${group.parent.id}" tabindex="-1">${esc(group.parent.name)}</div>` +
          choices.map((cat) => renderCategoryButton(cat, cat.id === c.categoryId, categoryParentName(cat))).join('');
      }).join('') + renderCategoryToggle(true);
    } else {
      grid.innerHTML = selectQuickCategories(c.quickExpenseCats, findCategory(c.categoryId))
        .map((cat) => renderCategoryButton(cat, cat.id === c.categoryId, categoryParentName(cat))).join('') + renderCategoryToggle(false);
    }
  } else if (c.type === 'income') {
    const choices = c.showAllCategories
      ? c.incomeCats
      : selectQuickCategories(c.quickIncomeCats, findCategory(c.categoryId));
    grid.innerHTML = choices.map((cat) => renderCategoryButton(cat, cat.id === c.categoryId, categoryParentName(cat))).join('') +
      renderCategoryToggle(c.showAllCategories);
  }
  if (isTransfer) {
    q('#t-from b').textContent = accountName(c.fromId);
    q('#t-to b').textContent = accountName(c.toId);
  }
  updatePick();
}

/** 借贷往来余额提示（正 = TA 欠你） */
async function updateLoanHint(): Promise<void> {
  const c = ctx;
  if (!c || !sheetEl) return;
  const hint = sheetEl.querySelector('#loan-hint');
  if (!hint) return;
  if (c.loanAccountId == null) { hint.textContent = '请选择应收应付账户'; return; }
  const contact = await getLoanAccount(c.loanAccountId);
  const bal = contact?.balance ?? 0;
  hint.textContent = bal > 0
    ? `应收余额：对方欠我 ¥${formatFen(bal)}`
    : bal < 0
      ? `应付余额：我欠对方 ¥${formatFen(-bal)}`
      : '应收应付账户已结清';
}

/** 日期/账户/标记/标签/商家 chip 文案同步 */
function refreshMeta(): void {
  const c = ctx!;
  q<HTMLButtonElement>('#note-clear').hidden = !q<HTMLInputElement>('#note').value;
  const historicalDate = dayKey(c.date) !== dayKey(Date.now());
  q<HTMLButtonElement>('#date-today').hidden = !historicalDate;
  q('.primary-meta').classList.toggle('has-history-date', historicalDate);
  const fullDate = dateLabel(c.date);
  q('#date-txt').textContent = historicalDate ? fullDate.replace(' ', '\n') : fullDate;
  q('#date-chip').setAttribute('aria-label', `记账日期 ${fullDate}`);
  q('#acct-name').textContent = accountName(c.accountId);
  const bxBtn = q<HTMLButtonElement>('#mark-bx');
  if (c.reimbursedDone) {
    // 已报销账单：锁定报销开关，仅展示状态，避免编辑时把 done 改回 none
    bxBtn.textContent = '已报销';
    bxBtn.disabled = true;
    bxBtn.classList.add('active');
    bxBtn.setAttribute('aria-pressed', 'true');
    bxBtn.title = '该账单已报销到账，报销状态不可修改';
  } else {
    bxBtn.classList.toggle('active', c.bx);
    bxBtn.setAttribute('aria-pressed', String(c.bx));
  }
  q('#mark-tk').classList.toggle('active', c.tk);
  q('#mark-tk').setAttribute('aria-pressed', String(c.tk));
  const selectedTags = c.tagIds
    .map((id) => c.tags.find((tag) => tag.id === id))
    .filter((tag): tag is Tag => tag != null);
  q('#tag-txt').textContent = selectedTags.length === 0
    ? '标签'
    : selectedTags.length === 1
      ? `#${selectedTags[0].name}`
      : `#${selectedTags[0].name} +${selectedTags.length - 1}`;
  q('#chip-tag').classList.toggle('active', selectedTags.length > 0);
  const shop = c.merchants.find((m) => m.id === c.merchantId);
  q('#shop-txt').textContent = shop ? shop.name : '商家';
  q('#chip-shop').classList.toggle('active', !!shop);
  const advanced = q<HTMLElement>('#advanced-fields');
  const advancedToggle = q<HTMLButtonElement>('[data-act="toggle-advanced"]');
  const activeAdvanced = Number(selectedTags.length > 0) + Number(!!shop) +
    Number(q('#life-toggle').getAttribute('aria-checked') === 'true');
  advanced.hidden = !c.advancedOpen;
  advancedToggle.setAttribute('aria-expanded', String(c.advancedOpen));
  q('#advanced-label').textContent = c.advancedOpen
    ? '收起'
    : activeAdvanced > 0 ? `更多 · ${activeAdvanced}` : '更多';
  const save = q('#keypad .save');
  save.textContent = c.editingId ? '更新' : '保存';
  q<HTMLElement>('#keypad .again').style.visibility = c.editingId ? 'hidden' : '';
}

const dateLabel = entryDateLabel;

/* ── 计算器（从左到右、无优先级，与原型一致） ── */

function refreshAmt(): void {
  const c = ctx!;
  const el = q('#amt');
  if (c.op != null) {
    el.textContent = (c.prevAmount ?? String(c.prev)) + OPERATOR_SYMBOL[c.op] + (c.amt || '');
    el.classList.remove('empty');
  } else {
    el.textContent = c.amt || '0.00';
    el.classList.toggle('empty', !c.amt);
  }
  el.classList.toggle('long', (el.textContent ?? '').length > 8);
  q<HTMLButtonElement>('#amount-clear').disabled = saving || (!c.amt && c.prev == null && c.op == null);
}

function calculatorState(): CalculatorState {
  const c = ctx!;
  return {
    amount: c.amt,
    previous: c.prev,
    previousAmount: c.prevAmount ?? undefined,
    operator: c.op,
  };
}

function syncCalculator(state: CalculatorState): void {
  const c = ctx!;
  c.amt = state.amount;
  c.prev = state.previous;
  c.prevAmount = state.previousAmount ?? null;
  c.op = state.operator;
}

function showCalculationError(err: unknown): void {
  showToast(err instanceof Error ? err.message : '计算失败');
}

function calcApply(): boolean {
  const state = calculatorState();
  try {
    applyCalculation(state);
  } catch (err) {
    showCalculationError(err);
    return false;
  }
  syncCalculator(state);
  return true;
}

function setOp(operator: CalculatorOperator): boolean {
  const state = calculatorState();
  try {
    chooseOperator(state, operator);
  } catch (err) {
    showCalculationError(err);
    return false;
  }
  syncCalculator(state);
  return true;
}

/** 追加一位数字：整数+小数合计最多 8 位、小数最多 2 位 */
function pushDigit(ch: string): void {
  const state = calculatorState();
  appendDigit(state, ch);
  syncCalculator(state);
}

function switchEntryType(type: EntryType): void {
  const c = ctx;
  if (!c || !sheetEl) return;
  if (type === c.type) return;
  if (c.refundOfEntryId != null && type !== 'expense') {
    showToast('退款记录必须保持为支出退款类型');
    return;
  }
  if (c.type === 'expense' || c.type === 'income') {
    c.categorySelections[c.type] = {
      categoryId: c.categoryId, locked: c.categorySelectionLocked, noteCategoryId: c.noteCategoryId,
    };
  }
  c.type = type;
  c.showAllCategories = false;
  const previous = type === 'expense' || type === 'income' ? c.categorySelections[type] : undefined;
  c.categoryId = previous?.categoryId;
  c.categorySelectionLocked = previous?.locked ?? false;
  c.noteCategoryId = previous?.noteCategoryId;
  for (const button of sheetEl.querySelectorAll<HTMLElement>('#seg button')) {
    const active = button.dataset.type === type;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  }
  refreshEntryRecommendations(c);
  renderCats();
  refreshMeta();
}

function startVoiceInput(): void {
  const c = ctx, el = sheetEl;
  if (!c || !el || saving) return;
  if (c.editingId || !['expense', 'income'].includes(c.type) || c.bx || c.tk || c.refundOfEntryId || c.reimbursedDone) {
    showToast('编辑、转账、借贷、退款和报销请用手动记账，保留原账务关联');
    return;
  }
  c.disposeVoice?.();
  c.disposeVoice = openShortVoice({ container: el, applyLabel: '填入当前草稿',
    applyNote: '填入后替换当前草稿的类型、金额、分类、账户、时间和备注；确认保存才入账。标签和凭证保持原选择。',
    onApply(bill) {
      if (ctx !== c || sheetEl !== el || saving) throw new Error('草稿已关闭');
      switchEntryType(bill.type);
      c.amt = formatFen(bill.amount).replace(/,/g, ''); c.prev = null; c.prevAmount = null; c.op = null;
      const expenseCats = c.expenseTree.flatMap(group => [group.parent, ...group.children]);
      c.categoryId = mapCategoryNameToId(bill.type, bill.categoryName ?? '', expenseCats, c.incomeCats);
      c.categorySelectionLocked = true; c.noteCategoryId = undefined;
      c.accountId = c.accounts.find(account => account.name === bill.accountName)?.id;
      c.accountSelectionLocked = true; c.date = bill.occurredAt;
      c.merchantId = c.merchants.find(merchant => merchant.name === bill.merchantName)?.id;
      q<HTMLInputElement>('#note').value = bill.note ?? '';
      renderCats(); refreshMeta(); refreshAmt();
      showToast('草稿已填入，请核对分类、账户与金额后保存');
    },
  });
}

/* ── 事件绑定 ─────────────────────── */

function bindEvents(el: HTMLElement): void {
  el.querySelector('#sheet-close')!.addEventListener('click', closeSheet);
  el.querySelector('#btn-voice')!.addEventListener('click', startVoiceInput);

  const noteInput = el.querySelector<HTMLInputElement>('#note')!;
  const noteClear = el.querySelector<HTMLButtonElement>('#note-clear')!;
  noteInput.addEventListener('input', () => { noteClear.hidden = !noteInput.value; });
  noteClear.addEventListener('pointerdown', event => event.preventDefault());
  noteClear.addEventListener('click', () => {
    if (saving) return;
    noteInput.value = '';
    noteInput.dispatchEvent(new Event('input', { bubbles: true }));
    if (ctx) ctx.noteCategoryId = undefined;
    noteInput.focus();
  });
  const boundContext = ctx!;
  let noteSessionType = boundContext.type;
  let categoryPointerDown = false;
  const categoryControls = '#cat-grid .cat, #seg [data-type]';
  // 先让手选点击落到原按钮；备注失焦不能重绘并吞掉尚未派发的 click。
  const pointerDown = (event: PointerEvent) => {
    categoryPointerDown = !!(event.target as Element).closest(categoryControls);
  };
  const pointerEnd = () => { categoryPointerDown = false; };
  el.addEventListener('pointerdown', pointerDown, true);
  el.addEventListener('pointerup', pointerEnd, true);
  el.addEventListener('pointercancel', pointerEnd, true);
  const disposeNoteCompletion = bindNoteCompletion(noteInput, note => {
    if (ctx !== boundContext || sheetEl !== el || boundContext.type !== noteSessionType || saving) return;
    if (applyNoteCategory(boundContext, note)) {
      renderCats();
      refreshMeta();
    }
  }, nextFocus => !categoryPointerDown
    && !(nextFocus instanceof Element && nextFocus.closest(categoryControls)));
  boundContext.disposeNoteCompletion = () => {
    disposeNoteCompletion();
    el.removeEventListener('pointerdown', pointerDown, true);
    el.removeEventListener('pointerup', pointerEnd, true);
    el.removeEventListener('pointercancel', pointerEnd, true);
  };
  noteInput.addEventListener('focus', () => {
    if (ctx !== boundContext || sheetEl !== el) return;
    categoryPointerDown = false;
    noteSessionType = boundContext.type;
    el.classList.add('note-editing');
  });
  noteInput.addEventListener('blur', () => {
    if (ctx === boundContext && sheetEl === el) el.classList.remove('note-editing');
  });
  noteInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    noteInput.blur();
  });

  // 类型分段切换
  el.querySelector('#seg')!.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-type]');
    if (!btn || !ctx) return;
    switchEntryType(btn.dataset.type as EntryType);
  });

  el.querySelector('#cat-jump')!.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    if (target.closest('[data-cat-collapse]') && ctx) {
      ctx.showAllCategories = false;
      renderCats();
      q('.sheet-scroll').scrollTop = 0;
      q<HTMLButtonElement>('[data-cat-more]')?.focus({ preventScroll: true });
      return;
    }
    const button = target.closest<HTMLElement>('[data-cat-jump]');
    if (!button) return;
    const section = el.querySelector<HTMLElement>(`[data-cat-section="${button.dataset.catJump}"]`);
    section?.scrollIntoView({ block: 'start', behavior: 'instant' });
    el.querySelectorAll<HTMLElement>('[data-cat-jump]').forEach(item => {
      item.classList.toggle('active', item === button);
      item.setAttribute('aria-pressed', String(item === button));
    });
  });

  // 分类宫格 / 借贷四宫格
  el.querySelector('#cat-grid')!.addEventListener('click', (e) => {
    const more = (e.target as HTMLElement).closest<HTMLElement>('[data-cat-more]');
    if (more && ctx) {
      ctx.showAllCategories = !ctx.showAllCategories;
      renderCats();
      q('.sheet-scroll').scrollTop = 0;
      return;
    }
    const btn = (e.target as HTMLElement).closest<HTMLElement>('.cat');
    if (!btn || !ctx) return;
    if (btn.dataset.kind) ctx.loanKind = btn.dataset.kind as LoanKind;
    else {
      ctx.categoryId = Number(btn.dataset.id);
      ctx.categorySelectionLocked = true;
      ctx.showAllCategories = false;
      refreshEntryRecommendations(ctx);
    }
    renderCats();
    refreshMeta();
    q('.sheet-scroll').scrollTop = 0;
  });

  // 账户 / 转出转入 / 借贷对象与账户：选择浮层
  el.querySelector('#acct-btn')!.addEventListener('click', () => void pickAccount('accountId', '选择账户'));
  el.querySelector('#loan-acct')!.addEventListener('click', () => void pickAccount('accountId', '选择资金账户'));
  el.querySelector('#t-from')!.addEventListener('click', () => void pickAccount('fromId', '选择转出账户'));
  el.querySelector('#t-to')!.addEventListener('click', () => void pickAccount('toId', '选择转入账户'));
  el.querySelector('#t-swap')!.addEventListener('click', () => {
    if (!ctx || saving) return;
    [ctx.fromId, ctx.toId] = [ctx.toId, ctx.fromId];
    renderCats();
  });
  el.querySelector('#loan-who')!.addEventListener('click', () => void pickLoanAccount());
  el.querySelector('#chip-tag')!.addEventListener('click', () => void pickTag());
  el.querySelector('#chip-shop')!.addEventListener('click', () => void pickMerchant());
  el.querySelector('[data-act="toggle-advanced"]')!.addEventListener('click', () => {
    if (!ctx) return;
    ctx.advancedOpen = !ctx.advancedOpen;
    refreshMeta();
  });

  // 报销 / 退款标记（已报销账单锁定，不允许改回）
  el.querySelector('#mark-bx')!.addEventListener('click', () => {
    if (ctx!.reimbursedDone) { showToast('该账单已报销到账，报销状态不可修改'); return; }
    ctx!.bx = !ctx!.bx;
    refreshMeta();
  });
  el.querySelector('#mark-tk')!.addEventListener('click', () => { ctx!.tk = !ctx!.tk; refreshMeta(); });

  // 生活记录 switch
  el.querySelector('#life-toggle')!.addEventListener('click', (e) => {
    const btn = e.currentTarget as HTMLElement;
    const on = btn.getAttribute('aria-checked') === 'true';
    btn.setAttribute('aria-checked', String(!on));
    btn.classList.toggle('on', !on);
    refreshMeta();
  });

  el.querySelector('#date-today')!.addEventListener('click', () => {
    if (!ctx || saving) return;
    ctx.date = Date.now();
    refreshEntryRecommendations(ctx);
    renderCats();
    refreshMeta();
  });

  // 记账日期（滚轮选择日期+时间，默认当前时刻，可选历史日期补账，不可记未来日期）
  el.querySelector('#date-chip')!.addEventListener('click', () => {
    if (!ctx) return;
    const d = new Date(ctx.date);
    const now = new Date();
    const panel = openDateTimeWheel({
      withTime: true,
      initial: {
        year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(),
        hour: d.getHours(), minute: d.getMinutes(),
      },
      maxDate: { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() },
      onConfirm(r) {
        if (!ctx) return;
        ctx.date = new Date(r.year, r.month - 1, r.day, r.hour ?? 0, r.minute ?? 0).getTime();
        refreshEntryRecommendations(ctx);
        renderCats();
        refreshMeta();
        if (dayKey(ctx.date) !== dayKey(Date.now())) {
          showToast(`记账时间已设为 ${dateLabel(ctx.date)}，保存后计入当日流水`);
        }
      },
    });
    document.body.appendChild(panel);
  });

  // 计算器键盘
  const keypad = el.querySelector<HTMLElement>('#entry-keyboard')!;
  keypad.addEventListener('pointerdown', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (btn && !btn.disabled && e.isPrimary && e.button === 0 && ctx) void entryKeyFeedback();
  });
  keypad.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!btn || btn.disabled || !ctx) return;
    // 键盘和辅助技术没有 pointerdown，只在激活时反馈一次。
    if (e.detail === 0) void entryKeyFeedback();
    const k = btn.dataset.k!;
    const c = ctx;
    if (k === 'clear') {
      if (saving) return;
      c.amt = ''; c.prev = null; c.prevAmount = null; c.op = null;
    } else if (k === 'del') {
      const state = calculatorState();
      deleteDigit(state);
      syncCalculator(state);
    } else if (k === 'save') { void save(false); return; }
    else if (k === 'again') { void save(true); return; }
    else if (k === '.') pushDigit('.');
    else if (k === '+' || k === '-') setOp(k);
    else if (k === 'md') {
      if (!c.amt && c.op === '*') c.op = '/';
      else if (!c.amt && c.op === '/') c.op = '*';
      else setOp('*');
    } else if (k === '=') calcApply();
    else pushDigit(k);
    refreshAmt();
  });
}

/* ── 选择浮层（适配共享 pickList） ── */

interface PickItem { id: number; label: string; icon?: string; note?: string }

/**
 * 抽屉内通用选择浮层（委托共享 openPickList 渲染）。
 * @returns 选中项 id；null = 选择「清除」；undefined = 取消
 */
function pickList(
  title: string,
  items: PickItem[],
  opts: { activeId?: number; clearLabel?: string; createPlaceholder?: string; onCreate?: (name: string) => Promise<number> } = {},
): Promise<number | null | undefined> {
  return new Promise((resolve) => {
    if (!sheetEl) { resolve(undefined); return; }

    const mapped: PickListItem[] = [];
    if (opts.clearLabel) {
      mapped.push({ value: '__clear__', label: opts.clearLabel, icon: 'ic-close' });
    }
    for (const it of items) {
      mapped.push({ value: it.id, label: it.label, icon: it.icon, note: it.note });
    }
    if (opts.onCreate) {
      mapped.push({ value: '__new__', label: opts.createPlaceholder ?? '新建…', icon: 'ic-plus' });
    }

    openPickList({
      container: sheetEl,
      title,
      items: mapped,
      selected: opts.activeId,
      onPick(value) {
        if (value === '__clear__') { resolve(null); return; }
        if (value === '__new__' && opts.onCreate) {
          void showCreateInput(opts.createPlaceholder ?? '新建…', opts.onCreate)
            .then((id) => resolve(id ?? undefined));
          return;
        }
        resolve(Number(value));
      },
      onCancel() { resolve(undefined); },
    });
  });
}

/** 新建输入对话框：从共享 pickList 拆出的创建功能（entrySheet 独享） */
function showCreateInput(
  placeholder: string,
  onCreate: (name: string) => Promise<number>,
): Promise<number | undefined> {
  return new Promise((resolve) => {
    if (!sheetEl) { resolve(undefined); return; }
    const mask = document.createElement('div');
    mask.className = 'picker-mask';
    const panel = document.createElement('div');
    panel.className = 'picker-panel';
    panel.style.padding = '14px 16px calc(14px + var(--safe-bottom))';
    panel.innerHTML = `
      <div class="picker-new">
        <input type="text" placeholder="${esc(placeholder)}" aria-label="${esc(placeholder)}">
        <button class="chip">新建</button>
      </div>`;
    mask.appendChild(panel);
    sheetEl.appendChild(mask);
    requestAnimationFrame(() => panel.classList.add('open'));
    const input = panel.querySelector<HTMLInputElement>('input')!;
    setTimeout(() => input.focus(), 220);
    const close = () => {
      panel.classList.remove('open');
      setTimeout(() => mask.remove(), 200);
    };
    mask.addEventListener('click', (e) => {
      if (e.target === mask) { close(); resolve(undefined); }
    });
    const doCreate = () => {
      const name = input.value.trim();
      if (!name) { showToast('请输入名称'); return; }
      void onCreate(name)
        .then((id) => { close(); resolve(id); })
        .catch((err) => showToast(String(err instanceof Error ? err.message : err)));
    };
    panel.querySelector('button')!.addEventListener('click', doCreate);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); doCreate(); }
    });
  });
}

async function pickAccount(field: 'accountId' | 'fromId' | 'toId', title: string): Promise<void> {
  const c = ctx;
  if (!c) return;
  const choices = c.type === 'loan' ? c.accounts.filter(account => account.group !== 'receivable') : c.accounts;
  const now = Date.now(), from = new Date(now);
  from.setFullYear(from.getFullYear() - 1);
  const history = await listEntries({ from: from.getTime(), to: now + 1 });
  if (ctx !== c) return;
  const id = await openEntryAccountPicker({
    container: sheetEl!, title, accounts: choices, entries: history,
    type: c.type, selected: c[field],
  });
  if (ctx !== c) return;
  c.accounts = (await listAccounts(true)).filter(a => !a.hidden || [c.accountId, c.fromId, c.toId, c.loanAccountId].includes(a.id));
  c.loanAccounts = c.accounts.filter(a => a.group === 'receivable');
  if (id == null) return;
  if (field === 'fromId' && id === c.toId) { showToast('转出与转入账户不能相同'); return; }
  if (field === 'toId' && id === c.fromId) { showToast('转出与转入账户不能相同'); return; }
  c[field] = id;
  if (field === 'accountId') c.accountSelectionLocked = true;
  renderCats();
  refreshMeta();
}

async function pickLoanAccount(): Promise<void> {
  const c = ctx;
  if (!c) return;
  const now = Date.now(), from = new Date(now);
  from.setFullYear(from.getFullYear() - 1);
  const history = await listEntries({ from: from.getTime(), to: now + 1 });
  if (ctx !== c) return;
  const id = await openEntryAccountPicker({
    container: sheetEl!, title: '选择应收应付账户', accounts: c.loanAccounts,
    entries: history, type: c.type, selected: c.loanAccountId, groups: ['receivable'],
  });
  if (ctx !== c) return;
  c.accounts = (await listAccounts(true)).filter(a => !a.hidden || [c.accountId, c.fromId, c.toId, c.loanAccountId].includes(a.id));
  c.loanAccounts = c.accounts.filter(a => a.group === 'receivable');
  if (id == null) return;
  c.loanAccountId = id;
  renderCats();
}

type TagPickerResult = { kind: 'apply'; tagIds: number[] } | { kind: 'create' };

function openTagMultiPicker(tags: readonly Tag[], currentTagIds: readonly number[]): Promise<TagPickerResult | undefined> {
  return new Promise((resolve) => {
    if (!sheetEl) { resolve(undefined); return; }
    const selected = new Set(currentTagIds);
    const mask = document.createElement('div');
    mask.className = 'picker-mask';
    mask.setAttribute('aria-label', '选择标签（可多选）');
    const panel = document.createElement('div');
    panel.className = 'picker-panel';
    panel.innerHTML = `
      <h4 class="picker-title">选择标签（可多选）</h4>
      <div class="picker-list" role="listbox" aria-label="标签" aria-multiselectable="true"></div>
      <div class="dialog-btns" style="padding:12px 16px calc(12px + var(--safe-bottom))">
        <button class="btn ghost" type="button" data-tag-act="clear">清空</button>
        <button class="btn ghost" type="button" data-tag-act="create">新建</button>
        <button class="btn primary" type="button" data-tag-act="apply">完成</button>
      </div>`;
    const list = panel.querySelector<HTMLElement>('.picker-list')!;
    const renderList = () => {
      list.innerHTML = tags.length
        ? tags.map((tag) => {
          const active = selected.has(tag.id);
          return `<button class="picker-item${active ? ' selected' : ''}" data-tag-id="${tag.id}" type="button" role="option" aria-selected="${active}">
            <span class="picker-item-icon">${iconHtml('ic-tag', 18)}</span>
            <span class="picker-item-label">#${esc(tag.name)}</span>
            ${active ? '<span class="picker-item-check">✓</span>' : ''}
          </button>`;
        }).join('')
        : '<p class="tiny" style="padding:18px;text-align:center">还没有标签，可先新建</p>';
    };
    renderList();
    mask.appendChild(panel);
    sheetEl.appendChild(mask);
    requestAnimationFrame(() => panel.classList.add('open'));

    let settled = false;
    let releaseOverlay: () => void = () => undefined;
    const finish = (result: TagPickerResult | undefined) => {
      if (settled) return;
      settled = true;
      releaseOverlay();
      panel.classList.remove('open');
      setTimeout(() => mask.remove(), 200);
      resolve(result);
    };
    releaseOverlay = manageOverlay(mask, () => finish(undefined));
    mask.addEventListener('click', (event) => {
      if (event.target === mask) { finish(undefined); return; }
      const tagButton = (event.target as HTMLElement).closest<HTMLElement>('[data-tag-id]');
      if (tagButton) {
        const next = toggleTagSelection([...selected], Number(tagButton.dataset.tagId));
        selected.clear();
        next.forEach((id) => selected.add(id));
        renderList();
        return;
      }
      const action = (event.target as HTMLElement).closest<HTMLElement>('[data-tag-act]')?.dataset.tagAct;
      if (action === 'clear') { selected.clear(); renderList(); }
      else if (action === 'create') finish({ kind: 'create' });
      else if (action === 'apply') finish({ kind: 'apply', tagIds: [...selected] });
    });
  });
}

async function pickTag(): Promise<void> {
  const c = ctx;
  if (!c) return;
  while (ctx === c && sheetEl) {
    const result = await openTagMultiPicker(c.tags, c.tagIds);
    if (!result) return;
    if (result.kind === 'apply') {
      c.tagIds = result.tagIds;
      refreshMeta();
      return;
    }
    const createdId = await showCreateInput('新标签，如「出差」', ensureTag);
    if (createdId != null) {
      c.tags = await listTags();
      if (!c.tagIds.includes(createdId)) c.tagIds = [...c.tagIds, createdId];
    }
  }
}

async function pickMerchant(): Promise<void> {
  const c = ctx;
  if (!c) return;
  const ranked = rankMerchantSuggestions(c.merchants, c.recommendationHistory, { type: c.type, categoryId: c.categoryId, now: c.recommendationNow });
  const id = await pickList('选择商家（近期同类优先）', ranked.map((m) => ({ id: m.id, label: m.name, icon: 'ic-shop' })), {
    activeId: c.merchantId,
    clearLabel: '不关联商家',
    createPlaceholder: '新商家，如「永辉超市」',
    onCreate: async (name) => {
      const nid = await ensureMerchant(name);
      c.merchants = await listMerchants();
      return nid;
    },
  });
  if (id === undefined) return;
  c.merchantId = id ?? undefined;
  refreshMeta();
}

/* ── 保存 ─────────────────────────── */

/** 保存互斥标志：防止连点「保存/再记」重复入账 */
let saving = false;
/** 本次打开的保存成功回调（AI 草稿等外部流程消费） */
let savedCallback: ((entryId: number) => void) | undefined;

async function rememberLastUsed(c: SheetCtx): Promise<void> {
  const next = {
    ...c.lastUsed,
    type: c.type,
    accountId: c.accountId ?? c.lastUsed.accountId,
    expenseCategoryId: c.type === 'expense' && c.categoryId != null
      ? c.categoryId
      : c.lastUsed.expenseCategoryId,
    incomeCategoryId: c.type === 'income' && c.categoryId != null
      ? c.categoryId
      : c.lastUsed.incomeCategoryId,
  };
  c.lastUsed = next;
  await setSetting('entry.lastUsed', next);
}

/**
 * 入账。stay=true（再记）保留抽屉并清空金额；编辑模式一律保存后关闭。
 */
async function save(stay: boolean): Promise<void> {
  if (saving) return;
  saving = true;
  const saveBtn = sheetEl?.querySelector<HTMLButtonElement>('#keypad .save');
  const againBtn = sheetEl?.querySelector<HTMLButtonElement>('#keypad .again');
  const clearBtn = sheetEl?.querySelector<HTMLButtonElement>('#amount-clear');
  if (saveBtn) saveBtn.disabled = true;
  if (againBtn) againBtn.disabled = true;
  if (clearBtn) clearBtn.disabled = true;
  try {
    await doSave(stay);
  } finally {
    saving = false;
    if (saveBtn?.isConnected) saveBtn.disabled = false;
    if (againBtn?.isConnected) againBtn.disabled = false;
    if (clearBtn && ctx && sheetEl?.contains(clearBtn)) refreshAmt();
  }
}

async function doSave(stay: boolean): Promise<void> {
  const c = ctx;
  if (!c || !sheetEl) return;
  if (c.op != null) {
    if (!calcApply()) return;
    refreshAmt();
  }

  let fen: number;
  try {
    fen = parseYuanToFen(c.amt);
  } catch (err) {
    showToast(c.amt ? String(err instanceof Error ? err.message : err) : '请先输入金额');
    return;
  }
  if (fen <= 0) { showToast('请先输入金额'); return; }

  const noteInput = q<HTMLInputElement>('#note');
  const note = noteInput.value.trim() || undefined;

  // 按类型组装账单字段（无关字段显式置空，编辑切类型时避免残留）
  const base: NewEntry = {
    type: c.type,
    amount: fen,
    occurredAt: c.date,
    categoryId: undefined, accountId: undefined,
    fromAccountId: undefined, toAccountId: undefined,
    loanContactId: undefined, loanKind: undefined,
    merchantId: undefined, note,
    reimburseStatus: 'none',
    refundFlag: c.refundOfEntryId != null || (c.editingId != null && c.tk) || undefined,
    refundOfEntryId: c.refundOfEntryId,
  };
  // 已报销支出改成其他类型同样会丢失报销到账影响，一并禁止
  if (c.reimbursedDone && c.type !== 'expense') {
    showToast('已报销账单不可更改类型');
    return;
  }
  let toastMsg = '';
  if (c.type === 'transfer') {
    if (c.fromId == null || c.toId == null) { showToast('请选择转出与转入账户'); return; }
    if (c.fromId === c.toId) { showToast('转出与转入账户不能相同'); return; }
    base.fromAccountId = c.fromId;
    base.toAccountId = c.toId;
    toastMsg = `转账已记录：${accountName(c.fromId)} → ${accountName(c.toId)} ¥${formatFen(fen)}`;
  } else if (c.type === 'loan') {
    if (c.loanAccountId == null) { showToast('请选择应收应付账户'); return; }
    if (c.accountId == null) { showToast('请选择资金账户'); return; }
    base.loanKind = c.loanKind;
    Object.assign(base, loanDirection(c.loanKind, c.accountId, c.loanAccountId));
    const who = c.loanAccounts.find((p) => p.id === c.loanAccountId)?.name ?? '';
    toastMsg = `已记借贷：${LOAN_KIND_META[c.loanKind].name} ${who} ¥${formatFen(fen)}`;
  } else {
    if (c.categoryId == null) { showToast('请选择分类'); return; }
    if (c.accountId == null) { showToast('请选择账户'); return; }
    base.categoryId = c.categoryId;
    base.accountId = c.accountId;
    base.merchantId = c.merchantId;
    if (c.type === 'expense') {
      if (c.reimbursedDone) {
        // 已报销账单：原样保留报销四字段，updateEntry 重放时才会补回到账账户余额
        const done = c.reimbursedDone;
        if (done.reimbursedAmount != null && fen < done.reimbursedAmount) {
          showToast(`金额不得小于已报销金额 ¥${formatFen(done.reimbursedAmount)}`);
          return;
        }
        base.reimburseStatus = 'done';
        base.reimbursedAmount = done.reimbursedAmount;
        base.reimburseAccountId = done.reimburseAccountId;
        base.reimbursedAt = done.reimbursedAt;
      } else {
        base.reimburseStatus = c.bx ? 'pending' : 'none';
      }
      base.refundFlag = c.refundOfEntryId != null || (c.editingId != null && c.tk) || undefined;
    }
    const catName = findCategory(c.categoryId)?.name ?? '';
    toastMsg = c.type === 'expense' ? `已记一笔：${catName} ¥${formatFen(fen)}` : `已记收入：${catName} ¥${formatFen(fen)}`;
  }

  const backdated = dayKey(c.date) !== dayKey(Date.now());
  const tagIds = [...c.tagIds];
  const lifeToggle = q<HTMLElement>('#life-toggle');

  try {
    // 仅组装日记草稿；仓库与账单一起提交，不提前落下孤立记录。
    let lifeNote: NewLifeNote | undefined;
    if (lifeToggle.getAttribute('aria-checked') === 'true') {
      const catName = findCategory(c.categoryId)?.name;
      lifeNote = {
        kind: 'diary',
        title: '随手记',
        body: note ?? (catName ? `记了一笔${catName}` : '记一笔时留下的一句话'),
        linkedAmount: c.type === 'expense' ? fen : undefined,
        occurredAt: c.date,
      };
    }

    const saved = await persistEntry({
      editingId: c.editingId,
      entry: base,
      tagIds,
      originalMerchantId: c.origMerchantId,
      lifeNote,
      receipts: c.receipts?.values().map(receipt => receipt.id == null ? receipt : { id: receipt.id }),
    });
    await rememberLastUsed(c).catch(() => undefined);
    if (c.templateId != null) await rememberTemplate(c.templateId).catch(() => undefined);
    savedCallback?.(saved.entryId);
    if (saved.result === 'updated') {
      showToast('账单已更新');
      closeSheet();
      return;
    }
  } catch (err) {
    showToast(String(err instanceof Error ? err.message : err));
    return;
  }

  if (backdated) toastMsg = `已为 ${dateLabel(c.date)} 补记：¥${formatFen(fen)}，计入当日流水与报表`;
  showToast(toastMsg + (stay ? '，可继续记下一笔' : ''));

  if (!stay) { closeSheet(); return; }

  // 再记：继承类型/分类/账户/标签/商家，清空金额与随笔性内容。
  c.receipts?.clear();
  const repeat = createRepeatDraft({
    type: c.type,
    amount: fen,
    categoryId: c.categoryId,
    accountId: c.accountId,
    fromId: c.fromId,
    toId: c.toId,
    loanAccountId: c.loanAccountId,
    loanKind: c.loanKind,
    tagIds: c.tagIds,
    merchantId: c.merchantId,
    occurredAt: c.date,
    note,
    reimbursePending: c.bx,
    linkLife: lifeToggle.getAttribute('aria-checked') === 'true',
  });
  c.amt = repeat.amount;
  c.prev = null;
  c.prevAmount = null;
  c.op = null;
  c.bx = repeat.reimbursePending;
  c.tk = false;
  c.tagIds = repeat.tagIds ?? [];
  c.merchantId = repeat.merchantId;
  noteInput.value = repeat.note;
  c.noteCategoryId = undefined;
  lifeToggle.classList.remove('on'); lifeToggle.setAttribute('aria-checked', 'false');
  refreshAmt();
  refreshMeta();
  if (c.type === 'loan') void updateLoanHint();
}

/** 只允许完整备注更新系统默认分类；没有命中时分类和账户均保持原样。 */
function applyNoteCategory(c: SheetCtx, note: string): boolean {
  if (c.categorySelectionLocked || (c.type !== 'expense' && c.type !== 'income')) return false;
  const categories = c.type === 'income'
    ? c.incomeCats
    : c.expenseTree.flatMap(group => group.children.length ? group.children : [group.parent]);
  const matchedId = matchNoteCategoryId(categories, note);
  if (matchedId == null) return false;
  c.categoryId = matchedId;
  c.noteCategoryId = matchedId;
  refreshEntryRecommendations(c);
  return true;
}
