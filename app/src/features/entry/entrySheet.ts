/**
 * 拾光 · 记一笔全高度工作台（PRD 4.1）
 * 通过 shell 的 openSheet 承载。四类型分段切换（收入/支出/转账/借贷），
 * 计算器键盘连续四则运算（从左到右、无优先级），速记模板、标签/商家/报销退款标记、
 * 历史日期补账、「同时写生活记录」联动，编辑模式预填全部字段。
 *
 * 对外契约：openEntrySheet(options)（日历补账 / 速记 / 明细编辑复用）。
 */
import { iconHtml } from '../../assets/icons';
import { esc } from '../../core/esc';
import { parseYuanToFen, formatFen } from '../../core/money';
import {
  LOAN_KINDS, LOAN_KIND_META,
  type Account, type Category, type Entry, type EntryType, type LoanKind,
  type LoanContact, type Merchant, type QuickTemplate, type Tag,
} from '../../core/types';
import {
  getEntry, getEntryTagIds, dayKey, getNoteFrequencies, listEntries,
  type NewEntry, type NoteFrequency,
} from '../../core/repo/entryRepo';
import { listExpenseTree, listCategories } from '../../core/repo/categoryRepo';
import { listAccounts } from '../../core/repo/accountRepo';
import { listTemplates } from '../../core/repo/templateRepo';
import { listTags, ensureTag } from '../../core/repo/tagRepo';
import { listMerchants, ensureMerchant } from '../../core/repo/merchantRepo';
import { listLoanContacts, getLoanContact, ensureLoanContact } from '../../core/repo/loanRepo';
import { addLifeNote } from '../../core/repo/lifeRepo';
import { getSetting, setSetting } from '../../core/repo/settingsRepo';
import { openSheet, closeSheet } from '../shell/sheet';
import { openSubpage } from '../shell/router';
import { setFabAction } from '../shell/shell';
import { showToast } from '../shell/toast';
import { openDateTimeWheel } from '../../shared/dateTimeWheel';
import { openPickList, type PickListItem } from '../../shared/pickList';
import { createRepeatDraft, rankFrequentCategories, resolveInitialEntryType } from './entryWorkspace';
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
import './entry.css';

/**
 * 打开「记一笔」抽屉的选项。
 */
export interface EntrySheetOptions {
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
  /** 从已有账单创建一笔新草稿；继承业务选择，但不继承金额与备注。 */
  repeatFromEntryId?: number;
}

/* ── 抽屉内部状态 ─────────────────── */

interface SheetCtx {
  type: EntryType;
  /** 当前操作数（元，字符串） */
  amt: string;
  prev: number | null;
  op: CalculatorOperator | null;
  /** 支出/收入选中分类 id */
  categoryId?: number;
  loanKind: LoanKind;
  /** 支出/收入/借贷资金账户 */
  accountId?: number;
  fromId?: number;
  toId?: number;
  contactId?: number;
  /** 记账日期（毫秒时间戳） */
  date: number;
  bx: boolean;
  tk: boolean;
  tagId?: number;
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
  templates: QuickTemplate[];
  tags: Tag[];
  merchants: Merchant[];
  contacts: LoanContact[];
  lastUsed: {
    expenseCategoryId: number | null;
    incomeCategoryId: number | null;
    accountId: number | null;
    type?: EntryType | null;
  };
  quickExpenseCats: Category[];
  quickIncomeCats: Category[];
  showAllCategories: boolean;
  advancedOpen: boolean;
}

let ctx: SheetCtx | null = null;
let sheetEl: HTMLElement | null = null;

