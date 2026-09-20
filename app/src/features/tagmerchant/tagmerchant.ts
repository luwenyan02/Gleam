/**
 * 拾光 · 标签与商家（features/tagmerchant，PRD 4.13）
 * 标签：列表 / 新建 / 改名 / 删除（删除会移除所有账单关联，提示后确认）；
 * 商家：按使用频次（useCount）排序 / 改名 / 删除（引用账单 merchantId 置空）。
 * 子页 id 为 sp-tags（团队约定，「我的」页入口指向它）。原型无此独立页，
 * 视觉沿用 base.css 的 card list / row / chip 语言。数据一律经 repo。
 */
import './tagmerchant.css';
import { iconHtml } from '../../assets/icons';
import { esc } from '../../core/esc';
import { formatFen, formatFenCny } from '../../core/money';
import { formatAccountingRange } from '../../core/period';
import { on } from '../../core/store';
import { listTags, ensureTag, renameTag, deleteTag } from '../../core/repo/tagRepo';
import { listMerchants, ensureMerchant, renameMerchant, deleteMerchant } from '../../core/repo/merchantRepo';
import { getEntityInsight, type EntityInsightKind, type EntityInsightScope } from '../../core/repo/entityInsightsRepo';
import { listExpenseTree, listCategories } from '../../core/repo/categoryRepo';
import { listAccounts } from '../../core/repo/accountRepo';
import { type LedgerItem } from '../../core/ledgerEvents';
import { registerSubpage, openSubpage } from '../shell/router';
import { openSheet, closeSheet } from '../shell/sheet';
import { showToast } from '../shell/toast';
import { confirmDialog } from '../shell/dialog';
import type { Category, Merchant, Tag } from '../../core/types';
import { entryRowText } from '../detail/entryRowText';
import { openEntryDetail } from '../detail/entrySwipe';

const TAG_COLORS = ['#D84924', '#F79332', '#725BE8', '#18A999', '#3985D5', '#DF577E'] as const;
const safeTagColor = (color?: string): string => color && /^#[0-9a-f]{6}$/i.test(color) ? color : 'var(--primary)';

interface EntityTarget { kind: EntityInsightKind; id: number }
let entityTarget: EntityTarget | undefined;

/** 报表、搜索、账单详情和管理页共用的实体详情入口。 */
export function openEntityInsight(kind: EntityInsightKind, id: number): void {
  entityTarget = { kind, id };
  openSubpage('sp-entity-insight');
}

export function openTagInsight(id: number): void { openEntityInsight('tag', id); }
export function openMerchantInsight(id: number): void { openEntityInsight('merchant', id); }

/** 抽屉监听器控制：#sheet 为复用容器，重开前必须废止上一次绑定 */
let sheetAbort: AbortController | undefined;

function sheetSignal(): AbortSignal {
  sheetAbort?.abort();
  sheetAbort = new AbortController();
  return sheetAbort.signal;
}

