/**
 * 拾光 · 报销管理（features/reimburse，PRD 4.10）
 * 待报销合计卡 + 勾选列表 →「报销到账」选择到账账户（可登记不足额实收，一次结清）→
 * entryRepo.settleReimbursement 转入已报销并联动到账账户余额；
 * 统计口径开关写 settings 'reimburse.countAsIncome'（口径差异由 statsRepo 处理，UI 只消费）。
 * 视觉结构与原型 index.html #page-reimburse（L927-954）一致；金额只走 money.ts。
 */
import './reimburse.css';
import { iconHtml } from '../../assets/icons';
import { esc } from '../../core/esc';
import { displayEntryNote } from '../detail/entryRowText';
import { on } from '../../core/store';
import { formatFen, parseYuanToFen } from '../../core/money';
import { listEntries, settleReimbursement } from '../../core/repo/entryRepo';
import { listCategories, listExpenseTree } from '../../core/repo/categoryRepo';
import { listAccounts } from '../../core/repo/accountRepo';
import { getSetting, setSetting } from '../../core/repo/settingsRepo';
import { registerSubpage } from '../shell/router';
import { openSheet, closeSheet } from '../shell/sheet';
import { showToast } from '../shell/toast';
import { confirmDialog } from '../shell/dialog';
import type { Account, Entry } from '../../core/types';

/** 抽屉监听器控制：#sheet 为复用容器，重开前必须废止上一次绑定 */
let sheetAbort: AbortController | undefined;

function sheetSignal(): AbortSignal {
  sheetAbort?.abort();
  sheetAbort = new AbortController();
  return sheetAbort.signal;
}

