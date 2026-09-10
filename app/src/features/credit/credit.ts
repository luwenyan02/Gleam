/**
 * 拾光 · 信用卡账单（features/credit）
 * 每张信用卡的每期账单：账单区间、银行核对的应还额、到期日、已还/剩余。
 * 还款通过真实转账流水关联（creditRepo），资金变化仍由账户流水计算；
 * 页面分别展示账户总欠款与本期应还，避免未出账消费与已出账欠款混淆。
 */
import { iconHtml } from '../../assets/icons';
import { esc } from '../../core/esc';
import { on } from '../../core/store';
import { formatFen, formatFenCny, parseYuanToFen } from '../../core/money';
import { listAccounts } from '../../core/repo/accountRepo';
import { listEntries } from '../../core/repo/entryRepo';
import {
  addCreditStatement, createAndLinkCreditPayment, deleteCreditStatement,
  getCreditStatementSummary, linkExistingCreditPayment, listCreditStatementSummaries,
  unlinkCreditPayment, updateCreditStatement, type CreditStatementSummary,
} from '../../core/repo/creditRepo';
import type { Account } from '../../core/types';
import { registerSubpage } from '../shell/router';
import { openSheet, closeSheet } from '../shell/sheet';
import { confirmDialog } from '../shell/dialog';
import { showToast } from '../shell/toast';
import { openDateWheel } from '../../shared/dateTimeWheel';

let body: HTMLElement | undefined;
let refreshToken = 0;
let sheetAbort: AbortController | undefined;

function sheetSignal(): AbortSignal {
  sheetAbort?.abort();
  sheetAbort = new AbortController();
  return sheetAbort.signal;
}