/** 注册标签与商家子页（id 约定为 sp-tags），main.ts 调用一次 */
export function initTagMerchant(): void {
  registerSubpage('sp-entity-insight', {
    title: '标签详情',
    render(el) { void renderEntityInsight(el); },
  });
  registerSubpage('sp-tags', {
    title: '标签与商家',
    render(el) {
      let tags: Tag[] = [];
      let merchants: Merchant[] = [];

      el.innerHTML = `
        <p class="sub" style="padding:0 2px 10px">记一笔时可给账单打标签、选商家 · 标签用于报表排行统计，常用商家自动排前</p>
        <section class="card list" aria-label="标签管理">
          <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 2px 0">
            <h3 class="card-title" style="padding:0">标签</h3>
            <button class="restore-link" id="tm-addtag">新建标签</button>
          </div>
          <div id="tm-tags"></div>
        </section>
        <section class="card list" style="margin-top:12px" aria-label="商家管理">
          <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 2px 0">
            <h3 class="card-title" style="padding:0">商家 · 按使用频次排序</h3>
            <button class="restore-link" id="tm-addshop">新建商家</button>
          </div>
          <div id="tm-shops"></div>
        </section>`;

      async function refresh(): Promise<void> {
        if (!el.isConnected) return;
        [tags, merchants] = await Promise.all([listTags(), listMerchants()]);
        if (!el.isConnected) return;

        el.querySelector('#tm-tags')!.innerHTML = tags.length ? tags.map((t) => `
          <div class="tm-manage-row">
            <button class="row tm-open" data-open-tag="${t.id}">
              <span class="tm-tag-dot" style="--tag-color:${safeTagColor(t.color)}"></span>#${esc(t.name)}
              <span class="chev" style="margin-left:auto">${iconHtml('ic-right', 15)}</span>
            </button>
            <button class="icon-btn tm-edit" data-edit-tag="${t.id}" aria-label="编辑标签 ${esc(t.name)}">${iconHtml('ic-pen', 16)}</button>
          </div>`).join('')
          : '<p class="sub" style="padding:12px 2px">还没有标签 · 记一笔时打的标签会出现在这里</p>';

        el.querySelector('#tm-shops')!.innerHTML = merchants.length ? merchants.map((m) => `
          <div class="tm-manage-row">
            <button class="row tm-open" data-open-shop="${m.id}">
              <span class="e-ic sm">${iconHtml('ic-shop', 17)}</span>${esc(m.name)}
              <span class="row-note">用过 ${m.useCount} 次</span>
              <span class="chev" style="margin-left:auto">${iconHtml('ic-right', 15)}</span>
            </button>
            <button class="icon-btn tm-edit" data-edit-shop="${m.id}" aria-label="编辑商家 ${esc(m.name)}">${iconHtml('ic-pen', 16)}</button>
          </div>`).join('')
          : '<p class="sub" style="padding:12px 2px">还没有商家 · 记一笔时选过的商家会出现在这里</p>';
      }

      el.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        if (target.closest('#tm-addtag')) { openNameSheet('tag'); return; }
        if (target.closest('#tm-addshop')) { openNameSheet('shop'); return; }
        const tagOpen = target.closest<HTMLElement>('[data-open-tag]');
        if (tagOpen) { openTagInsight(Number(tagOpen.dataset.openTag)); return; }
        const shopOpen = target.closest<HTMLElement>('[data-open-shop]');
        if (shopOpen) { openMerchantInsight(Number(shopOpen.dataset.openShop)); return; }
        const tagRow = target.closest<HTMLElement>('[data-edit-tag]');
        if (tagRow) {
          const t = tags.find((x) => x.id === Number(tagRow.dataset.editTag));
          if (t) openTagEdit(t);
          return;
        }
        const shopRow = target.closest<HTMLElement>('[data-edit-shop]');
        if (shopRow) {
          const m = merchants.find((x) => x.id === Number(shopRow.dataset.editShop));
          if (m) openShopEdit(m);
        }
      });

      // 标签/商家写操作后统一 emit 'entries-changed'；子页关闭后自动退订
      const off = on('entries-changed', () => {
        if (!el.isConnected) { off(); return; }
        void refresh();
      });
      void refresh();
    },
  });
}

/* ── 标签 / 商家详情 ───────────────── */

