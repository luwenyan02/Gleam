/**
 * 拾光 · 借贷往来（features/loan，PRD 4.7）
 * 借贷对象（往来人）列表：余额正 = TA 欠你（绿）、负 = 你欠 TA（红）；
 * 对象详情抽屉：余额 hero + 改名/删除 + 往来流水（点账单可编辑）。
 * 余额由借贷账单经 entryRepo 自动增减，本模块只读展示；
 * 新子页 id 'sp-loan'（原型无此页，视觉沿用通用卡片语言），入口在我的页。
 */
import './loan.css';
import { iconHtml } from '../../assets/icons';
import { esc } from '../../core/esc';
import { on } from '../../core/store';
import { formatFen, formatFenCny } from '../../core/money';
import {
  listLoanContacts, getLoanContact, ensureLoanContact, renameLoanContact, deleteLoanContact, listContactEntries,
} from '../../core/repo/loanRepo';
import { openEntryDetail } from '../detail/detail';
import { registerSubpage } from '../shell/router';
import { openSheet, closeSheet } from '../shell/sheet';
import { showToast } from '../shell/toast';
import { confirmDialog } from '../shell/dialog';
import type { Entry, LoanContact, LoanKind } from '../../core/types';

/* ── 模块状态 ── */
let body: HTMLElement | undefined;
/** 并发刷新令牌 */
let refreshToken = 0;
/** 抽屉监听器控制（#sheet 为复用容器，重开前废止上一次绑定） */
let sheetAbort: AbortController | undefined;

function sheetSignal(): AbortSignal {
  sheetAbort?.abort();
  sheetAbort = new AbortController();
  return sheetAbort.signal;
}

/** 借贷方向文案与图标（方向语义与 entryRepo.contactEffect 一致） */
const KIND_META: Record<LoanKind, { label: string; icon: string; /** 对「TA 欠你」余额的影响方向 */ dir: 1 | -1 }> = {
  lend: { label: '借出', icon: 'ic-loan-out', dir: 1 },
  repay: { label: '还款', icon: 'ic-repay', dir: 1 },
  borrow: { label: '借入', icon: 'ic-loan-in', dir: -1 },
  collect: { label: '收款', icon: 'ic-collect', dir: -1 },
};

/** 余额语义文案：正 = TA 欠你 */
function balanceText(c: LoanContact): string {
  if (c.balance > 0) return `<span class="acct-amt lo-bal pos num">TA 欠我 ${formatFenCny(c.balance)}</span>`;
  if (c.balance < 0) return `<span class="acct-amt lo-bal neg num">我欠 TA ${formatFenCny(-c.balance)}</span>`;
  return '<span class="acct-amt num" style="color:var(--faint)">已结清</span>';
}