/** 备注历史频率缓存（openEntrySheet 预载，建议 chip 纯前端过滤） */
let noteFreqs: NoteFrequency[] = [];
/** 当前展示的建议项（chip 用 data-note-idx 索引，避免备注原文进 HTML 属性） */
let noteSuggestItems: NoteFrequency[] = [];

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
  const openedAt = Date.now();
  const [tree, incomeCats, accounts, templates, tags, merchants, contacts, lastUsed, freqs, recentEntries] = await Promise.all([
    listExpenseTree(), listCategories('income'), listAccounts(false),
    listTemplates(), listTags(), listMerchants(), listLoanContacts(), getSetting('entry.lastUsed'),
    getNoteFrequencies(),
    listEntries({ from: openedAt - 90 * 24 * 60 * 60 * 1000, to: openedAt + 1 }),
  ]);
  noteFreqs = freqs;

  const expenseCats = tree.flatMap((group) => group.children.length ? group.children : [group.parent]);
  const firstExpense = expenseCats[0];
  const expenseIds = new Set(tree.flatMap((group) => [group.parent.id, ...group.children.map((cat) => cat.id)]));
  const accountIds = new Set(accounts.map((account) => account.id));
  const preferredAccountId = options.presetAccountId != null && accountIds.has(options.presetAccountId)
    ? options.presetAccountId
    : lastUsed.accountId != null && accountIds.has(lastUsed.accountId)
      ? lastUsed.accountId
      : accounts[0]?.id;
  const initialType = resolveInitialEntryType(options.presetType, lastUsed.type);
  const c: SheetCtx = {
    type: initialType,
    amt: '', prev: null, op: null,
    categoryId: initialType === 'income'
      ? lastUsed.incomeCategoryId ?? incomeCats[0]?.id
      : lastUsed.expenseCategoryId != null && expenseIds.has(lastUsed.expenseCategoryId)
        ? lastUsed.expenseCategoryId
        : firstExpense?.id,
    loanKind: 'borrow',
    accountId: preferredAccountId,
    fromId: preferredAccountId,
    toId: accounts.find((account) => account.id !== preferredAccountId)?.id ?? preferredAccountId,
    contactId: contacts[0]?.id,
    date: options.presetDate ?? Date.now(),
    bx: false, tk: false,
    expenseTree: tree, incomeCats, accounts, templates, tags, merchants, contacts, lastUsed,
    quickExpenseCats: rankFrequentCategories(
      expenseCats,
      recentEntries.filter((entry) => entry.type === 'expense'),
      { now: openedAt },
    ),
    quickIncomeCats: rankFrequentCategories(
      incomeCats,
      recentEntries.filter((entry) => entry.type === 'income'),
      { now: openedAt },
    ),
    showAllCategories: false,
    advancedOpen: false,
  };

  const sourceId = options.entryId ?? options.repeatFromEntryId;
  let sourceEntry: Entry | undefined;
  let initialNote = '';
  if (sourceId != null) {
    sourceEntry = await getEntry(sourceId);
    if (!sourceEntry) { showToast('账单不存在或已删除'); return; }
    const tagIds = await getEntryTagIds(sourceEntry.id);
    c.type = sourceEntry.type;
    c.categoryId = sourceEntry.categoryId ?? c.categoryId;
    c.accountId = sourceEntry.accountId ?? c.accountId;
    c.fromId = sourceEntry.fromAccountId ?? c.fromId;
    c.toId = sourceEntry.toAccountId ?? c.toId;
    c.loanKind = sourceEntry.loanKind ?? 'borrow';
    c.contactId = sourceEntry.loanContactId ?? c.contactId;
    c.date = sourceEntry.occurredAt;
    c.tagId = tagIds[0];
    c.merchantId = sourceEntry.merchantId;
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
    c.advancedOpen = c.bx || c.tagId != null || c.merchantId != null || editEntry.lifeNoteId != null;
    initialNote = editEntry.note ?? '';
  } else if (options.templateId != null) {
    const tpl = templates.find((t) => t.id === options.templateId);
    if (tpl) {
      c.type = 'expense';
      c.categoryId = tpl.categoryId;
      c.amt = String(tpl.amount / 100);
    }
  }

  ctx = c;
  openSheet({
    ariaLabel: c.editingId ? '编辑账单' : '记一笔',
    render(el) {
      sheetEl = el;
      renderSheet(el, initialNote);
    },
    onClose() {
      sheetEl?.classList.remove('entry-workspace', 'note-editing', 'categories-expanded');
      ctx = null;
      sheetEl = null;
    },
  });
}