function dayLabel(ts: number): string {
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

function statusOf(summary: CreditStatementSummary, now: number): { label: string; cls: string } {
  if (summary.remaining <= 0) return { label: '已还清', cls: 'ok' };
  if (summary.statement.dueAt < now) return { label: '已逾期', cls: 'over' };
  return { label: '待还款', cls: 'warn' };
}

/** 到期提醒横幅：未还清且（已逾期或 3 天内到期）的账单 */
function reminderHtml(summaries: CreditStatementSummary[], cards: Map<number, Account>, now: number): string {
  const due = summaries.filter(s => s.remaining > 0 && s.statement.reminderEnabled !== false
    && (cards.get(s.statement.accountId)?.creditReminderEnabled !== false)
    && s.statement.dueAt <= now + 3 * 86400000);
  if (!due.length) return '';
  return `<section class="card" aria-label="还款提醒">${due.map(s => {
    const card = cards.get(s.statement.accountId);
    const late = s.statement.dueAt < now;
    return `<p class="sub" style="padding:4px 2px">${late ? '已逾期' : `${dayLabel(s.statement.dueAt)} 到期`} · ${esc(card?.name ?? '信用卡')} 剩余应还 <b class="num">${formatFenCny(s.remaining)}</b>${s.statement.reminderEnabled === false ? '' : ''}</p>`;
  }).join('')}</section>`;
}

async function refresh(): Promise<void> {
  const el = body;
  if (!el?.isConnected) return;
  const token = ++refreshToken;
  const accounts = (await listAccounts()).filter(a => a.group === 'credit');
  const perCard = await Promise.all(accounts.map(a => listCreditStatementSummaries(a.id!)));
  if (token !== refreshToken || !el.isConnected) return;
  const cards = new Map(accounts.map(a => [a.id!, a]));
  const now = Date.now();
  const all = perCard.flat();

  const sections = accounts.map((card, i) => {
    const summaries = perCard[i];
    const debt = Math.max(0, -card.balance);
    return `
      <section class="card" aria-label="${esc(card.name)}账单">
        <div class="cr-head">
          <div><p class="e-title">${esc(card.name)}</p>
          <p class="tiny">总欠款 <b class="num">${formatFenCny(debt)}</b>${card.billingDay ? ` · 账单日 ${card.billingDay} 号` : ''}${card.repayDay ? ` · 还款日 ${card.repayDay} 号` : ''}</p></div>
          <button class="btn ghost" data-act="add" data-card="${card.id}">记一期账单</button>
        </div>
        ${summaries.length ? summaries.map(s => statementHtml(s, now)).join('') : '<p class="sub" style="padding:6px 2px 10px">还没有账单 · 按银行账单记一期，之后可分次还款</p>'}
      </section>`;
  }).join('');

  el.innerHTML = accounts.length
    ? reminderHtml(all, cards, now) + sections
    : `<section class="card"><p class="sub" style="text-align:center;padding:18px 0">还没有信用卡账户<br>到「账户」页添加信用卡后，在这里管理每期账单</p></section>`;
}

function statementHtml(s: CreditStatementSummary, now: number): string {
  const st = statusOf(s, now);
  const payments = s.payments.filter(p => p.effectiveAmount > 0 || !p.entryDeleted);
  return `
    <div class="cr-stmt">
      <div class="cr-top">
        <span>${dayLabel(s.statement.periodStart)} – ${dayLabel(s.statement.periodEnd)}</span>
        <em class="cr-flag ${st.cls}">${st.label}</em>
      </div>
      <p class="cr-due">${dayLabel(s.statement.dueAt)} 到期 · 应还 <b class="num">${formatFenCny(s.amountDue)}</b></p>
      <div class="cr-meta"><span>已还 <b class="num">${formatFenCny(s.paid)}</b></span><span>剩余 <b class="num${s.remaining > 0 ? ' neg' : ''}">${formatFenCny(s.remaining)}</b></span></div>
      ${s.statement.note ? `<p class="tiny">${esc(s.statement.note)}</p>` : ''}
      ${payments.length ? `<ul class="cr-pays">${payments.map(p => `<li><span>${dayLabel(p.updatedAt)} 关联转账</span><b class="num">${formatFenCny(p.effectiveAmount)}</b>${p.entryDeleted ? '<em class="cr-flag over">流水已删</em>' : ''}<button class="restore-link" data-act="unlink" data-pay="${p.id}">解除</button></li>`).join('')}</ul>` : ''}
      <div class="cr-actions">
        ${s.remaining > 0 ? '<button class="btn primary" data-act="pay" data-stmt="' + s.statement.id + '">记还款</button>' : ''}
        <button class="btn ghost" data-act="link" data-stmt="${s.statement.id}">关联转账</button>
        <button class="btn ghost" data-act="edit" data-stmt="${s.statement.id}">编辑</button>
        <button class="btn ghost" data-act="del" data-stmt="${s.statement.id}">删除</button>
      </div>
    </div>`;
}

/** 记还款：默认金额为剩余应还，选择付款账户后生成转入信用卡的转账 */
function openPaySheet(summary: CreditStatementSummary, cards: Map<number, Account>): void {
  const card = cards.get(summary.statement.accountId);
  let fromId: number | undefined;
  let amount = summary.remaining;
  openSheet({
    ariaLabel: '记还款',
    onClose: () => sheetAbort?.abort(),
    render(el) {
      el.innerHTML = `
        <div class="sheet-head"><p class="sheet-title">记还款 · ${esc(card?.name ?? '')}</p><button class="icon-btn" data-act="close" aria-label="关闭">${iconHtml('ic-close')}</button></div>
        <div class="sheet-scroll">
          <p class="sub">剩余应还 <b class="num">${formatFenCny(summary.remaining)}</b> · 超出部分保留为未分配金额</p>
          <div class="field"><span>付款账户</span><select class="note" id="cr-from" aria-label="付款账户"></select></div>
          <div class="field"><span>还款金额</span><input class="note num" id="cr-amount" inputmode="decimal" value="${formatFen(amount).replace(/,/g, '')}"></div>
          <button class="btn primary" data-act="save">生成转账并关联</button>
          <p class="tiny" style="margin-top:10px">资金变化记为普通转账，不重复记支出</p>
        </div>`;
      void (async () => {
        const accounts = (await listAccounts()).filter(a => a.group !== 'credit' && a.group !== 'receivable' && !a.hidden);
        const select = el.querySelector<HTMLSelectElement>('#cr-from')!;
        select.innerHTML = accounts.map(a => `<option value="${a.id}">${esc(a.name)}</option>`).join('');
        fromId = accounts[0]?.id;
        select.onchange = () => { fromId = Number(select.value); };
      })();
      el.addEventListener('click', (e) => {
        const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
        if (act === 'close') closeSheet();
        if (act !== 'save') return;
        void (async () => {
          try {
            const fen = parseYuanToFen(el.querySelector<HTMLInputElement>('#cr-amount')!.value);
            if (fromId == null) { showToast('请选择付款账户'); return; }
            const result = await createAndLinkCreditPayment({ statementId: summary.statement.id!, fromAccountId: fromId, amount: fen, occurredAt: Date.now() });
            closeSheet();
            showToast(result.unallocatedAmount > 0
              ? `已还 ${formatFenCny(fen - result.unallocatedAmount)}，未分配 ${formatFenCny(result.unallocatedAmount)}`
              : '还款已关联本期账单');
            void refresh();
          } catch (err) { showToast(err instanceof Error ? err.message : String(err)); }
        })();
      }, { signal: sheetSignal() });
    },
  });
}

/** 关联已有转账：列出转入该卡且未关联的转账，逐笔选择分配金额 */
function openLinkSheet(summary: CreditStatementSummary, cards: Map<number, Account>): void {
  const card = cards.get(summary.statement.accountId);
  openSheet({
    ariaLabel: '关联转账',
    onClose: () => sheetAbort?.abort(),
    render(el) {
      el.innerHTML = '<p class="sub" style="padding:12px">加载中…</p>';
      void (async () => {
        const [entries, summaries] = await Promise.all([listEntries({}), listCreditStatementSummaries(summary.statement.accountId!)]);
        const linked = new Set(summaries.flatMap(s => s.payments.map(p => p.entryId)));
        const candidates = entries.filter(e => e.type === 'transfer' && e.toAccountId === summary.statement.accountId && e.deletedAt === 0 && !linked.has(e.id!));
        el.innerHTML = `
          <div class="sheet-head"><p class="sheet-title">关联转账 · ${esc(card?.name ?? '')}</p><button class="icon-btn" data-act="close" aria-label="关闭">${iconHtml('ic-close')}</button></div>
          <div class="sheet-scroll">
            ${candidates.length ? candidates.map(e => `<div class="field"><span>${dayLabel(e.occurredAt)} · ${formatFenCny(e.amount)}</span><button class="btn ghost" data-act="pick" data-entry="${e.id}" data-amt="${e.amount}">关联</button></div>`).join('') : '<p class="sub">没有可关联的转账 · 先在记账页记一笔转入该卡的转账</p>'}
            <p class="tiny" style="margin-top:8px">分配金额默认取流水金额与剩余应还的较小值</p>
          </div>`;
        el.addEventListener('click', (e) => {
          const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
          if (act === 'close') closeSheet();
          if (act !== 'pick') return;
          const button = (e.target as HTMLElement).closest<HTMLElement>('[data-entry]')!;
          const entryId = Number(button.dataset.entry);
          const entryAmount = Number(button.dataset.amt);
          void (async () => {
            try {
              await linkExistingCreditPayment({ statementId: summary.statement.id!, entryId, allocatedAmount: Math.min(entryAmount, summary.remaining) });
              closeSheet();
              showToast('已关联为本期还款');
              void refresh();
            } catch (err) { showToast(err instanceof Error ? err.message : String(err)); }
          })();
        }, { signal: sheetSignal() });
      })();
    },
  });
}

/** 新增或编辑账单：区间、到期日、应还额、备注与提醒开关 */
function openStatementSheet(card: Account, existing?: CreditStatementSummary): void {
  const now = new Date();
  const bill = card.billingDay ?? 1;
  const repay = card.repayDay ?? 10;
  const start = existing?.statement.periodStart ?? new Date(now.getFullYear(), now.getMonth() - 1, Math.min(bill, 28) + 1, 12).getTime();
  const end = existing?.statement.periodEnd ?? new Date(now.getFullYear(), now.getMonth(), Math.min(bill, 28), 12).getTime();
  const due = existing?.statement.dueAt ?? new Date(now.getFullYear(), now.getMonth(), Math.min(repay, 28), 12).getTime();
  let periodStart = start;
  let periodEnd = end;
  let dueAt = due;
  let reminder = existing?.statement.reminderEnabled ?? true;
  let saving = false;
  openSheet({
    ariaLabel: existing ? '编辑账单' : '记一期账单',
    onClose: () => sheetAbort?.abort(),
    render(el) {
      const day = (ts: number) => `${new Date(ts).getFullYear()}-${new Date(ts).getMonth() + 1}-${new Date(ts).getDate()}`;
      el.innerHTML = `
        <div class="sheet-head"><p class="sheet-title">${existing ? '编辑账单' : '记一期账单'} · ${esc(card.name)}</p><button class="icon-btn" data-act="close" aria-label="关闭">${iconHtml('ic-close')}</button></div>
        <div class="sheet-scroll">
          <div class="field"><span>账单开始</span><button class="note" data-act="start">${day(periodStart)}</button></div>
          <div class="field"><span>账单结束</span><button class="note" data-act="end">${day(periodEnd)}</button></div>
          <div class="field"><span>到期日</span><button class="note" data-act="due">${day(dueAt)}</button></div>
          <div class="field"><span>本期应还</span><input class="note num" id="cr-due-amt" inputmode="decimal" placeholder="按银行账单填写" value="${existing ? formatFen(existing.amountDue).replace(/,/g, '') : ''}"></div>
          <div class="field"><span>备注</span><input class="note" id="cr-note" value="${esc(existing?.statement.note ?? '')}"></div>
          <div class="field"><span>到期提醒</span><button class="switch${reminder ? ' on' : ''}" id="cr-rem" role="switch" aria-checked="${reminder}" aria-label="到期提醒"></button></div>
          <button class="btn primary" data-act="save">保存</button>
        </div>`;
      const paint = (): void => {
        el.querySelector<HTMLElement>('[data-act="start"]')!.textContent = day(periodStart);
        el.querySelector<HTMLElement>('[data-act="end"]')!.textContent = day(periodEnd);
        el.querySelector<HTMLElement>('[data-act="due"]')!.textContent = day(dueAt);
      };
      const pick = (which: 'start' | 'end' | 'due', initial: number): void => {
        const d = new Date(initial);
        const panel = openDateWheel({
          initial: { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() },
          onConfirm: r => {
            const next = new Date(r.year, r.month - 1, r.day, 12).getTime();
            if (which === 'start') periodStart = next;
            else if (which === 'end') periodEnd = next;
            else dueAt = next;
            paint();
          },
        });
        document.body.appendChild(panel);
      };
      el.addEventListener('click', (e) => {
        const target = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
        const act = target?.dataset.act;
        if (act === 'close') closeSheet();
        else if (act === 'start') pick('start', periodStart);
        else if (act === 'end') pick('end', periodEnd);
        else if (act === 'due') pick('due', dueAt);
        else if (target?.id === 'cr-rem') {
          reminder = !reminder;
          target.classList.toggle('on', reminder);
          target.setAttribute('aria-checked', String(reminder));
        } else if (act === 'save' && !saving) {
          saving = true;
          void (async () => {
            try {
              const amountDue = parseYuanToFen(el.querySelector<HTMLInputElement>('#cr-due-amt')!.value);
              const note = el.querySelector<HTMLInputElement>('#cr-note')!.value.trim() || undefined;
              if (existing) {
                await updateCreditStatement(existing.statement.id!, { periodStart, periodEnd, dueAt, amountDue, note, reminderEnabled: reminder });
              } else {
                await addCreditStatement({ accountId: card.id!, periodStart, periodEnd, dueAt, amountDue, note, reminderEnabled: reminder });
              }
              closeSheet();
              showToast('账单已保存');
              void refresh();
            } catch (err) { showToast(err instanceof Error ? err.message : String(err)); }
            finally { saving = false; }
          })();
        }
      }, { signal: sheetSignal() });
    },
  });
}

export function initCredit(): void {
  registerSubpage('sp-credit', {
    title: '信用卡账单',
    render(el) {
      body = el;
      el.addEventListener('click', (e) => {
        const target = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
        const act = target?.dataset.act;
        if (!act) return;
        void (async () => {
          const accounts = (await listAccounts()).filter(a => a.group === 'credit');
          const cards = new Map(accounts.map(a => [String(a.id), a]));
          if (act === 'add') {
            const card = cards.get(target!.dataset.card!);
            if (card) openStatementSheet(card);
            return;
          }
          const statementId = Number(target!.dataset.stmt);
          const summary = await getCreditStatementSummary(statementId);
          if (!summary) { showToast('账单不存在'); return; }
          const card = cards.get(String(summary.statement.accountId));
          if (act === 'pay') openPaySheet(summary, new Map(accounts.map(a => [a.id!, a])));
          else if (act === 'link') openLinkSheet(summary, new Map(accounts.map(a => [a.id!, a])));
          else if (act === 'edit' && card) openStatementSheet(card, summary);
          else if (act === 'del') {
            const ok = await confirmDialog({ title: '删除这期账单？', message: '还款关联一并解除，转账流水保留。', okText: '删除', danger: true });
            if (!ok) return;
            await deleteCreditStatement(statementId);
            showToast('账单已删除');
            void refresh();
          } else if (act === 'unlink') {
            const paymentId = Number(target!.dataset.pay);
            await unlinkCreditPayment(paymentId);
            showToast('已解除关联，转账流水保留');
            void refresh();
          }
        })();
      });
      void refresh();
    },
    onShow() { void refresh(); },
  });
  on('credit-changed', () => void refresh());
  on('accounts-changed', () => void refresh());
  on('entries-changed', () => void refresh());
}