function md(ts: number): string {
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 完整到账资料才可展示为现金流；历史导入的单一状态标记不补造金额、账户或日期。 */
function hasReceipt(entry: Entry): boolean {
  return entry.reimbursedAmount != null
    && entry.reimbursedAt != null
    && entry.reimburseAccountId != null;
}

export function reimbursementDetailText(entry: Entry): string {
  if (entry.reimburseStatus === 'pending') return '待报销';
  if (entry.reimburseStatus !== 'done') return '非报销';
  if (!hasReceipt(entry)) return '已报销（到账资料缺失）';
  const received = entry.reimbursedAmount!;
  const difference = entry.amount - received;
  return difference > 0
    ? `已报销 · 实收 ¥${formatFen(received)} · 差额 ¥${formatFen(difference)}（一次结清）`
    : `已报销 ¥${formatFen(received)}`;
}

export interface ReimbursementRecordPresentation {
  meta: string;
  amountText: string;
  amountClass: '' | 'in';
}

export function reimbursementRecordPresentation(entry: Entry, accountName?: string): ReimbursementRecordPresentation {
  if (!hasReceipt(entry)) {
    return {
      meta: `${md(entry.occurredAt)} · 历史标记为已报销 · 到账资料缺失`,
      amountText: '资料缺失',
      amountClass: '',
    };
  }
  const received = entry.reimbursedAmount!;
  const difference = entry.amount - received;
  const settlement = difference > 0
    ? ` · 一次结清，实收 ¥${formatFen(received)}，差额 ¥${formatFen(difference)}`
    : '';
  return {
    meta: `${md(entry.occurredAt)} · ${md(entry.reimbursedAt!)}报销到账 → ${accountName ?? '账户'}${settlement}`,
    amountText: `+¥${formatFen(received)}`,
    amountClass: 'in',
  };
}

/** 分类 id → 名称（支出树 + 收入平铺） */
async function catNameMap(): Promise<Map<number, string>> {
  const [tree, income] = await Promise.all([listExpenseTree(), listCategories('income')]);
  const map = new Map<number, string>();
  for (const g of tree) {
    map.set(g.parent.id, g.parent.name);
    for (const c of g.children) map.set(c.id, c.name);
  }
  for (const c of income) map.set(c.id, c.name);
  return map;
}

/** 待报销行标题：备注优先展示（原型「打车 · 滴滴」语义），无备注展示分类名 */
function rowTitle(e: Entry, cats: Map<number, string>): string {
  const cat = cats.get(e.categoryId ?? -1) ?? '未分类';
  const note = displayEntryNote(e.note);
  return note ? `${esc(cat)} · ${esc(note)}` : esc(cat);
}

/** 注册报销管理子页（覆盖 sp-reimburse 占位），main.ts 调用一次 */
export function initReimburse(): void {
  registerSubpage('sp-reimburse', {
    title: '报销管理',
    render(el) {
      const selected = new Set<number>();

      el.innerHTML = `
        <section class="card backup-status" aria-label="待报销合计">
          <span class="bs-ic">${iconHtml('ic-file')}</span>
          <p class="big num" id="rb-sum">¥0.00</p>
          <p class="sub" id="rb-sub"></p>
        </section>
        <section class="card list" aria-label="待报销账单">
          <h3 class="card-title" style="padding:10px 2px 0">待报销 · 点击勾选</h3>
          <div id="rb-list"></div>
          <div class="field" style="border-top:1px solid var(--border)"><span id="rb-selinfo">已选 0 笔 · ¥0.00</span><button class="restore-link" id="rb-go">报销到账</button></div>
        </section>
        <section class="card" aria-label="报销统计口径">
          <div class="field"><span>报销款计入收入统计</span><button class="switch" id="rb-mode" role="switch" aria-checked="false" aria-label="报销款计入收入统计"></button></div>
          <p class="rb-mode-summary" id="rb-mode-summary"></p>
          <details class="rb-details"><summary>到账与差额说明</summary><p>每笔确认后一次结清；实收不足原金额时，差额继续计入支出，不再列为待报销。</p></details>
        </section>
        <section class="card list" aria-label="已报销记录">
          <h3 class="card-title" style="padding:10px 2px 0">已报销</h3>
          <div id="rb-done"></div>
        </section>`;

      let pending: Entry[] = [];

      async function refresh(): Promise<void> {
        if (!el.isConnected) return;
        const [pend, done, cats, accounts, countIn] = await Promise.all([
          listEntries({ type: 'expense', reimburseStatus: 'pending' }),
          listEntries({ type: 'expense', reimburseStatus: 'done', limit: 50 }),
          catNameMap(),
          listAccounts(),
          getSetting('reimburse.countAsIncome'),
        ]);
        if (!el.isConnected) return;
        pending = pend;
        for (const id of [...selected]) if (!pend.some((e) => e.id === id)) selected.delete(id);
        const acctMap = new Map<number, Account>(accounts.map((a) => [a.id, a]));

        const total = pend.reduce((s, e) => s + e.amount, 0);
        el.querySelector('#rb-sum')!.textContent = `¥${formatFen(total)}`;
        el.querySelector('#rb-sub')!.textContent = pend.length
          ? `${pend.length} 笔待报销`
          : '暂无待报销';

        el.querySelector('#rb-list')!.innerHTML = pend.length ? pend.map((e) => `
          <div class="row" data-id="${e.id}" role="button" tabindex="0">
            <span class="ck${selected.has(e.id) ? ' on' : ''}" aria-hidden="true"></span>
            <div class="e-main"><p class="e-title">${rowTitle(e, cats)}</p><p class="e-meta">${md(e.occurredAt)} · ${esc(cats.get(e.categoryId ?? -1) ?? '未分类')} · ${esc(acctMap.get(e.accountId ?? -1)?.name ?? '账户')}</p></div>
            <p class="e-amt num">¥${formatFen(e.amount)}</p>
          </div>`).join('')
          : '<p class="sub" style="padding:12px 2px">记账时勾选「报销」，账单会显示在这里。</p>';
        updateSelInfo();

        const sw = el.querySelector<HTMLElement>('#rb-mode')!;
        sw.classList.toggle('on', countIn);
        sw.setAttribute('aria-checked', String(countIn));
        el.querySelector('#rb-mode-summary')!.textContent = countIn ? '到账计入「报销」收入。' : '到账冲抵原支出，不计入收入。';

        // 已报销按报销日期倒序；缺少到账资料的历史状态标记不能展示为到账。
        const doneSorted = [...done].sort((a, b) => (b.reimbursedAt ?? 0) - (a.reimbursedAt ?? 0));
        el.querySelector('#rb-done')!.innerHTML = doneSorted.length ? doneSorted.map((e) => {
          const presentation = reimbursementRecordPresentation(
            e,
            acctMap.get(e.reimburseAccountId ?? -1)?.name,
          );
          return `
          <div class="row">
            <span class="e-ic neutral">${iconHtml('ic-file', 18)}</span>
            <div class="e-main"><p class="e-title">${rowTitle(e, cats)}</p><p class="e-meta">${esc(presentation.meta)}</p></div>
            <p class="e-amt num ${presentation.amountClass}">${presentation.amountText}</p>
          </div>`;
        }).join('') : '<p class="sub" style="padding:12px 2px">还没有已报销记录</p>';
      }

      function updateSelInfo(): void {
        const sum = pending.filter((e) => selected.has(e.id)).reduce((s, e) => s + e.amount, 0);
        el.querySelector('#rb-selinfo')!.textContent = `已选 ${selected.size} 笔 · ¥${formatFen(sum)}`;
      }

      el.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const row = target.closest<HTMLElement>('#rb-list .row[data-id]');
        if (row) {
          const id = Number(row.dataset.id);
          if (selected.has(id)) selected.delete(id);
          else selected.add(id);
          row.querySelector('.ck')!.classList.toggle('on', selected.has(id));
          updateSelInfo();
          return;
        }
        if (target.closest('#rb-go')) {
          const picked = pending.filter((en) => selected.has(en.id));
          if (!picked.length) { showToast('先勾选要报销的账单'); return; }
          openSettleSheet(picked, () => selected.clear());
          return;
        }
        if (target.closest('#rb-mode')) {
          void getSetting('reimburse.countAsIncome').then(async (cur) => {
            await setSetting('reimburse.countAsIncome', !cur);
            showToast(!cur ? '已开启：报销到账将记为一笔「报销」收入' : '已关闭：报销到账只冲抵原支出，不进收入统计');
          });
        }
      });

      // 数据变化时刷新；子页关闭（DOM 销毁）后自动退订
      for (const ev of ['entries-changed', 'settings-changed', 'accounts-changed'] as const) {
        const off = on(ev, () => {
          if (!el.isConnected) { off(); return; }
          void refresh();
        });
      }
      void refresh();
    },
  });
}

