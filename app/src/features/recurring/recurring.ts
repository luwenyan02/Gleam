/**
 * 拾光 · 周期账（features/recurring，PRD 4.9）
 * 汇总卡（每月固定支出 + 启用数）+ 规则列表（启停开关、点行编辑）+
 * 新建/编辑规则抽屉（频率日/周/月/年、多入账日、入账时确认金额）。
 * 到期入账由 core/scheduler 补跑；amountConfirm 规则经 onPendingConfirm
 * 接到本模块，呈现「待确认」卡与确认抽屉（入账前可修改金额）。
 * 视觉结构与原型 index.html #page-cycle（L869-890）一致。
 */
import './recurring.css';
import { iconHtml } from '../../assets/icons';
import { esc } from '../../core/esc';
import { on } from '../../core/store';
import { formatFen, formatFenCny, parseYuanToFen } from '../../core/money';
import {
  addRule, updateRule, setRuleEnabled, deleteRule, listRules, ruleSummary, confirmPendingOccurrence,
  type NewRecurringRule, type PendingConfirm,
} from '../../core/repo/recurringRepo';
import { listAccounts } from '../../core/repo/accountRepo';
import { listExpenseTree } from '../../core/repo/categoryRepo';
import { onPendingConfirm } from '../../core/scheduler';
import { registerSubpage } from '../shell/router';
import { openSheet, closeSheet } from '../shell/sheet';
import { showToast } from '../shell/toast';
import { confirmDialog } from '../shell/dialog';
import type { Account, RecurringRule, RecurFreq } from '../../core/types';
import { openPickList, type PickListItem } from '../../shared/pickList';

/* ── 模块状态 ── */
let body: HTMLElement | undefined;
/** 并发刷新令牌 */
let refreshToken = 0;
/** 抽屉监听器控制（#sheet 为复用容器，重开前废止上一次绑定） */
let sheetAbort: AbortController | undefined;
/**
 * 待确认入账队列（amountConfirm 规则到期项）。
 * [M3 修复] 已持久化：scheduler 产生时写入 settings（'recurring.pendingConfirms'），
 * 入账后经 savePendingConfirms 回写移除，刷新页面启动时由 scheduler 回放。
 */
const pendingQueue: PendingConfirm[] = [];

function sheetSignal(): AbortSignal {
  sheetAbort?.abort();
  sheetAbort = new AbortController();
  return sheetAbort.signal;
}

const DOW = ['日', '一', '二', '三', '四', '五', '六'];
const FREQS: { value: RecurFreq; label: string }[] = [
  { value: 'daily', label: '每天' },
  { value: 'weekly', label: '每周' },
  { value: 'monthly', label: '每月' },
  { value: 'yearly', label: '每年' },
];

/** 频率与入账日的可读文案，如「每月5、20日」 */
function freqText(rule: Pick<RecurringRule, 'freq' | 'days'>): string {
  const days = rule.days;
  switch (rule.freq) {
    case 'daily': return '每天';
    case 'weekly': return `每周${(days.length ? days : [1]).map((d) => DOW[d] ?? '?').join('、')}`;
    case 'monthly': return `每月${(days.length ? days : [1]).join('、')}日`;
    case 'yearly': return `每年${(days.length ? days : [101]).map((v) => `${Math.floor(v / 100)}月${v % 100}日`).join('、')}`;
  }
}

