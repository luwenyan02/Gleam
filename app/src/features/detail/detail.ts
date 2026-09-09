import { loanAccountId } from '../../core/loanLedger';
/**
 * 拾光 · 账单明细子页（PRD 4.3）：全量账单列表（分块渲染 + 滚动加载）、
 * 分类 / 账户两组 chip 筛选可叠加、顶部实时汇总；批量改分类 / 改账户 / 删除。
 * 左滑操作 / 只读详情 / 退款录入已拆分至 entrySwipe / entryView / refundSheet，
 * 本文件保留 re-export 以兼容既有 import 路径（home / account / search / loan）。
 */
import { iconHtml } from '../../assets/icons';
import { esc } from '../../core/esc';
import { formatFen, formatFenCny } from '../../core/money';
import { on } from '../../core/store';
import {
  LOAN_KIND_META,
  type Account, type Category, type Entry,
} from '../../core/types';
import {
  listEntries,
  type EntryFilter,
} from '../../core/repo/entryRepo';
import {
  applyBatchEntries, previewBatchEntries,
  type BatchEntryOperation, type BatchEntryPreview,
} from '../../core/repo/batchEntryRepo';
import { listCategories, listExpenseTree } from '../../core/repo/categoryRepo';
import { listAccounts } from '../../core/repo/accountRepo';
import { listLoanAccounts } from '../../core/repo/loanRepo';
import { registerSubpage } from '../shell/router';
import { showToast } from '../shell/toast';
import { confirmDialog } from '../shell/dialog';
import {
  entrySwipeActionsHtml, bindEntrySwipeActions, runEntryQuickAction, openEntryDetail,
  type EntryQuickAction,
} from './entrySwipe';
import { dayLabel, sheetPick } from './detailShared';
import { renderEntryView } from './entryView';
import { renderRefundPage } from './refundSheet';

// 对外契约保持不变：左滑 / 详情 / 退款相关能力统一从本模块 re-export
export {
  openEntryDetail, openRefundPage, entrySwipeActionsHtml, bindEntrySwipeActions,
  runEntryQuickAction, type EntryQuickAction,
} from './entrySwipe';

const CHUNK = 60;

/** 注册账单明细子页（main.ts 调用一次） */
export function initDetail(): void {
  registerSubpage('sp-entry-detail', {
    title: '账单明细',
    render(body) { void renderDetail(body); },
  });
  registerSubpage('sp-entry-view', {
    title: '账单详情',
    render(body) { void renderEntryView(body); },
  });
  registerSubpage('sp-entry-refund', {
    title: '添加支出退款',
    render(body) { void renderRefundPage(body); },
  });
}