/* ── 渲染 ─────────────────────────── */

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
        <span>常用分类</span><small>按近 90 天使用习惯排序</small>
      </div>
      <div id="cat-grid" class="cat-grid" role="listbox" aria-label="选择分类"></div>
      ${renderTypeForms()}
      <input class="note" id="note" type="text" placeholder="写点备注（可选）" aria-label="备注">
      <div class="note-suggest" id="note-suggest" aria-label="备注历史建议"></div>
      <div class="meta-row primary-meta">
        <button class="chip" id="date-chip">${iconHtml('ic-cal', 16)}<span id="date-txt"></span></button>
        <button class="chip" id="acct-btn">${iconHtml('ic-wallet', 16)}<span id="acct-name"></span></button>
        <button class="chip" type="button" id="mark-bx" aria-pressed="false">报销</button>
        <button class="chip advanced-toggle" type="button" data-act="toggle-advanced" aria-expanded="false" aria-controls="advanced-fields">
          ${iconHtml('ic-set', 16)}<span id="advanced-label">更多</span>
        </button>
      </div>
      ${renderAdvancedFields(c.templates)}
    </div>
    <div class="keypad" id="keypad" aria-label="计算器键盘">
      <button data-k="1">1</button><button data-k="2">2</button><button data-k="3">3</button><button data-k="+" class="op" aria-label="加">+</button><button data-k="del" class="op" aria-label="删除一位">${iconHtml('ic-del')}</button>
      <button data-k="4">4</button><button data-k="5">5</button><button data-k="6">6</button><button data-k="-" class="op" aria-label="减">−</button><button data-k="again" class="again">再记</button>
      <button data-k="7">7</button><button data-k="8">8</button><button data-k="9">9</button><button data-k="md" class="op" aria-label="乘除">×÷</button><button data-k="save" class="save">保存</button>
      <button data-k="0" class="zero">0</button><button data-k=".">.</button><button data-k="=" class="op" aria-label="等于">=</button>
    </div>`;

  (el.querySelector<HTMLInputElement>('#note')!).value = note;
  bindEvents(el);
  renderCats();
  refreshAmt();
  refreshMeta();
}

const q = <T extends HTMLElement = HTMLElement>(sel: string): T => sheetEl!.querySelector<T>(sel)!;

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
  q('#pick-ic').innerHTML = iconHtml(cat?.icon ?? 'ic-coin');
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
    : c.showAllCategories ? '选择后自动回到常用分类' : '按近 90 天使用习惯排序';
  q('#tpl-row').hidden = c.type !== 'expense';
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
  if (isLoan) {
    grid.innerHTML = LOAN_KINDS.map((k) => {
      const meta = LOAN_KIND_META[k];
      const sel = k === c.loanKind;
      return `<button class="cat${sel ? ' sel' : ''}" data-kind="${k}" type="button" role="option" aria-selected="${sel}">
        <span class="cat-ic">${iconHtml(meta.icon)}</span><span>${meta.name}</span></button>`;
    }).join('');
    q('#loan-acct-lbl').textContent = c.loanKind === 'borrow' || c.loanKind === 'collect' ? '转入账户' : '转出账户';
    orderLoanFlow(q('#loan-flow'), c.loanKind === 'lend' || c.loanKind === 'repay');
    q('#loan-acct b').textContent = accountName(c.accountId);
    q('#loan-who b').textContent = c.contacts.find((p) => p.id === c.contactId)?.name ?? '选择对象';
    void updateLoanHint();
  } else if (c.type === 'expense') {
    if (c.showAllCategories) {
      grid.innerHTML = c.expenseTree.map((group) => {
        const choices = group.children.length ? group.children : [group.parent];
        return `<div class="cat-sec">${esc(group.parent.name)}</div>` +
          choices.map((cat) => renderCategoryButton(cat, cat.id === c.categoryId)).join('');
      }).join('') + renderCategoryToggle(true);
    } else {
      grid.innerHTML = selectQuickCategories(c.quickExpenseCats, findCategory(c.categoryId))
        .map((cat) => renderCategoryButton(cat, cat.id === c.categoryId)).join('') + renderCategoryToggle(false);
    }
  } else if (c.type === 'income') {
    const choices = c.showAllCategories
      ? c.incomeCats
      : selectQuickCategories(c.quickIncomeCats, findCategory(c.categoryId));
    grid.innerHTML = choices.map((cat) => renderCategoryButton(cat, cat.id === c.categoryId)).join('') +
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
  if (c.contactId == null) { hint.textContent = '请选择往来对象'; return; }
  const contact = await getLoanContact(c.contactId);
  const bal = contact?.balance ?? 0;
  hint.textContent = bal > 0
    ? `与 TA 的往来：TA 欠你 ¥${formatFen(bal)}`
    : bal < 0
      ? `与 TA 的往来：你欠 TA ¥${formatFen(-bal)}`
      : '与 TA 的往来：暂无未结清款项';
}

/** 日期/账户/标记/标签/商家 chip 文案同步 */
function refreshMeta(): void {
  const c = ctx!;
  q('#date-txt').textContent = dateLabel(c.date);
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
  const tag = c.tags.find((t) => t.id === c.tagId);
  q('#tag-txt').textContent = tag ? `#${tag.name}` : '标签';
  q('#chip-tag').classList.toggle('active', !!tag);
  const shop = c.merchants.find((m) => m.id === c.merchantId);
  q('#shop-txt').textContent = shop ? shop.name : '商家';
  q('#chip-shop').classList.toggle('active', !!shop);
  const advanced = q<HTMLElement>('#advanced-fields');
  const advancedToggle = q<HTMLButtonElement>('[data-act="toggle-advanced"]');
  const activeAdvanced = Number(!!tag) + Number(!!shop) +
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