/** 'M月D日' */
function mdText(ts: number): string {
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 元字符串（无千分位，供 input 初值） */
function yuanValue(fen: number): string {
  return formatFen(fen).replace(/,/g, '');
}

/* ── 页面渲染 ── */

async function refresh(): Promise<void> {
  const el = body;
  if (!el?.isConnected) return;
  const token = ++refreshToken;
  const [summary, rules, accounts, tree] = await Promise.all([
    ruleSummary(), listRules(), listAccounts(), listExpenseTree(),
  ]);
  if (token !== refreshToken || !el.isConnected) return;

  const acctName = new Map<number, string>(accounts.map((a) => [a.id, a.name]));
  const catIcon = new Map<number, string>();
  for (const g of tree) {
    catIcon.set(g.parent.id, g.parent.icon);
    for (const c of g.children) catIcon.set(c.id, c.icon);
  }

  /* 待确认卡（amountConfirm 规则到期，scheduler 分发） */
  const pendingHtml = pendingQueue.length ? `
    <section class="card" aria-label="待确认入账">
      <h3 class="card-title">待确认入账（${pendingQueue.length} 笔）</h3>
      <p class="sub" style="margin-bottom:12px">「入账时确认」的周期账已到期，请核对金额后入账</p>
      <button class="btn primary" data-act="pending">去确认</button>
    </section>` : '';

  /* 汇总卡 */
  const sumHtml = `
    <section class="card cycle-sum" aria-label="周期账汇总">
      <p class="label">每月固定支出</p>
      <p class="big num">${formatFenCny(summary.monthlyTotal)}</p>
      <p class="sub">${summary.enabledCount} 项已启用 · 到期自动入账并提醒，入账前可修改金额</p>
    </section>`;

  /* 规则列表 */
  const rowsHtml = rules.map((r) => {
    const meta = [
      freqText(r),
      esc(acctName.get(r.accountId) ?? '账户已删除'),
      r.enabled ? (r.amountConfirm ? `下次 ${mdText(r.nextRunAt)} 确认金额` : `下次 ${mdText(r.nextRunAt)}`) : '已暂停',
    ].join(' · ');
    return `
      <div class="row" data-id="${r.id}" role="button" tabindex="0">
        <span class="e-ic${r.enabled ? '' : ' neutral'}">${iconHtml(catIcon.get(r.categoryId) ?? 'ic-repeat')}</span>
        <div class="e-main">
          <p class="e-title">${esc(r.name)} <span class="e-sub">· ${r.amountConfirm ? '约 ' : ''}${formatFenCny(r.amount)}</span></p>
          <p class="e-meta">${meta}</p>
        </div>
        <button class="switch${r.enabled ? ' on' : ''}" data-toggle="${r.id}" role="switch" aria-checked="${r.enabled}" aria-label="${esc(r.name)}周期账开关"></button>
      </div>`;
  }).join('');
  const listHtml = rules.length ? `
    <section class="card list" aria-label="周期账列表">${rowsHtml}</section>
    <p class="tiny" style="text-align:center">周期账入账后会出现在首页流水，并计入报表与预算 · 点行编辑规则</p>` : `
    <section class="card" aria-label="周期账列表">
      <div class="rc-empty">
        <p class="sub">还没有周期账<br>房租、话费、会员这类固定支出，设一次就不用再记</p>
        <button class="btn primary" data-act="new">新建周期账</button>
      </div>
    </section>`;

  el.innerHTML = pendingHtml + sumHtml + listHtml;
}

/* ── 新建 / 编辑规则抽屉 ── */

async function openRuleForm(rule?: RecurringRule): Promise<void> {
  const [accounts, tree] = await Promise.all([listAccounts(false), listExpenseTree()]);
  if (!accounts.length) {
    showToast('请先在账户页添加一个账户');
    return;
  }
  /* 表单局部状态 */
  let freq: RecurFreq = rule?.freq ?? 'monthly';
  let amountConfirm = rule?.amountConfirm ?? false;
  const weeklyDays = new Set<number>(rule?.freq === 'weekly' ? rule.days : [1]);

  /* pickList 选项与闭包选中值 */
  const catItems: PickListItem[] = [];
  for (const g of tree) {
    catItems.push({ value: g.parent.id, label: `${g.parent.name}（大类）`, group: g.parent.name });
    for (const c of g.children) catItems.push({ value: c.id, label: c.name, group: g.parent.name });
  }
  const acctItems: PickListItem[] = accounts.map((a: Account) => ({ value: a.id, label: a.name }));
  let selectedCatId: number | undefined = rule?.categoryId ?? tree[0]?.children[0]?.id ?? tree[0]?.parent.id;
  let selectedAcctId: number | undefined = rule?.accountId ?? accounts[0]?.id;
  const catBtnLabel = (id?: number): string => {
    for (const g of tree) {
      if (g.parent.id === id) return `${g.parent.name}（大类）`;
      for (const c of g.children) if (c.id === id) return c.name;
    }
    return '请选择分类';
  };
  const acctBtnLabel = (id?: number): string => accounts.find((a) => a.id === id)?.name ?? '请选择账户';

  /** 入账日控件（随频率切换重绘） */
  const daysField = (): string => {
    switch (freq) {
      case 'daily':
        return '<p class="tiny" style="padding:2px 0 8px">每天 09:00 自动入账</p>';
      case 'weekly':
        return `
          <div class="field"><span>入账日</span><div class="chip-group" id="rc-dow">
            ${DOW.map((t, i) => `<button class="chip${weeklyDays.has(i) ? ' active' : ''}" type="button" data-dow="${i}">周${t}</button>`).join('')}
          </div></div>`;
      case 'monthly':
        return `
          <div class="field"><span>入账日</span><input class="note num" id="rc-dom" inputmode="numeric" style="max-width:170px;margin-bottom:0;text-align:right" placeholder="如 5,20（可多个）" value="${rule?.freq === 'monthly' ? rule.days.join(',') : ''}"></div>
          <p class="tiny" style="padding:0 0 8px">1-31，多个日期用逗号分隔；大于当月天数时顺延到月底</p>`;
      case 'yearly':
        return `
          <div class="field"><span>入账日</span><input class="note num" id="rc-mmdd" inputmode="numeric" style="max-width:170px;margin-bottom:0;text-align:right" placeholder="如 0101,0615" value="${rule?.freq === 'yearly' ? rule.days.map((v) => String(v).padStart(4, '0')).join(',') : ''}"></div>
          <p class="tiny" style="padding:0 0 8px">月日各两位（MMDD），多个用逗号分隔</p>`;
    }
  };

  openSheet({
    ariaLabel: rule ? '编辑周期账' : '新建周期账',
    onClose: () => sheetAbort?.abort(),
    render(el) {
      el.innerHTML = `
        <div class="sheet-head">
          <p class="sheet-title">${rule ? '编辑周期账' : '新建周期账'}</p>
          <button class="icon-btn" data-act="close" aria-label="关闭">${iconHtml('ic-close')}</button>
        </div>
        <div class="sheet-scroll">
          <div class="field"><span>名称</span><input class="note" id="rc-name" style="max-width:190px;margin-bottom:0;text-align:right" placeholder="如 房租" maxlength="20" value="${esc(rule?.name ?? '')}"></div>
          <div class="field"><span>金额（元）</span><input class="note num" id="rc-amount" inputmode="decimal" style="max-width:150px;margin-bottom:0;text-align:right" placeholder="0.00" value="${rule ? yuanValue(rule.amount) : ''}"></div>
          <div class="field"><span>入账时确认金额</span><button class="switch${amountConfirm ? ' on' : ''}" id="rc-confirm" role="switch" aria-checked="${amountConfirm}" aria-label="入账时确认金额"></button></div>
          <p class="tiny" style="padding:0 0 8px">适合水电燃气等按抄表出账的项目 · 到期不自动入账，提醒你核对金额后确认</p>
          <div class="field"><span>频率</span><div class="chip-group" id="rc-freq">
            ${FREQS.map((f) => `<button class="chip${freq === f.value ? ' active' : ''}" type="button" data-freq="${f.value}">${f.label}</button>`).join('')}
          </div></div>
          <div id="rc-days">${daysField()}</div>
          <div class="field"><span>分类</span><button class="pick-btn" id="rc-cat" aria-label="支出分类">${catBtnLabel(selectedCatId)}</button></div>
          <div class="field"><span>入账账户</span><button class="pick-btn" id="rc-acct" aria-label="入账账户">${acctBtnLabel(selectedAcctId)}</button></div>
          <button class="btn primary" data-act="save" style="margin-top:14px">${rule ? '保存修改' : '创建周期账'}</button>
          ${rule ? '<button class="btn ghost" data-act="del" style="margin-top:10px;color:var(--over)">删除此周期账</button>' : ''}
        </div>`;

      el.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        if (target.closest('#rc-confirm')) {
          amountConfirm = !amountConfirm;
          const sw = el.querySelector('#rc-confirm')!;
          sw.classList.toggle('on', amountConfirm);
          sw.setAttribute('aria-checked', String(amountConfirm));
          return;
        }
        if (target.closest('#rc-cat')) {
          openPickList({
            container: el,
            title: '选择分类',
            items: catItems,
            selected: selectedCatId,
            onPick(value, label) {
              selectedCatId = Number(value);
              el.querySelector('#rc-cat')!.textContent = label;
            },
          });
          return;
        }
        if (target.closest('#rc-acct')) {
          openPickList({
            container: el,
            title: '选择账户',
            items: acctItems,
            selected: selectedAcctId,
            onPick(value, label) {
              selectedAcctId = Number(value);
              el.querySelector('#rc-acct')!.textContent = label;
            },
          });
          return;
        }
        const freqBtn = target.closest<HTMLElement>('[data-freq]');
        if (freqBtn) {
          freq = freqBtn.dataset.freq as RecurFreq;
          el.querySelectorAll('[data-freq]').forEach((b) => b.classList.toggle('active', b === freqBtn));
          el.querySelector('#rc-days')!.innerHTML = daysField();
          return;
        }
        const dowBtn = target.closest<HTMLElement>('[data-dow]');
        if (dowBtn) {
          const d = Number(dowBtn.dataset.dow);
          if (weeklyDays.has(d)) weeklyDays.delete(d);
          else weeklyDays.add(d);
          dowBtn.classList.toggle('active', weeklyDays.has(d));
          return;
        }
        const act = target.closest<HTMLElement>('[data-act]')?.dataset.act;
        if (act === 'close') closeSheet();
        else if (act === 'save') void save();
        else if (act === 'del' && rule) void remove(rule);
      }, { signal: sheetSignal() });

      /** 解析入账日；非法时抛 Error（消息直接 toast 给用户） */
      function parseDays(): number[] {
        if (freq === 'daily') return [];
        if (freq === 'weekly') {
          if (!weeklyDays.size) throw new Error('每周至少选择一个入账日');
          return [...weeklyDays].sort((a, b) => a - b);
        }
        const raw = el.querySelector<HTMLInputElement>(freq === 'monthly' ? '#rc-dom' : '#rc-mmdd')!.value.trim();
        if (!raw) throw new Error('请填写入账日');
        const parts = raw.split(/[,，、\s]+/).filter(Boolean);
        const days = parts.map((p) => {
          const n = Number(p.replace(/-/g, ''));
          if (freq === 'monthly') {
            if (!Number.isInteger(n) || n < 1 || n > 31) throw new Error(`入账日「${p}」应为 1-31`);
            return n;
          }
          const mm = Math.floor(n / 100);
          const dd = n % 100;
          if (!Number.isInteger(n) || mm < 1 || mm > 12 || dd < 1 || dd > 31) throw new Error(`入账日「${p}」应为月日各两位，如 0615`);
          return n;
        });
        return [...new Set(days)].sort((a, b) => a - b);
      }

      async function save(): Promise<void> {
        try {
          const name = el.querySelector<HTMLInputElement>('#rc-name')!.value.trim();
          if (!name) throw new Error('请填写名称');
          const amount = parseYuanToFen(el.querySelector<HTMLInputElement>('#rc-amount')!.value.trim());
          if (amount <= 0) throw new Error('金额需大于 0');
          const days = parseDays();
          if (!selectedCatId) throw new Error('请选择分类');
          if (!selectedAcctId) throw new Error('请选择账户');
          const categoryId = selectedCatId;
          const accountId = selectedAcctId;
          const input: NewRecurringRule = { name, amount, amountConfirm, freq, days, categoryId, accountId, enabled: rule?.enabled ?? true };
          if (rule) await updateRule(rule.id, input);
          else await addRule(input);
          closeSheet();
          showToast(rule ? '周期账已更新' : `已创建 · ${freqText({ freq, days })}自动入账`);
          void refresh();
        } catch (err) {
          showToast(err instanceof Error ? err.message : String(err));
        }
      }

      async function remove(r: RecurringRule): Promise<void> {
        const ok = await confirmDialog({
          title: `删除「${r.name}」？`,
          message: '规则删除后不再入账，已入账的账单不受影响。',
          okText: '删除',
          danger: true,
        });
        if (!ok) return;
        await deleteRule(r.id);
        closeSheet();
        showToast('周期账已删除');
        void refresh();
      }
    },
  });
}