async function renderEntityInsight(body: HTMLElement): Promise<void> {
  const target = entityTarget;
  if (!target) { body.innerHTML = '<p class="tiny">未指定标签或商家</p>'; return; }
  const selectedTarget = target;
  const subpage = body.closest<HTMLElement>('.subpage')!;
  body.classList.add('tm-insight-body');
  let scope: EntityInsightScope = 'month';
  let refreshToken = 0;
  let categories = new Map<number, Category>();
  let accounts = new Map<number, string>();

  const [tree, incomes, accountRows] = await Promise.all([
    listExpenseTree(), listCategories('income'), listAccounts(true),
  ]);
  categories = new Map([...tree.flatMap((group) => [group.parent, ...group.children]), ...incomes]
    .map((category) => [category.id, category]));
  accounts = new Map(accountRows.map((account) => [account.id, account.name]));

  body.innerHTML = `
    <div class="tm-scope seg" role="tablist" aria-label="统计范围">
      <button class="active" data-scope="month" role="tab" aria-selected="true">本月</button>
      <button data-scope="year" role="tab" aria-selected="false">本年</button>
      <button data-scope="all" role="tab" aria-selected="false">全部</button>
    </div>
    <div id="tm-insight-content"><p class="tiny" style="padding:24px;text-align:center">正在加载…</p></div>`;

  async function refresh(): Promise<void> {
    const token = ++refreshToken;
    const host = body.querySelector<HTMLElement>('#tm-insight-content');
    if (!host) return;
    try {
      const result = await getEntityInsight({ ...selectedTarget, scope });
      if (!body.isConnected || token !== refreshToken) return;
      const isTag = selectedTarget.kind === 'tag';
      const entity = result.entity as Tag | Merchant;
      subpage.querySelector<HTMLElement>('.sub-head h2')!.textContent = isTag ? '标签详情' : '商家详情';
      const color = isTag ? safeTagColor((entity as Tag).color) : 'var(--primary)';
      const maxAmount = Math.max(1, ...result.trend.map((point) => Math.max(Math.abs(point.expense), Math.abs(point.income))));
      host.innerHTML = `
        <section class="tm-insight-hero">
          <span class="tm-hero-icon" style="--tag-color:${color}">${iconHtml(isTag ? 'ic-tag' : 'ic-shop', 22)}</span>
          <div><p>${isTag ? '标签' : '商家'}</p><h3>${isTag ? '#' : ''}${esc(entity.name)}</h3></div>
          <button class="chip" data-insight-edit>编辑</button>
        </section>
        <p class="sub tm-range">${scope === 'month' ? '' : scope === 'year' ? '自然年 · ' : '全部 · '}${esc(formatAccountingRange(result.range))}</p>
        <section class="tm-summary" aria-label="收支与笔数汇总">
          <div><span>支出</span><b class="num out">${formatFenCny(result.summary.expense)}</b></div>
          <div><span>收入</span><b class="num in">${formatFenCny(result.summary.income)}</b></div>
          <div><span>流水</span><b class="num">${result.totalCount} 笔</b></div>
        </section>
        <section class="card tm-trend" aria-label="${scope === 'month' ? '每日' : scope === 'year' ? '每月' : '每年'}收支趋势">
          <header><h3>收支趋势</h3><p>${scope === 'month' ? '按日' : scope === 'year' ? '按月' : '按年'} · 横滑查看</p></header>
          <div class="tm-trend-scroll">${result.trend.map((point) => `
            <button type="button" class="tm-trend-point" title="${esc(point.label)} 支出 ${formatFenCny(point.expense)} 收入 ${formatFenCny(point.income)}">
              <div class="tm-bars"><i class="expense" style="height:${Math.max(point.expense ? 4 : 0, Math.abs(point.expense) / maxAmount * 72)}px"></i><i class="income" style="height:${Math.max(point.income ? 4 : 0, Math.abs(point.income) / maxAmount * 72)}px"></i></div>
              <span>${esc(point.label)}</span>
            </button>`).join('')}</div>
          <p class="tm-trend-legend"><span class="expense"></span>支出 <span class="income"></span>收入</p>
        </section>
        <section aria-label="统一流水列表">
          <p class="card-title">流水明细 · ${result.totalCount}</p>
          <div class="card list tm-entry-list">${result.items.length
            ? result.items.map((item) => insightEntryHtml(item, categories, accounts)).join('')
            : '<p class="tiny" style="padding:20px;text-align:center">这个范围内还没有关联流水</p>'}</div>
        </section>`;
      host.querySelector('[data-insight-edit]')?.addEventListener('click', () => {
        if (isTag) openTagEdit(entity as Tag); else openShopEdit(entity as Merchant);
      });
      const lastUsed = result.trend.reduce((last, point, index) => point.expense !== 0 || point.income !== 0 ? index : last, -1);
      const scroller = host.querySelector<HTMLElement>('.tm-trend-scroll');
      if (scroller && lastUsed >= 0) scroller.scrollLeft = Math.max(0, (lastUsed + 1) * 48 - scroller.clientWidth);
    } catch (error) {
      host.innerHTML = `<div class="placeholder"><p class="sub">${esc(error instanceof Error ? error.message : String(error))}</p></div>`;
    }
  }

  body.querySelector('.tm-scope')!.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>('[data-scope]');
    if (!button) return;
    scope = button.dataset.scope as EntityInsightScope;
    button.parentElement!.querySelectorAll<HTMLElement>('[data-scope]').forEach((item) => {
      const active = item === button;
      item.classList.toggle('active', active);
      item.setAttribute('aria-selected', String(active));
    });
    void refresh();
  });
  body.addEventListener('click', (event) => {
    const point = (event.target as HTMLElement).closest<HTMLButtonElement>('.tm-trend-point');
    if (point) { showToast(point.title, 3500); return; }
    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-insight-entry]');
    if (row) openEntryDetail(Number(row.dataset.insightEntry));
  });
  const off = on('entries-changed', () => {
    if (!body.isConnected) { off(); return; }
    void refresh();
  });
  await refresh();
}