/** 记一笔 chip 文案：日期基础上携带具体时分（如「今天 8月24日 14:30」） */
function dateLabel(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const md = `${d.getMonth() + 1}月${d.getDate()}日`;
  const base = dayKey(ts) === dayKey(today.getTime())
    ? `今天 ${md}`
    : d.getFullYear() === today.getFullYear() ? md : `${d.getFullYear()}年${md}`;
  return `${base} ${hm}`;
}

/* ── 计算器（从左到右、无优先级，与原型一致） ── */

function refreshAmt(): void {
  const c = ctx!;
  const el = q('#amt');
  if (c.op != null) {
    el.textContent = String(c.prev) + OPERATOR_SYMBOL[c.op] + (c.amt || '');
    el.classList.remove('empty');
  } else {
    el.textContent = c.amt || '0.00';
    el.classList.toggle('empty', !c.amt);
  }
  el.classList.toggle('long', (el.textContent ?? '').length > 8);
}

function calculatorState(): CalculatorState {
  const c = ctx!;
  return { amount: c.amt, previous: c.prev, operator: c.op };
}

function syncCalculator(state: CalculatorState): void {
  const c = ctx!;
  c.amt = state.amount;
  c.prev = state.previous;
  c.op = state.operator;
}

function calcApply(): void {
  const state = calculatorState();
  applyCalculation(state);
  syncCalculator(state);
}

function setOp(operator: CalculatorOperator): void {
  const state = calculatorState();
  chooseOperator(state, operator);
  syncCalculator(state);
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
  if (c.refundOfEntryId != null && type !== 'expense') {
    showToast('退款记录必须保持为支出退款类型');
    return;
  }
  c.type = type;
  c.showAllCategories = false;
  for (const button of sheetEl.querySelectorAll<HTMLElement>('#seg button')) {
    const active = button.dataset.type === type;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  }
  if (type === 'expense') {
    const preferred = c.lastUsed.expenseCategoryId;
    const categories = c.expenseTree.flatMap((group) => [group.parent, ...group.children]);
    c.categoryId = categories.some((cat) => cat.id === preferred)
      ? preferred ?? undefined
      : c.expenseTree[0]?.children[0]?.id ?? c.expenseTree[0]?.parent.id;
  } else if (type === 'income') {
    const preferred = c.lastUsed.incomeCategoryId;
    c.categoryId = c.incomeCats.some((cat) => cat.id === preferred)
      ? preferred ?? undefined
      : c.incomeCats[0]?.id;
  }
  renderCats();
  refreshMeta();
}

interface VoiceResultEvent {
  results: { [index: number]: { [index: number]: { transcript: string } } };
}

