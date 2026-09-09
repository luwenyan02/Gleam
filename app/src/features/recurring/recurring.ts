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
  recurringRuleType, skipNextOccurrence,
  type NewRecurringRule, type PendingConfirm,
} from '../../core/repo/recurringRepo';
import { listAccounts } from '../../core/repo/accountRepo';
import { listCategories, listExpenseTree } from '../../core/repo/categoryRepo';
import { onPendingConfirm } from '../../core/scheduler';
import { registerSubpage } from '../shell/router';
import { openSheet, closeSheet } from '../shell/sheet';
import { showToast } from '../shell/toast';
import { confirmDialog } from '../shell/dialog';
import type { Account, CategoryKind, RecurringRule, RecurFreq } from '../../core/types';
import { openPickList, type PickListItem } from '../../shared/pickList';
import { openDateWheel } from '../../shared/dateTimeWheel';

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
function dateLabel(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

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
  const [summary, rules, accounts, tree, incomeCategories] = await Promise.all([
    ruleSummary(), listRules(), listAccounts(), listExpenseTree(), listCategories('income'),
  ]);
  if (token !== refreshToken || !el.isConnected) return;

  const acctName = new Map<number, string>(accounts.map((a) => [a.id, a.name]));
  const catIcon = new Map<number, string>();
  for (const g of tree) {
    catIcon.set(g.parent.id, g.parent.icon);
    for (const c of g.children) catIcon.set(c.id, c.icon);
  }
  for (const category of incomeCategories) catIcon.set(category.id, category.icon);

  /* 待确认卡（amountConfirm 规则到期，scheduler 分发） */
  const pendingHtml = pendingQueue.length ? `
    <section class="card" aria-label="待确认入账">
      <h3 class="card-title">待确认入账（${pendingQueue.length} 笔）</h3>
      <p class="sub" style="margin-bottom:12px">到期后核对金额再入账</p>
      <button class="btn primary" data-act="pending">去确认</button>
    </section>` : '';

  /* 汇总卡 */
  const sumHtml = `
    <section class="card cycle-sum" aria-label="周期账汇总">
      <div class="rc-sum-grid">
        <div><p class="label">每月固定支出</p><p class="big num expense">${formatFenCny(summary.monthlyTotal)}</p></div>
        <div><p class="label">每月固定收入</p><p class="big num income">${formatFenCny(summary.monthlyIncomeTotal)}</p></div>
      </div>
      <p class="sub">${summary.enabledCount} 项已启用 · 到期自动处理或提醒确认</p>
    </section>`;

  /* 规则列表 */
  const rowsHtml = rules.map((r) => {
    const type = recurringRuleType(r);
    const meta = [
      type === 'income' ? '收入' : '支出',
      freqText(r),
      esc(acctName.get(r.accountId) ?? '账户已删除'),
      r.enabled ? (r.amountConfirm ? `下次 ${mdText(r.nextRunAt)} 确认金额` : `下次 ${mdText(r.nextRunAt)}`) : '已暂停',
      (r.interval ?? 1) > 1 ? `每${r.interval}${r.freq === 'weekly' ? '周' : r.freq === 'monthly' ? '月' : r.freq === 'yearly' ? '年' : '天'}` : '',
      r.endDate ? `${dateLabel(r.endDate)} 止` : '',
      r.transferToAccountId ? `转账到 ${esc(acctName.get(r.transferToAccountId) ?? '账户已删除')}` : '',
    ].filter(Boolean).join(' · ');
    return `
      <div class="row" data-id="${r.id}" role="button" tabindex="0">
        <span class="e-ic${r.enabled ? '' : ' neutral'}">${iconHtml(catIcon.get(r.categoryId) ?? 'ic-repeat')}</span>
        <div class="e-main">
          <p class="e-title">${esc(r.name)} <span class="e-sub rc-amount ${type}">· ${r.amountConfirm ? '约 ' : ''}${type === 'income' ? '+' : '−'}${formatFenCny(r.amount)}</span></p>
          <p class="e-meta">${meta}</p>
        </div>
        <button class="chip" data-skip="${r.id}" aria-label="跳过${esc(r.name)}本期">跳过本期</button>
        <button class="switch${r.enabled ? ' on' : ''}" data-toggle="${r.id}" role="switch" aria-checked="${r.enabled}" aria-label="${esc(r.name)}周期账开关"></button>
      </div>`;
  }).join('');
  const listHtml = rules.length ? `
    <section class="card list" aria-label="周期账列表">${rowsHtml}</section>
    <p class="tiny" style="text-align:center">入账后进入首页流水与对应收支统计 · 点行编辑</p>` : `
    <section class="card" aria-label="周期账列表">
      <div class="rc-empty">
        <p class="sub">还没有周期账<br>工资、房租等固定收支，设置后按期入账</p>
        <button class="btn primary" data-act="new">新建周期账</button>
      </div>
    </section>`;

  el.innerHTML = pendingHtml + sumHtml + listHtml;
}