function insightEntryHtml(
  entry: LedgerItem,
  categories: ReadonlyMap<number, Category>,
  accounts: ReadonlyMap<number, string>,
): string {
  const text = entryRowText(entry, categories, accounts);
  const note = text.note ? ` <span class="e-sub">· ${esc(text.note)}</span>` : '';
  const inflow = entry.type === 'income' || entry.refundFlag || entry.loanKind === 'borrow' || entry.loanKind === 'collect';
  const neutral = entry.type === 'transfer';
  return `<button class="entry tm-insight-entry" data-insight-entry="${entry.id}" type="button">
    <span class="e-ic${text.neutral ? ' neutral' : ''}">${iconHtml(text.icon)}</span>
    <span class="e-main"><span class="e-title">${esc(text.title)}${note}</span><span class="e-meta">${esc(text.meta)}</span></span>
    <span class="e-amt num${neutral ? '' : inflow ? ' in' : ' out'}">${neutral ? '' : inflow ? '+' : '-'}${formatFen(entry.amount)}</span>
  </button>`;
}

/* ── 新建 / 编辑抽屉 ─────────────────── */

/** 新建标签 / 商家（仅一个名称输入） */
function openNameSheet(kind: 'tag' | 'shop'): void {
  const isTag = kind === 'tag';
  openSheet({
    ariaLabel: isTag ? '新建标签' : '新建商家',
    onClose: () => sheetAbort?.abort(),
    render(el) {
      el.innerHTML = `
        <div class="tm-sheet-head">
          <p class="sheet-title">${isTag ? '新建标签' : '新建商家'}</p>
          <button class="icon-btn" data-act="close" aria-label="关闭">${iconHtml('ic-close')}</button>
        </div>
        <div class="sheet-scroll">
          <div class="field"><span>名称</span><input class="note" id="tm-name" maxlength="12" placeholder="${isTag ? '如 出差' : '如 瑞幸咖啡'}" style="margin-bottom:0;flex:1"></div>
          <button class="btn primary" data-act="save" style="margin-top:14px">创建</button>
        </div>`;
      el.addEventListener('click', (e) => {
        const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
        if (act === 'close') closeSheet();
        else if (act === 'save') {
          const name = el.querySelector<HTMLInputElement>('#tm-name')!.value.trim();
          if (!name) { showToast('请填写名称'); return; }
          void (isTag ? ensureTag(name) : ensureMerchant(name))
            .then(() => { closeSheet(); showToast(`已新建「${name}」`); })
            .catch((err: unknown) => showToast(err instanceof Error ? err.message : String(err)));
        }
      }, { signal: sheetSignal() });
    },
  });
}