interface VoiceRecognition {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onresult: ((event: VoiceResultEvent) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
}

type VoiceRecognitionCtor = new () => VoiceRecognition;

function startVoiceInput(): void {
  const host = window as typeof window & {
    SpeechRecognition?: VoiceRecognitionCtor;
    webkitSpeechRecognition?: VoiceRecognitionCtor;
  };
  const Recognition = host.SpeechRecognition ?? host.webkitSpeechRecognition;
  if (!Recognition) {
    showToast('当前设备暂不支持语音输入，可使用速记模板快速记录');
    return;
  }
  const button = q<HTMLButtonElement>('#btn-voice');
  const recognition = new Recognition();
  recognition.lang = 'zh-CN';
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;
  recognition.onstart = () => {
    button.classList.add('listening');
    button.setAttribute('aria-label', '正在聆听，点击系统提示后说出账单');
    showToast('请说，例如「午餐 28 元」');
  };
  recognition.onend = () => {
    button.classList.remove('listening');
    button.setAttribute('aria-label', '语音输入');
  };
  recognition.onerror = () => showToast('没有听清，请再试一次');
  recognition.onresult = (event) => applyVoiceText(event.results[0]?.[0]?.transcript ?? '');
  try {
    recognition.start();
  } catch {
    showToast('语音输入暂时不可用，请稍后重试');
  }
}

function applyVoiceText(text: string): void {
  const c = ctx;
  if (!c || !text) return;
  const isIncome = /收入|工资|奖金|兼职|赚了|收到/.test(text);
  switchEntryType(isIncome ? 'income' : 'expense');
  const amount = text.match(/(\d+(?:\.\d{1,2})?)/)?.[1];
  if (amount) c.amt = amount;

  const aliases: Record<string, string> = {
    早饭: '早餐', 午饭: '午餐', 夜宵: '晚餐', 水果: '饮料水果',
    打的: '打车', 房租: '住宿房租', 水电: '水电燃气', 买菜: '超市',
  };
  const categories = c.type === 'income'
    ? c.incomeCats
    : c.expenseTree.flatMap((group) => [group.parent, ...group.children]);
  const aliasName = Object.entries(aliases).find(([word]) => text.includes(word))?.[1];
  const category = categories.find((item) => text.includes(item.name) || item.name === aliasName);
  if (category) c.categoryId = category.id;
  q<HTMLInputElement>('#note').value = text;
  renderCats();
  refreshAmt();
  showToast(amount ? `已识别「${text}」，确认分类后保存` : `已记下「${text}」，请输入金额后保存`);
}

/* ── 事件绑定 ─────────────────────── */

function bindEvents(el: HTMLElement): void {
  el.querySelector('#sheet-close')!.addEventListener('click', closeSheet);
  el.querySelector('#btn-voice')!.addEventListener('click', startVoiceInput);

  const noteInput = el.querySelector<HTMLInputElement>('#note')!;
  noteInput.addEventListener('focus', () => el.classList.add('note-editing'));
  noteInput.addEventListener('blur', () => el.classList.remove('note-editing'));
  noteInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    noteInput.blur();
  });

  // 类型分段切换
  el.querySelector('#seg')!.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-type]');
    if (!btn || !ctx) return;
    switchEntryType(btn.dataset.type as EntryType);
  });

  // 分类宫格 / 借贷四宫格
  el.querySelector('#cat-grid')!.addEventListener('click', (e) => {
    const more = (e.target as HTMLElement).closest<HTMLElement>('[data-cat-more]');
    if (more && ctx) {
      ctx.showAllCategories = !ctx.showAllCategories;
      renderCats();
      return;
    }
    const btn = (e.target as HTMLElement).closest<HTMLElement>('.cat');
    if (!btn || !ctx) return;
    if (btn.dataset.kind) ctx.loanKind = btn.dataset.kind as LoanKind;
    else {
      ctx.categoryId = Number(btn.dataset.id);
      ctx.showAllCategories = false;
    }
    renderCats();
  });

  // 速记模板：一键填充分类 + 金额
  el.querySelector('#tpl-row')!.addEventListener('click', (e) => {
    const manage = (e.target as HTMLElement).closest('[data-tpl-manage]');
    if (manage) { closeSheet(); openSubpage('sp-template-manage'); return; }
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-tpl]');
    if (!btn || !ctx) return;
    const tpl = ctx.templates.find((t) => t.id === Number(btn.dataset.tpl));
    if (!tpl) return;
    ctx.categoryId = tpl.categoryId;
    ctx.amt = String(tpl.amount / 100);
    ctx.prev = null;
    ctx.op = null;
    renderCats();
    refreshAmt();
    showToast(`已按模板填好：${tpl.name}，点保存即可入账`);
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
  el.querySelector('#loan-who')!.addEventListener('click', () => void pickContact());
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
        refreshMeta();
        if (dayKey(ctx.date) !== dayKey(Date.now())) {
          showToast(`记账时间已设为 ${dateLabel(ctx.date)}，保存后计入当日流水`);
        }
      },
    });
    document.body.appendChild(panel);
  });

  // 计算器键盘
  el.querySelector('#keypad')!.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('button');
    if (!btn || !ctx) return;
    const k = btn.dataset.k!;
    const c = ctx;
    if (k === 'del') {
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

  bindNoteSuggest(el);
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
  if (!c.accounts.length) { showToast('请先到「账户」页添加账户'); return; }
  const id = await pickList(title, c.accounts.map((a) => ({
    id: a.id, label: a.name, icon: 'ic-wallet', note: formatFen(a.balance),
  })), { activeId: c[field] });
  if (id == null) return;
  if (field === 'fromId' && id === c.toId) { showToast('转出与转入账户不能相同'); return; }
  if (field === 'toId' && id === c.fromId) { showToast('转出与转入账户不能相同'); return; }
  c[field] = id;
  renderCats();
  refreshMeta();
}