async function renderDetail(body: HTMLElement): Promise<void> {
  const [tree, incomeCats, accounts, contacts] = await Promise.all([
    listExpenseTree(), listCategories('income'), listAccounts(true), listLoanAccounts(),
  ]);
  const catMap = new Map<number, Category>();
  for (const g of tree) {
    catMap.set(g.parent.id, g.parent);
    for (const ch of g.children) catMap.set(ch.id, ch);
  }
  for (const cat of incomeCats) catMap.set(cat.id, cat);
  const acctMap = new Map<number, Account>(accounts.map((a) => [a.id, a]));
  const contactMap = new Map<number, Account>(contacts.map((p) => [p.id, p]));

  // 筛选状态：catSel = 支出大类 id | 'income' | null（全部）；acctSel = 账户 id | null
  let catSel: number | 'income' | null = null;
  let acctSel: number | null = null;
  let batchMode = false;
  const selected = new Set<number>();
  let shown = CHUNK;
  let filtered: Entry[] = [];

  body.innerHTML = `
    <div class="flt-row" id="flt-cat" role="tablist" aria-label="按分类筛选">
      <span class="tpl-lbl">分类</span>
      <button class="chip active" data-cat="all">全部</button>
      ${tree.map((g) => `<button class="chip" data-cat="${g.parent.id}">${esc(g.parent.name)}</button>`).join('')}
      <button class="chip" data-cat="income">收入</button>
    </div>
    <div class="flt-row" id="flt-acct" role="tablist" aria-label="按账户筛选">
      <span class="tpl-lbl">账户</span>
      <button class="chip active" data-acct="all">全部</button>
      ${accounts.map((a) => `<button class="chip" data-acct="${a.id}">${esc(a.name)}</button>`).join('')}
    </div>
    <p class="sub" id="dt-sum" style="padding:2px 2px 10px"></p>
    <div class="card list" id="dt-list" aria-label="账单列表"></div>
    <p class="tiny" id="dt-more" style="text-align:center;padding:8px 0"></p>`;

  // 「批量」chip 挂到子页头部，batch-bar 挂到子页尾部（贴底）
  const subpage = body.closest<HTMLElement>('.subpage')!;
  const head = subpage.querySelector('.sub-head')!;
  const batchBtn = document.createElement('button');
  batchBtn.className = 'chip';
  batchBtn.id = 'dt-batch';
  batchBtn.style.marginLeft = 'auto';
  batchBtn.textContent = '批量';
  head.appendChild(batchBtn);
  const batchBar = document.createElement('div');
  batchBar.className = 'batch-bar';
  batchBar.hidden = true;
  batchBar.innerHTML = `
    <span class="sub" id="bb-count">已选 0 笔</span>
    <button class="chip" id="bb-cat">改分类</button>
    <button class="chip" id="bb-acct">改账户</button>
    <button class="chip danger" id="bb-del">删除</button>`;
  subpage.appendChild(batchBar);

  const listEl = body.querySelector<HTMLElement>('#dt-list')!;
  const sumEl = body.querySelector<HTMLElement>('#dt-sum')!;
  const moreEl = body.querySelector<HTMLElement>('#dt-more')!;

  async function load(): Promise<void> {
    const filter: EntryFilter = {};
    if (catSel === 'income') filter.type = 'income';
    else if (catSel != null) {
      const g = tree.find((x) => x.parent.id === catSel);
      filter.categoryIds = g ? [g.parent.id, ...g.children.map((ch) => ch.id)] : [catSel];
    }
    if (acctSel != null) filter.accountIds = [acctSel];
    filtered = await listEntries(filter);
    for (const id of [...selected]) {
      if (!filtered.some((entry) => entry.id === id)) selected.delete(id);
    }
    renderList();
  }

  function renderList(): void {
    let expense = 0;
    let income = 0;
    for (const entry of filtered) {
      if (entry.type === 'expense') expense += entry.refundFlag ? -entry.amount : entry.amount;
      else if (entry.type === 'income') income += entry.amount;
    }
    sumEl.textContent = `筛选结果：${filtered.length} 笔 · 支出 ${formatFenCny(expense)} · 收入 ${formatFenCny(income)}`;
    const slice = filtered.slice(0, shown);
    listEl.innerHTML = slice.length
      ? slice.map((entry) => rowHtml(entry)).join('')
      : '<p class="tiny" style="padding:16px;text-align:center">没有符合筛选条件的账单</p>';
    moreEl.textContent = filtered.length > shown ? '下拉加载更多…' : (filtered.length ? '已展示全部' : '');
    updateBatchBar();
  }

  function rowHtml(entry: Entry): string {
    const lead = batchMode
      ? `<span class="ck${selected.has(entry.id) ? ' on' : ''}" aria-hidden="true"></span>`
      : leadIcon(entry);
    const { title, meta } = entryText(entry);
    const amt = entryAmt(entry);
    return `<div class="entry-swipe" data-id="${entry.id}">
      ${entrySwipeActionsHtml(entry)}
      <article class="entry entry-swipe-content" role="button" tabindex="0">
        ${lead}
        <div class="e-main"><p class="e-title">${title}</p><p class="e-meta">${meta}</p></div>
        ${amt}</article>
    </div>`;
  }

  function leadIcon(entry: Entry): string {
    if (entry.type === 'transfer') return `<span class="e-ic neutral">${iconHtml('ic-swap')}</span>`;
    if (entry.type === 'loan') return `<span class="e-ic neutral">${iconHtml(LOAN_KIND_META[entry.loanKind ?? 'borrow'].icon)}</span>`;
    const cat = catMap.get(entry.categoryId ?? -1);
    return `<span class="e-ic${entry.type === 'expense' ? '' : ' neutral'}">${iconHtml(cat?.icon ?? 'ic-coin')}</span>`;
  }

  function entryText(entry: Entry): { title: string; meta: string } {
    const day = dayLabel(entry.occurredAt);
    const note = entry.note ? ` <span class="e-sub">· ${esc(entry.note)}</span>` : '';
    if (entry.type === 'transfer') {
      const from = acctMap.get(entry.fromAccountId ?? -1)?.name ?? '账户';
      const to = acctMap.get(entry.toAccountId ?? -1)?.name ?? '账户';
      return { title: `转账${note}`, meta: `${day} · ${esc(from)} → ${esc(to)}` };
    }
    if (entry.type === 'loan') {
      const kind = LOAN_KIND_META[entry.loanKind ?? 'borrow'];
      const who = contactMap.get(loanAccountId(entry) ?? -1)?.name ?? '未选择应收应付账户';
      const from = acctMap.get(entry.fromAccountId ?? -1)?.name ?? '账户';
      const to = acctMap.get(entry.toAccountId ?? -1)?.name ?? '账户';
      const acct = `${from} → ${to}`;
      return { title: `${kind.name} · ${esc(who)}${note}`, meta: `${day} · 借贷 · ${esc(acct)}` };
    }
    const cat = catMap.get(entry.categoryId ?? -1);
    const acct = acctMap.get(entry.accountId ?? -1)?.name ?? '账户';
    const marks = [
      entry.reimburseStatus === 'pending' ? ' · 待报销' : '',
      entry.reimburseStatus === 'done' ? ' · 已报销' : '',
      entry.refundFlag ? ' · 退款到账' : '',
    ].join('');
    return {
      title: `${esc(cat?.name ?? '未分类')}${note}`,
      meta: `${day} · ${esc(cat?.name ?? '未分类')} · ${esc(acct)}${marks}`,
    };
  }

  function entryAmt(entry: Entry): string {
    if (entry.type === 'transfer') return `<p class="e-amt num">${formatFen(entry.amount)}</p>`;
    const inflow = entry.type === 'income' || entry.refundFlag
      || entry.loanKind === 'borrow' || entry.loanKind === 'collect';
    return `<p class="e-amt num ${inflow ? 'in' : 'out'}">${inflow ? '+' : '-'}${formatFen(entry.amount)}</p>`;
  }

  function updateBatchBar(): void {
    batchBar.hidden = !batchMode;
    batchBar.querySelector('#bb-count')!.textContent = `已选 ${selected.size} 笔`;
    batchBtn.textContent = batchMode ? '完成' : '批量';
    batchBtn.classList.toggle('active', batchMode);
  }

  /* ── 事件 ── */

  body.querySelector('#flt-cat')!.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-cat]');
    if (!btn) return;
    const v = btn.dataset.cat!;
    catSel = v === 'all' ? null : v === 'income' ? 'income' : Number(v);
    btn.parentElement!.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c === btn));
    shown = CHUNK;
    void load();
  });
  body.querySelector('#flt-acct')!.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-acct]');
    if (!btn) return;
    const v = btn.dataset.acct!;
    acctSel = v === 'all' ? null : Number(v);
    btn.parentElement!.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c === btn));
    shown = CHUNK;
    void load();
  });

  batchBtn.addEventListener('click', () => {
    batchMode = !batchMode;
    if (!batchMode) selected.clear();
    renderList();
  });

  listEl.addEventListener('click', (e) => {
    const actionButton = (e.target as HTMLElement).closest<HTMLElement>('[data-entry-action]');
    const row = (e.target as HTMLElement).closest<HTMLElement>('[data-id]');
    if (!row) return;
    if (row.dataset.swipeSuppress === 'true') return;
    const id = Number(row.dataset.id);
    const entry = filtered.find((item) => item.id === id);
    if (actionButton && entry) {
      const action = actionButton.dataset.entryAction as EntryQuickAction;
      if (actionButton.getAttribute('aria-disabled') === 'true') {
        showToast('仅普通支出账单支持退款');
        return;
      }
      void runEntryQuickAction(action, entry);
      return;
    }
    if (batchMode) {
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
      row.querySelector('.ck')?.classList.toggle('on', selected.has(id));
      updateBatchBar();
      return;
    }
    if (entry) openEntryDetail(entry.id);
  });
  listEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = (e.target as HTMLElement).closest<HTMLElement>('[data-id]');
    if (!row || batchMode) return;
    e.preventDefault();
    openEntryDetail(Number(row.dataset.id));
  });
  bindEntrySwipeActions(listEl);

  // 滚动到底加载更多（.sub-body 为滚动容器）
  body.addEventListener('scroll', () => {
    if (shown >= filtered.length) return;
    if (body.scrollTop + body.clientHeight >= body.scrollHeight - 200) {
      shown += CHUNK;
      renderList();
    }
  });

  /* ── 批量操作 ── */

  function previewText(preview: BatchEntryPreview): string {
    const reasons = new Map<string, number>();
    for (const item of preview.skipped) reasons.set(item.reason, (reasons.get(item.reason) ?? 0) + 1);
    const skipped = preview.skipped.length
      ? `；跳过 ${preview.skipped.length} 笔（${[...reasons].map(([reason, count]) => `${reason} ${count} 笔`).join('，')}）`
      : '';
    return `可处理 ${preview.processableIds.length} 笔${skipped}`;
  }

  async function runBatch(
    operation: BatchEntryOperation,
    copy: { title: string; okText: string; success: string; danger?: boolean; recovery?: string },
  ): Promise<void> {
    let preview: BatchEntryPreview;
    try {
      preview = await previewBatchEntries([...selected], operation);
    } catch (err) {
      showToast(`批量操作无法执行：${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (!preview.processableIds.length) {
      showToast(`没有可处理的账单。${previewText(preview)}`);
      return;
    }
    const ok = await confirmDialog({
      title: copy.title,
      message: `${previewText(preview)}${copy.recovery ? `。${copy.recovery}` : ''}`,
      okText: copy.okText,
      danger: copy.danger,
    });
    if (!ok) return;
    try {
      const result = await applyBatchEntries([...selected], operation);
      selected.clear();
      batchMode = false;
      showToast(`${copy.success} ${result.appliedIds.length} 笔${result.skipped.length ? `，跳过 ${result.skipped.length} 笔` : ''}`);
    } catch (err) {
      showToast(`批量操作失败，已回滚整批修改：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  batchBar.querySelector('#bb-del')!.addEventListener('click', () => {
    if (!selected.size) { showToast('请先勾选账单'); return; }
    void runBatch(
      { kind: 'delete' },
      {
        title: `删除选中的 ${selected.size} 笔账单？`, okText: '删除', success: '已删除',
        danger: true, recovery: '删除后进入回收站，30 天内可恢复',
      },
    );
  });

  batchBar.querySelector('#bb-cat')!.addEventListener('click', () => {
    void (async () => {
      if (!selected.size) { showToast('请先勾选账单'); return; }
      const picked = await sheetPick('改分类（转账 / 借贷账单将跳过）', [
        ...tree.flatMap((g) => g.children.map((ch) => ({ id: ch.id, label: `${g.parent.name} · ${ch.name}`, icon: ch.icon }))),
        ...incomeCats.map((cat) => ({ id: cat.id, label: `收入 · ${cat.name}`, icon: cat.icon })),
      ]);
      if (picked == null) return;
      await runBatch(
        { kind: 'category', categoryId: picked },
        { title: '确认批量修改分类？', okText: '修改', success: '已改分类' },
      );
    })();
  });

  batchBar.querySelector('#bb-acct')!.addEventListener('click', () => {
    void (async () => {
      if (!selected.size) { showToast('请先勾选账单'); return; }
      const picked = await sheetPick('改账户（转账 / 借贷账单将跳过）',
        accounts.map((a) => ({ id: a.id, label: a.name, icon: 'ic-wallet', note: formatFen(a.balance) })));
      if (picked == null) return;
      await runBatch(
        { kind: 'account', accountId: picked },
        { title: '确认批量修改账户？', okText: '修改', success: '已改账户' },
      );
    })();
  });

  /* ── 数据变化刷新（子页关闭即自动退订） ── */

  const off = on('entries-changed', () => {
    if (!body.isConnected) { off(); return; }
    void load();
  });

  await load();
}