/* ── 待确认入账抽屉 ── */

async function openPendingSheet(): Promise<void> {
  if (!pendingQueue.length) return;
  const [accounts] = await Promise.all([listAccounts()]);
  const acctName = new Map<number, string>(accounts.map((a) => [a.id, a.name]));

  openSheet({
    ariaLabel: '待确认入账',
    onClose: () => sheetAbort?.abort(),
    render(el) {
      let booking = false;
      const draw = (): void => {
        el.innerHTML = `
          <div class="sheet-head">
            <p class="sheet-title">待确认入账（${pendingQueue.length} 笔）</p>
            <button class="icon-btn" data-act="close" aria-label="关闭">${iconHtml('ic-close')}</button>
          </div>
          <div class="sheet-scroll">
            <p class="tiny" style="padding:0 0 6px">核对金额后逐笔入账；点「关闭」可稍后再确认（刷新页面也不会丢失）</p>
            ${pendingQueue.map((p, i) => `
              <div class="field">
                <span>${esc(p.name)}<i class="rc-due">${mdText(p.dueAt)} 到期 · ${esc(acctName.get(p.accountId) ?? '账户已删除')}</i></span>
                <input class="note num" data-amt="${i}" inputmode="decimal" style="max-width:110px;margin-bottom:0;text-align:right" value="${yuanValue(p.amount)}" aria-label="${esc(p.name)}入账金额（元）">
                <button class="chip" data-book="${i}">入账</button>
              </div>`).join('')}
            <button class="btn primary" data-act="book-all" style="margin-top:14px">全部按上方金额入账</button>
          </div>`;
      };
      draw();

      const setBooking = (value: boolean): void => {
        booking = value;
        for (const button of el.querySelectorAll<HTMLButtonElement>('[data-book], [data-act="book-all"]')) {
          button.disabled = value;
        }
      };

      const runBooking = async (task: () => Promise<void>): Promise<void> => {
        if (booking) return;
        setBooking(true);
        try {
          await task();
        } finally {
          setBooking(false);
        }
      };

      /** 按队列下标入账一笔；金额取输入框当前值 */
      async function book(i: number): Promise<boolean> {
        const p = pendingQueue[i];
        try {
          const amount = parseYuanToFen(el.querySelector<HTMLInputElement>(`[data-amt="${i}"]`)!.value.trim());
          if (amount <= 0) throw new Error(`「${p.name}」金额需大于 0`);
          const result = await confirmPendingOccurrence(p.ruleId, p.dueAt, amount);
          pendingQueue.splice(0, pendingQueue.length, ...result.pending);
          return true;
        } catch (err) {
          showToast(err instanceof Error ? err.message : String(err));
          return false;
        }
      }

      const finishIfEmpty = (): void => {
        if (!pendingQueue.length) {
          closeSheet();
          showToast('待确认周期账已全部入账');
        } else {
          draw();
        }
        void refresh();
      };

      el.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const bookBtn = target.closest<HTMLElement>('[data-book]');
        if (bookBtn) {
          void runBooking(async () => {
            const ok = await book(Number(bookBtn.dataset.book));
            if (ok) finishIfEmpty();
          });
          return;
        }
        const act = target.closest<HTMLElement>('[data-act]')?.dataset.act;
        if (act === 'close') closeSheet();
        else if (act === 'book-all') {
          void runBooking(async () => {
            // 倒序入账，避免 splice 造成下标位移
            for (let i = pendingQueue.length - 1; i >= 0; i--) await book(i);
            finishIfEmpty();
          });
        }
      }, { signal: sheetSignal() });
    },
  });
}