async function pickContact(): Promise<void> {
  const c = ctx;
  if (!c) return;
  const id = await pickList('选择往来对象', c.contacts.map((p) => ({
    id: p.id, label: p.name, icon: 'ic-user',
    note: p.balance > 0 ? `TA 欠你 ${formatFen(p.balance)}` : p.balance < 0 ? `你欠 TA ${formatFen(-p.balance)}` : '已结清',
  })), {
    activeId: c.contactId,
    createPlaceholder: '新对象名称，如「室友小林」',
    onCreate: async (name) => {
      const nid = await ensureLoanContact(name);
      c.contacts = await listLoanContacts();
      return nid;
    },
  });
  if (id == null) return;
  c.contactId = id;
  renderCats();
}

async function pickTag(): Promise<void> {
  const c = ctx;
  if (!c) return;
  const id = await pickList('选择标签（单选）', c.tags.map((t) => ({ id: t.id, label: `#${t.name}`, icon: 'ic-tag' })), {
    activeId: c.tagId,
    clearLabel: '不使用标签',
    createPlaceholder: '新标签，如「出差」',
    onCreate: async (name) => {
      const nid = await ensureTag(name);
      c.tags = await listTags();
      return nid;
    },
  });
  if (id === undefined) return;
  c.tagId = id ?? undefined;
  refreshMeta();
}