/* ── 报销到账抽屉 ─────────────────── */

/** 选择到账账户 + 每笔实收金额；确认后每笔均一次结清。 */
async function openSettleSheet(picked: Entry[], onDone: () => void): Promise<void> {
  const [accounts, cats, countIn] = await Promise.all([
    listAccounts(), catNameMap(), getSetting('reimburse.countAsIncome'),
  ]);
  const visible = accounts.filter((a) => !a.hidden);
  if (!visible.length) { showToast('请先添加一个到账账户'); return; }
  let acctId = visible[0].id;

  openSheet({
    ariaLabel: '报销到账',
    onClose: () => sheetAbort?.abort(),
    render(el) {
      el.innerHTML = `
        <div class="rb-sheet-head">
          <p class="sheet-title">报销到账<span class="tiny" style="margin-left:8px">${picked.length} 笔</span></p>
          <button class="icon-btn" data-act="close" aria-label="关闭">${iconHtml('ic-close')}</button>
        </div>
        <div class="sheet-scroll">
          <div class="field"><span>到账账户</span>
            <div class="chip-group" id="rb-acct">
              ${visible.map((a) => `<button class="chip${a.id === acctId ? ' active' : ''}" data-acct="${a.id}">${esc(a.name)}</button>`).join('')}
            </div>
          </div>
          <p class="rb-mode-summary">按实收填写，确认后一次结清；差额计入支出，不再待报销。</p>
          ${picked.map((e) => `
            <div class="rb-amt-row">
              <div class="e-main"><p class="e-title">${rowTitle(e, cats)}</p><p class="e-meta">${md(e.occurredAt)} · 原金额 ¥${formatFen(e.amount)}</p></div>
              <input class="note num" data-amt="${e.id}" inputmode="decimal" value="${formatFen(e.amount).replace(/,/g, '')}">
            </div>`).join('')}
          <button class="btn primary" data-act="settle" style="margin-top:14px">确认一次结清</button>
          <p class="tiny" style="text-align:center;margin-top:10px">${countIn ? '当前口径：到账记为一笔「报销」收入，计入收入统计' : '当前口径：到账只冲抵原支出，不计入收入统计'}</p>
        </div>`;

      el.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const chip = target.closest<HTMLElement>('[data-acct]');
        if (chip) {
          acctId = Number(chip.dataset.acct);
          for (const c of el.querySelectorAll<HTMLElement>('[data-acct]')) c.classList.toggle('active', c === chip);
          return;
        }
        const act = target.closest<HTMLElement>('[data-act]')?.dataset.act;
        if (act === 'close') closeSheet();
        else if (act === 'settle') void settle();
      }, { signal: sheetSignal() });

      async function settle(): Promise<void> {
        const amountById = new Map<number, number>();
        try {
          for (const e of picked) {
            const raw = el.querySelector<HTMLInputElement>(`[data-amt="${e.id}"]`)!.value;
            const fen = parseYuanToFen(raw);
            if (fen <= 0) throw new Error('到账金额须大于 0');
            if (fen > e.amount) throw new Error(`到账金额不能超过原金额 ¥${formatFen(e.amount)}`);
            amountById.set(e.id, fen);
          }
        } catch (err) {
          showToast(err instanceof Error ? err.message : String(err));
          return;
        }
        const sum = [...amountById.values()].reduce((s, v) => s + v, 0);
        const shortfalls = picked.flatMap((entry) => {
          const received = amountById.get(entry.id)!;
          return received < entry.amount ? [entry.amount - received] : [];
        });
        if (shortfalls.length) {
          const difference = shortfalls.reduce((sum, value) => sum + value, 0);
          const confirmed = await confirmDialog({
            title: '确认不足额一次结清',
            message: `本次实收 ¥${formatFen(sum)}，差额 ¥${formatFen(difference)}。确认后所选账单将结清，差额不再进入待报销。`,
            okText: '确认结清',
          });
          if (!confirmed) return;
        }
        await settleReimbursement(picked.map((e) => e.id), acctId, amountById);
        onDone();
        closeSheet();
        showToast(countIn
          ? `报销到账 ¥${formatFen(sum)}：已记为一笔「报销」收入`
          : `报销到账 ¥${formatFen(sum)}：已冲抵原支出，不计入收入统计`);
      }
    },
  });
}