/* ── 装配 ── */

/** 注册周期账子页（覆盖 shell 占位 sp-recurring），main.ts 调用一次 */
export function initRecurring(): void {
  registerSubpage('sp-recurring', {
    title: '周期账',
    render(el) {
      body = el;
      // 「+ 新建」挂到子页头部（router 只渲染返回与标题，与原型 L874 一致）
      const head = el.closest('.subpage')?.querySelector('.sub-head');
      if (head && !head.querySelector('[data-rc-add]')) {
        const btn = document.createElement('button');
        btn.className = 'icon-btn';
        btn.style.marginLeft = 'auto';
        btn.dataset.rcAdd = '';
        btn.setAttribute('aria-label', '新建周期账');
        btn.innerHTML = iconHtml('ic-plus');
        btn.addEventListener('click', () => void openRuleForm());
        head.appendChild(btn);
      }
      el.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const sw = target.closest<HTMLElement>('[data-toggle]');
        if (sw) {
          const enable = sw.getAttribute('aria-checked') !== 'true';
          void setRuleEnabled(Number(sw.dataset.toggle), enable).then(() => {
            showToast(enable ? '已启用，从下一期开始入账' : '已暂停，期间到期不入账');
            void refresh();
          });
          return;
        }
        if (target.closest('[data-act="new"]')) { void openRuleForm(); return; }
        if (target.closest('[data-act="pending"]')) { void openPendingSheet(); return; }
        const row = target.closest<HTMLElement>('[data-id]');
        if (row) {
          void listRules().then((rules) => {
            const rule = rules.find((r) => r.id === Number(row.dataset.id));
            if (rule) void openRuleForm(rule);
          });
        }
      });
      void refresh();
    },
    onShow() { void refresh(); },
  });

  // 待确认入账：scheduler 补跑分发（注册即回放启动时缓存的项，见 scheduler M2-C 修复）
  onPendingConfirm((items) => {
    pendingQueue.push(...items);
    showToast(`${items.length} 笔周期账待确认入账 · 到周期账页处理`);
    void refresh();
  });

  // 账户/分类改名影响列表展示；规则本身无独立事件，写操作后手动 refresh
  on('accounts-changed', () => void refresh());
  on('categories-changed', () => void refresh());
}