/* ── 新建 / 编辑规则抽屉 ── */

async function openRuleForm(rule?: RecurringRule): Promise<void> {
  const [accounts, tree, incomeCategories] = await Promise.all([
    listAccounts(false), listExpenseTree(), listCategories('income'),
  ]);
  if (!accounts.length) {
    showToast('请先在账户页添加一个账户');
    return;
  }
  /* 表单局部状态 */
  let type: CategoryKind = recurringRuleType({ type: rule?.type });
  let freq: RecurFreq = rule?.freq ?? 'monthly';
  let amountConfirm = rule?.amountConfirm ?? false;
  let interval = Math.max(1, rule?.interval ?? 1);
  let startDate: number | undefined = rule?.startDate;
  let endDate: number | undefined = rule?.endDate;
  let transferToAccountId: number | undefined = rule?.transferToAccountId;
  const weeklyDays = new Set<number>(rule?.freq === 'weekly' ? rule.days : [1]);

  /* pickList 选项与闭包选中值 */
  const expenseCatItems: PickListItem[] = [];
  for (const g of tree) {
    expenseCatItems.push({ value: g.parent.id, label: `${g.parent.name}（大类）`, group: g.parent.name });
    for (const c of g.children) expenseCatItems.push({ value: c.id, label: c.name, group: g.parent.name });
  }
  const incomeCatItems: PickListItem[] = incomeCategories.map((category) => ({
    value: category.id,
    label: category.name,
  }));
  const catItems = (): PickListItem[] => type === 'income' ? incomeCatItems : expenseCatItems;
  const defaultCatId = (): number | undefined => Number(catItems()[0]?.value) || undefined;
  const categoryKind = new Map<number, CategoryKind>();
  for (const item of expenseCatItems) categoryKind.set(Number(item.value), 'expense');
  for (const item of incomeCatItems) categoryKind.set(Number(item.value), 'income');
  const acctItems: PickListItem[] = accounts.map((a: Account) => ({ value: a.id, label: a.name }));
  let selectedCatId: number | undefined = rule?.categoryId != null && categoryKind.get(rule.categoryId) === type
    ? rule.categoryId
    : defaultCatId();
  let selectedAcctId: number | undefined = rule?.accountId ?? accounts[0]?.id;
  const catBtnLabel = (id?: number): string => {
    for (const g of tree) {
      if (g.parent.id === id) return `${g.parent.name}（大类）`;
      for (const c of g.children) if (c.id === id) return c.name;
    }
    const income = incomeCategories.find((category) => category.id === id);
    if (income) return income.name;
    return '请选择分类';
  };
  const acctBtnLabel = (id?: number): string => accounts.find((a) => a.id === id)?.name ?? '请选择账户';

  /** 入账日控件（随频率切换重绘） */
  const daysField = (): string => {
    switch (freq) {
      case 'daily':
        return '<div class="field"><span>入账日</span><span class="rc-control rc-daily">每天 09:00</span></div>';
      case 'weekly':
        return `
          <div class="field rc-weekly-field"><span>入账日</span><div class="chip-group" id="rc-dow">
            ${DOW.map((t, i) => `<button class="chip${weeklyDays.has(i) ? ' active' : ''}" type="button" data-dow="${i}">周${t}</button>`).join('')}
          </div></div>`;
      case 'monthly':
        return `
          <div class="field"><span>入账日</span><input class="note num rc-control" id="rc-dom" inputmode="numeric" aria-label="每月入账日" aria-description="1至31，多个用逗号分隔，超出当月天数时按月底入账" placeholder="日期，如 5,20" value="${rule?.freq === 'monthly' ? rule.days.join(',') : ''}"></div>`;
      case 'yearly':
        return `
          <div class="field"><span>入账日</span><input class="note num rc-control" id="rc-mmdd" inputmode="numeric" aria-label="每年入账日" aria-description="月日四位数字，例如0101表示1月1日，多个用逗号分隔" placeholder="月日，如 0101,0615" value="${rule?.freq === 'yearly' ? rule.days.map((v) => String(v).padStart(4, '0')).join(',') : ''}"></div>`;
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
          <div class="field"><span>类型</span><div class="chip-group rc-choice" id="rc-type">
            <button class="chip${type === 'expense' ? ' active' : ''}" type="button" data-type="expense">支出</button>
            <button class="chip${type === 'income' ? ' active' : ''}" type="button" data-type="income">收入</button>
          </div></div>
          <div class="field"><span>名称</span><input class="note rc-control" id="rc-name" placeholder="如 房租" maxlength="20" value="${esc(rule?.name ?? '')}"></div>
          <div class="field"><span>金额（元）</span><input class="note num rc-control" id="rc-amount" inputmode="decimal" placeholder="0.00" value="${rule ? yuanValue(rule.amount) : ''}"></div>
          <div class="field"><span>入账时确认金额</span><button class="switch${amountConfirm ? ' on' : ''}" id="rc-confirm" role="switch" aria-checked="${amountConfirm}" aria-label="入账时确认金额"></button></div>
          <p class="tiny rc-help">开启后，到期核对金额再入账</p>
          <div class="field"><span>频率</span><div class="chip-group" id="rc-freq">
            ${FREQS.map((f) => `<button class="chip${freq === f.value ? ' active' : ''}" type="button" data-freq="${f.value}">${f.label}</button>`).join('')}
          </div></div>
          <div id="rc-days">${daysField()}</div>
          <div class="field"><span>每几${freq === 'weekly' ? '周' : freq === 'monthly' ? '月' : freq === 'yearly' ? '年' : '天'}</span><input class="note num rc-control" id="rc-interval" inputmode="numeric" style="max-width:90px;text-align:right" value="${interval}"></div>
          <div class="field"><span>开始日期</span><button class="pick-btn rc-control" id="rc-start" aria-label="生效开始日期">${startDate ? dateLabel(startDate) : '立即生效'}</button></div>
          <div class="field"><span>结束日期</span><button class="pick-btn rc-control" id="rc-end" aria-label="生效结束日期">${endDate ? dateLabel(endDate) : '长期有效'}</button></div>
          <div class="field"><span>周期转账到</span><button class="pick-btn rc-control" id="rc-transfer" aria-label="周期转账目标账户">${transferToAccountId ? acctBtnLabel(transferToAccountId) : '不转账'}</button></div>
          <div class="field"><span>分类</span><button class="pick-btn rc-control" id="rc-cat" aria-label="${type === 'income' ? '收入' : '支出'}分类">${catBtnLabel(selectedCatId)}</button></div>
          <div class="field"><span>入账账户</span><button class="pick-btn rc-control" id="rc-acct" aria-label="入账账户">${acctBtnLabel(selectedAcctId)}</button></div>
          <button class="btn primary" data-act="save" style="margin-top:14px">${rule ? '保存修改' : '创建周期账'}</button>
          ${rule ? '<button class="btn ghost" data-act="del" style="margin-top:10px;color:var(--over)">删除此周期账</button>' : ''}
        </div>`;

      el.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const typeBtn = target.closest<HTMLElement>('[data-type]');
        if (typeBtn) {
          const nextType = typeBtn.dataset.type as CategoryKind;
          if (nextType !== type) {
            type = nextType;
            selectedCatId = defaultCatId();
            el.querySelectorAll('[data-type]').forEach((button) => button.classList.toggle('active', button === typeBtn));
            const catBtn = el.querySelector<HTMLButtonElement>('#rc-cat')!;
            catBtn.textContent = catBtnLabel(selectedCatId);
            catBtn.setAttribute('aria-label', `${type === 'income' ? '收入' : '支出'}分类`);
          }
          return;
        }
        if (target.closest('#rc-confirm')) {
          amountConfirm = !amountConfirm;
          const sw = el.querySelector('#rc-confirm')!;
          sw.classList.toggle('on', amountConfirm);
          sw.setAttribute('aria-checked', String(amountConfirm));
          return;
        }
        if (target.closest('#rc-cat')) {
          const items = catItems();
          if (!items.length) {
            showToast(`暂无${type === 'income' ? '收入' : '支出'}分类，请先添加`);
            return;
          }
          openPickList({
            container: el,
            title: '选择分类',
            items,
            selected: selectedCatId,
            onPick(value, label) {
              selectedCatId = Number(value);
              el.querySelector('#rc-cat')!.textContent = label;
            },
          });
          return;
        }
        if (target.closest('#rc-start') || target.closest('#rc-end')) {
          const which = target.closest('#rc-start') ? 'start' : 'end';
          const initial = which === 'start' ? startDate ?? Date.now() : endDate ?? Date.now();
          const d = new Date(initial);
          const panel = openDateWheel({
            initial: { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() },
            onConfirm: r => {
              const ts = new Date(r.year, r.month - 1, r.day, 9).getTime();
              if (which === 'start') startDate = ts; else endDate = ts;
              el.querySelector<HTMLButtonElement>(which === 'start' ? '#rc-start' : '#rc-end')!.textContent = dateLabel(ts);
            },
          });
          document.body.appendChild(panel);
          return;
        }
        if (target.closest('#rc-transfer')) {
          openPickList({
            container: el,
            title: '周期转账目标账户',
            items: [{ value: 'none', label: '不转账（按收支入账）' }, ...acctItems],
            selected: transferToAccountId ?? 'none',
            onPick(value, label) {
              transferToAccountId = value === 'none' ? undefined : Number(value);
              el.querySelector<HTMLButtonElement>('#rc-transfer')!.textContent = transferToAccountId ? label : '不转账';
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
          const intervalRaw = Number(el.querySelector<HTMLInputElement>('#rc-interval')!.value.trim() || '1');
          if (!Number.isInteger(intervalRaw) || intervalRaw < 1 || intervalRaw > 99) throw new Error('周期间隔应为 1-99 的整数');
          interval = intervalRaw;
          if (startDate != null && endDate != null && endDate < startDate) throw new Error('结束日期不能早于开始日期');
          if (transferToAccountId != null && transferToAccountId === accountId) throw new Error('转账目标不能与入账账户相同');
          const input: NewRecurringRule = {
            name, type, amount, amountConfirm, freq, days, categoryId, accountId,
            enabled: rule?.enabled ?? true,
            interval,
            startDate,
            endDate,
            transferToAccountId,
          };
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
        pendingQueue.splice(0, pendingQueue.length, ...pendingQueue.filter((item) => item.ruleId !== r.id));
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
            <p class="tiny" style="padding:0 0 6px">核对金额后入账，关闭后可稍后处理</p>
            ${pendingQueue.map((p, i) => `
              <div class="field">
                <span>${esc(p.name)}<i class="rc-due">${p.type === 'income' ? '收入' : '支出'} · ${mdText(p.dueAt)} 到期 · ${esc(acctName.get(p.accountId) ?? '账户已删除')}</i></span>
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
        const skip = target.closest<HTMLElement>('[data-skip]');
        if (skip) {
          void (async () => {
            const ok = await confirmDialog({ title: '跳过本期？', message: '下一期顺延到再下一期，本期不再生成账单或待确认项。', okText: '跳过' });
            if (!ok) return;
            await skipNextOccurrence(Number(skip.dataset.skip));
            showToast('已跳过本期');
            void refresh();
          })();
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