function mdText(ts: number): string {
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/* ── 页面渲染 ── */

async function refresh(): Promise<void> {
  const el = body;
  if (!el?.isConnected) return;
  const token = ++refreshToken;
  const contacts = await listLoanContacts();
  if (token !== refreshToken || !el.isConnected) return;

  const owedToMe = contacts.reduce((s, c) => s + Math.max(0, c.balance), 0);
  const iOwe = contacts.reduce((s, c) => s + Math.max(0, -c.balance), 0);

  const sumHtml = `
    <section class="card lo-sum" aria-label="借贷总览">
      <div><p class="label">别人欠我</p><p class="big in num">${formatFenCny(owedToMe)}</p><p class="tiny">待收合计</p></div>
      <div><p class="label">我欠别人</p><p class="big out num">${formatFenCny(iOwe)}</p><p class="tiny">待还合计</p></div>
    </section>`;

  const rowsHtml = contacts.map((c) => `
    <div class="row" data-id="${c.id}" role="button" tabindex="0">
      <span class="e-ic${c.balance === 0 ? ' neutral' : ''}">${iconHtml('ic-user')}</span>
      <div class="e-main"><p class="e-title">${esc(c.name)}</p></div>
      ${balanceText(c)}
    </div>`).join('');
  const listHtml = contacts.length ? `
    <section class="card list" aria-label="借贷对象列表">${rowsHtml}</section>
    <p class="tiny" style="text-align:center">余额随借入/借出/还款/收款账单自动更新 · 点对象查看往来流水</p>` : `
    <section class="card" aria-label="借贷对象列表">
      <div class="lo-empty">
        <p class="sub">还没有借贷往来对象<br>记一笔借入/借出时选择对象，余额会自动记在这里</p>
        <button class="btn primary" data-act="new">新建往来对象</button>
      </div>
    </section>`;

  el.innerHTML = sumHtml + listHtml;
}

/* ── 新建 / 改名抽屉 ── */

function openNameSheet(contact?: LoanContact): void {
  openSheet({
    ariaLabel: contact ? '修改对象名称' : '新建往来对象',
    onClose: () => sheetAbort?.abort(),
    render(el) {
      el.innerHTML = `
        <div class="sheet-head">
          <p class="sheet-title">${contact ? '修改对象名称' : '新建往来对象'}</p>
          <button class="icon-btn" data-act="close" aria-label="关闭">${iconHtml('ic-close')}</button>
        </div>
        <div class="sheet-scroll">
          <input class="note" id="lo-name" placeholder="如 小林、房东王姐" maxlength="20" value="${esc(contact?.name ?? '')}">
          <button class="btn primary" data-act="save">${contact ? '保存' : '创建'}</button>
          ${contact ? '' : '<p class="tiny" style="text-align:center;margin-top:10px">创建后在「记一笔 · 借贷」中选择该对象即可记账</p>'}
        </div>`;
      el.querySelector<HTMLInputElement>('#lo-name')!.focus();

      el.addEventListener('click', (e) => {
        const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
        if (act === 'close') closeSheet();
        else if (act === 'save') void save();
      }, { signal: sheetSignal() });

      async function save(): Promise<void> {
        try {
          const name = el.querySelector<HTMLInputElement>('#lo-name')!.value.trim();
          if (!name) throw new Error('请填写对象名称');
          if (contact) {
            await renameLoanContact(contact.id, name);
            showToast('名称已更新');
          } else {
            await ensureLoanContact(name);
            showToast(`已创建「${name}」`);
          }
          closeSheet();
          void refresh();
        } catch (err) {
          showToast(err instanceof Error ? err.message : String(err));
        }
      }
    },
  });
}

/* ── 对象详情抽屉 ── */

async function openContactSheet(id: number): Promise<void> {
  const [contact, entries] = await Promise.all([getLoanContact(id), listContactEntries(id)]);
  if (!contact) return;

  const heroCls = contact.balance > 0 ? 'lo-bal pos' : contact.balance < 0 ? 'lo-bal neg' : '';
  const heroLabel = contact.balance > 0 ? 'TA 欠我' : contact.balance < 0 ? '我欠 TA' : '已结清';
  const flowsHtml = entries.map((e: Entry) => {
    const meta = KIND_META[e.loanKind ?? 'lend'];
    const sign = meta.dir > 0 ? '+' : '-';
    return `
      <div class="row" data-entry="${e.id}" role="button" tabindex="0">
        <span class="e-ic">${iconHtml(meta.icon)}</span>
        <div class="e-main">
          <p class="e-title">${meta.label}${e.note ? ` <span class="e-sub">· ${esc(e.note)}</span>` : ''}</p>
          <p class="e-meta">${mdText(e.occurredAt)}</p>
        </div>
        <span class="e-amt ${meta.dir > 0 ? 'in' : 'out'} num">${sign}¥${formatFen(e.amount)}</span>
      </div>`;
  }).join('');

  openSheet({
    ariaLabel: `${contact.name} 借贷详情`,
    onClose: () => sheetAbort?.abort(),
    render(el) {
      el.innerHTML = `
        <div class="sheet-head">
          <p class="sheet-title">${esc(contact.name)}</p>
          <button class="icon-btn" data-act="close" aria-label="关闭">${iconHtml('ic-close')}</button>
        </div>
        <div class="sheet-scroll">
          <div class="lo-hero">
            <p class="label">${heroLabel}</p>
            <p class="big num ${heroCls}">${formatFenCny(Math.abs(contact.balance))}</p>
          </div>
          <div class="lo-acts">
            <button class="chip" data-act="rename">${iconHtml('ic-pen', 14)}改名</button>
            <button class="chip danger" data-act="del">${iconHtml('ic-trash', 14)}删除对象</button>
          </div>
          <h3 class="card-title" style="margin-top:6px">往来流水（${entries.length} 笔）</h3>
          ${flowsHtml || '<p class="sub" style="padding:4px 0 10px">还没有往来账单 · 在「记一笔 · 借贷」中选择该对象即可记账</p>'}
          <p class="tiny" style="margin-top:10px">点一笔往来可修改金额或日期 · 余额方向：借出/还款让 TA 欠我增加</p>
        </div>`;

      el.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const entryRow = target.closest<HTMLElement>('[data-entry]');
        if (entryRow) {
          closeSheet();
          openEntryDetail(Number(entryRow.dataset.entry));
          return;
        }
        const act = target.closest<HTMLElement>('[data-act]')?.dataset.act;
        if (act === 'close') closeSheet();
        else if (act === 'rename') { closeSheet(); openNameSheet(contact); }
        else if (act === 'del') void remove();
      }, { signal: sheetSignal() });

      async function remove(): Promise<void> {
        const ok = await confirmDialog({
          title: `删除「${contact!.name}」？`,
          message: contact!.balance !== 0
            ? `该对象尚未结清（${heroLabel} ${formatFenCny(Math.abs(contact!.balance))}），且有关联账单时无法删除。`
            : '删除后不可恢复；有关联借贷账单时须先处理账单。',
          okText: '删除',
          danger: true,
        });
        if (!ok) return;
        try {
          await deleteLoanContact(contact!.id);
          closeSheet();
          showToast('对象已删除');
          void refresh();
        } catch (err) {
          showToast(err instanceof Error ? err.message : String(err));
        }
      }
    },
  });
}

/* ── 装配 ── */

/** 注册借贷往来子页（新 id sp-loan，入口在我的页），main.ts 调用一次 */
export function initLoan(): void {
  registerSubpage('sp-loan', {
    title: '借贷往来',
    render(el) {
      body = el;
      // 「+ 新建对象」挂到子页头部（router 只渲染返回与标题）
      const head = el.closest('.subpage')?.querySelector('.sub-head');
      if (head && !head.querySelector('[data-lo-add]')) {
        const btn = document.createElement('button');
        btn.className = 'icon-btn';
        btn.style.marginLeft = 'auto';
        btn.dataset.loAdd = '';
        btn.setAttribute('aria-label', '新建往来对象');
        btn.innerHTML = iconHtml('ic-plus');
        btn.addEventListener('click', () => openNameSheet());
        head.appendChild(btn);
      }
      el.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        if (target.closest('[data-act="new"]')) { openNameSheet(); return; }
        const row = target.closest<HTMLElement>('[data-id]');
        if (row) void openContactSheet(Number(row.dataset.id));
      });
      void refresh();
    },
    onShow() { void refresh(); },
  });

  // 借贷账单与对象增删改名均 emit 'entries-changed'（loanRepo/entryRepo 约定）
  on('entries-changed', () => void refresh());
}