/** 编辑标签：改名 / 删除（删除会移除所有账单关联） */
function openTagEdit(tag: Tag): void {
  openSheet({
    ariaLabel: `编辑标签：${tag.name}`,
    onClose: () => sheetAbort?.abort(),
    render(el) {
      el.innerHTML = `
        <div class="tm-sheet-head">
          <p class="sheet-title">编辑标签「#${esc(tag.name)}」</p>
          <button class="icon-btn" data-act="close" aria-label="关闭">${iconHtml('ic-close')}</button>
        </div>
        <div class="sheet-scroll">
          <div class="field"><span>名称</span><input class="note" id="tm-name" maxlength="12" value="${esc(tag.name)}" style="margin-bottom:0;flex:1"></div>
          <label class="field"><span>颜色</span><select id="tm-color" aria-label="标签颜色"><option value="">跟随主题</option>${TAG_COLORS.map((color, index) => `<option value="${color}" ${tag.color === color ? 'selected' : ''}>${['橙红', '橙色', '紫色', '青绿', '蓝色', '粉红'][index]}</option>`).join('')}</select></label>
          <button class="btn primary" data-act="save" style="margin-top:14px">保存修改</button>
          <button class="btn ghost" data-act="del" style="margin-top:10px;color:var(--over)">删除标签</button>
          <p class="tiny" style="text-align:center;margin-top:10px">删除后将从所有关联账单移除该标签 · 账单本身不受影响</p>
        </div>`;
      el.addEventListener('click', (e) => {
        const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
        if (act === 'close') closeSheet();
        else if (act === 'save') {
          const name = el.querySelector<HTMLInputElement>('#tm-name')!.value.trim();
          if (!name) { showToast('请填写标签名'); return; }
          void renameTag(tag.id!, name, el.querySelector<HTMLSelectElement>('#tm-color')!.value)
            .then(() => { closeSheet(); showToast(`已改名为「#${name}」`); })
            .catch((err: unknown) => showToast(err instanceof Error ? err.message : String(err)));
        } else if (act === 'del') {
          void confirmDialog({
            title: `删除标签「#${tag.name}」？`,
            message: '删除后将从所有关联账单移除该标签，账单本身不受影响。',
            okText: '删除',
            danger: true,
          }).then(async (ok) => {
            if (!ok) return;
            await deleteTag(tag.id!);
            closeSheet();
            showToast(`已删除标签「#${tag.name}」`);
          });
        }
      }, { signal: sheetSignal() });
    },
  });
}

/** 编辑商家：改名 / 删除（引用账单 merchantId 置空） */
function openShopEdit(m: Merchant): void {
  openSheet({
    ariaLabel: `编辑商家：${m.name}`,
    onClose: () => sheetAbort?.abort(),
    render(el) {
      el.innerHTML = `
        <div class="tm-sheet-head">
          <p class="sheet-title">编辑商家「${esc(m.name)}」</p>
          <button class="icon-btn" data-act="close" aria-label="关闭">${iconHtml('ic-close')}</button>
        </div>
        <div class="sheet-scroll">
          <div class="field"><span>名称</span><input class="note" id="tm-name" maxlength="12" value="${esc(m.name)}" style="margin-bottom:0;flex:1"></div>
          <p class="tiny" style="padding:4px 0 0">已使用 ${m.useCount} 次 · 常用商家在记一笔时自动排前</p>
          <button class="btn primary" data-act="save" style="margin-top:14px">保存修改</button>
          <button class="btn ghost" data-act="del" style="margin-top:10px;color:var(--over)">删除商家</button>
          <p class="tiny" style="text-align:center;margin-top:10px">删除后引用它的账单会清除商家信息 · 账单本身不受影响</p>
        </div>`;
      el.addEventListener('click', (e) => {
        const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
        if (act === 'close') closeSheet();
        else if (act === 'save') {
          const name = el.querySelector<HTMLInputElement>('#tm-name')!.value.trim();
          if (!name) { showToast('请填写商家名'); return; }
          void renameMerchant(m.id!, name)
            .then(() => { closeSheet(); showToast(`已改名为「${name}」`); })
            .catch((err: unknown) => showToast(err instanceof Error ? err.message : String(err)));
        } else if (act === 'del') {
          void confirmDialog({
            title: `删除商家「${m.name}」？`,
            message: '删除后引用它的账单会清除商家信息，账单本身不受影响。',
            okText: '删除',
            danger: true,
          }).then(async (ok) => {
            if (!ok) return;
            await deleteMerchant(m.id!);
            closeSheet();
            showToast(`已删除商家「${m.name}」`);
          });
        }
      }, { signal: sheetSignal() });
    },
  });
}