async function pickMerchant(): Promise<void> {
  const c = ctx;
  if (!c) return;
  const id = await pickList('选择商家（常用在前）', c.merchants.map((m) => ({ id: m.id, label: m.name, icon: 'ic-shop' })), {
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
  if (saveBtn) saveBtn.disabled = true;
  if (againBtn) againBtn.disabled = true;
  try {
    await doSave(stay);
  } finally {
    saving = false;
    if (saveBtn?.isConnected) saveBtn.disabled = false;
    if (againBtn?.isConnected) againBtn.disabled = false;
  }
}

async function doSave(stay: boolean): Promise<void> {
  const c = ctx;
  if (!c || !sheetEl) return;
  if (c.op != null) { calcApply(); refreshAmt(); }

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
    if (c.contactId == null) { showToast('请选择往来对象'); return; }
    if (c.accountId == null) { showToast('请选择资金账户'); return; }
    base.loanKind = c.loanKind;
    base.loanContactId = c.contactId;
    base.accountId = c.accountId;
    const who = c.contacts.find((p) => p.id === c.contactId)?.name ?? '';
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
  const tagIds = c.tagId != null ? [c.tagId] : [];
  const lifeToggle = q<HTMLElement>('#life-toggle');

  try {
    // 「同时写生活记录」：生成随手记并与账单关联
    if (lifeToggle.getAttribute('aria-checked') === 'true') {
      const catName = findCategory(c.categoryId)?.name;
      base.lifeNoteId = await addLifeNote({
        kind: 'diary',
        title: '随手记',
        body: note ?? (catName ? `记了一笔${catName}` : '记一笔时留下的一句话'),
        linkedAmount: c.type === 'expense' ? fen : undefined,
        occurredAt: c.date,
      });
    }

    const persisted = await persistEntry({
      editingId: c.editingId,
      entry: base,
      tagIds,
      originalMerchantId: c.origMerchantId,
    });
    await rememberLastUsed(c).catch(() => undefined);
    if (persisted === 'updated') {
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
  const repeat = createRepeatDraft({
    type: c.type,
    amount: fen,
    categoryId: c.categoryId,
    accountId: c.accountId,
    fromId: c.fromId,
    toId: c.toId,
    contactId: c.contactId,
    loanKind: c.loanKind,
    tagId: c.tagId,
    merchantId: c.merchantId,
    occurredAt: c.date,
    note,
    reimbursePending: c.bx,
    linkLife: lifeToggle.getAttribute('aria-checked') === 'true',
  });
  c.amt = repeat.amount;
  c.prev = null;
  c.op = null;
  c.bx = repeat.reimbursePending;
  c.tk = false;
  c.tagId = repeat.tagId;
  c.merchantId = repeat.merchantId;
  noteInput.value = repeat.note;
  lifeToggle.classList.remove('on'); lifeToggle.setAttribute('aria-checked', 'false');
  refreshAmt();
  refreshMeta();
  if (c.type === 'loan') void updateLoanHint();
}

/* ── 备注历史建议（R01） ─────────────── */

/**
 * 渲染备注建议 chip 行：按输入内容前端过滤，
 * 当前分类的历史备注排前、全局高频补足，最多 8 条。
 * 显隐由 entry.css 控制（仅 .note-editing 态可见）。
 */
function renderNoteSuggest(el: HTMLElement): void {
  const box = el.querySelector<HTMLElement>('#note-suggest');
  const c = ctx;
  if (!box || !c) return;
  const kw = el.querySelector<HTMLInputElement>('#note')!.value.trim();
  const pool = kw ? noteFreqs.filter((f) => f.note.includes(kw) && f.note !== kw) : noteFreqs;
  const catId = c.type === 'expense' || c.type === 'income' ? c.categoryId : undefined;
  const sorted = catId != null
    ? [...pool].sort((a, b) =>
        Number(b.categoryIds.includes(catId)) - Number(a.categoryIds.includes(catId)) || b.count - a.count)
    : pool;
  noteSuggestItems = sorted.slice(0, 8);
  box.innerHTML = noteSuggestItems
    .map((f, i) => `<button class="chip" type="button" data-note-idx="${i}">${esc(f.note)}</button>`)
    .join('');
}

/** 绑定备注建议行：聚焦/输入时刷新，点 chip 回填（bindEvents 尾部调用一次） */
function bindNoteSuggest(el: HTMLElement): void {
  const noteInput = el.querySelector<HTMLInputElement>('#note')!;
  const box = el.querySelector<HTMLElement>('#note-suggest')!;
  noteInput.addEventListener('focus', () => renderNoteSuggest(el));
  noteInput.addEventListener('input', () => renderNoteSuggest(el));
  // pointerdown + preventDefault：避免点 chip 触发 input blur 移除 .note-editing
  box.addEventListener('pointerdown', (e) => {
    const chip = (e.target as HTMLElement).closest<HTMLElement>('[data-note-idx]');
    if (!chip) return;
    e.preventDefault();
    const item = noteSuggestItems[Number(chip.dataset.noteIdx)];
    if (!item) return;
    noteInput.value = item.note;
    renderNoteSuggest(el);
  });
}
