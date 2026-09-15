/**
 * 拾光 · 预算中心（features/budget，PRD 4.8）
 * 总预算卡（额度/进度/已用/剩余/日均可用/节奏提示）+ 分类子预算三态色 +
 * 预算设置抽屉（总额度、各大类额度、自动延续开关）。
 * 「已用」一律 statsRepo.budgetUsage，与首页月度总览严格同源；
 * 月末不结转，下月延续由 budgetRepo.ensureMonthBudget 保证（进入本页时消费）。
 * 视觉结构与原型 index.html #page-budget（L894-924）一致。
 */
import './budget.css';
import { iconHtml } from '../../assets/icons';
import { esc } from '../../core/esc';
import { on } from '../../core/store';
import { formatFen, formatFenCny, parseYuanToFen } from '../../core/money';
import { getBudget, ensureMonthBudget, listCategoryBudgets, saveMonthlyBudget, copyPreviousBudget, getAnnualBudget, setAnnualBudget } from '../../core/repo/budgetRepo';
import { budgetUsage, rangeSummary, yearRange } from '../../core/repo/statsRepo';
import { listExpenseTree } from '../../core/repo/categoryRepo';
import { getSetting } from '../../core/repo/settingsRepo';
import { registerSubpage } from '../shell/router';
import { openSheet, closeSheet } from '../shell/sheet';
import { showToast } from '../shell/toast';
import { confirmDialog } from '../shell/dialog';
import { openMonthWheel } from '../../shared/dateTimeWheel';
import type { Category } from '../../core/types';
import { accountingMonthRange, getAccountingMonth } from '../../core/repo/periodRepo';
import { accountingRangeProgress, formatAccountingRange } from '../../core/period';

/* ── 模块状态 ── */
let body: HTMLElement | undefined;
/** 并发刷新令牌 */
let refreshToken = 0;
let selectedMonth = '';
/** 未手动选期时，起始日变化应自动切换到新的当前财务月。 */
let followsCurrentMonth = true;
/** 年预算始终使用自然年，不借用可能跨年的财务月键。 */
let selectedAnnualYear = new Date().getFullYear();
let annual = false;
/** 抽屉监听器控制（#sheet 为复用容器，重开前废止上一次绑定，防重复提交） */
let sheetAbort: AbortController | undefined;

function sheetSignal(): AbortSignal {
  sheetAbort?.abort();
  sheetAbort = new AbortController();
  return sheetAbort.signal;
}


/** 元整数展示（原型 fmt0 语义，用于 '/ ¥1,800' 的额度） */
function fmtYuan0(fen: number): string {
  return formatFen(fen).split('.')[0];
}

/** 进度三态：绿(<60%) / 主题橙(60–100%) / 红(>100%) */
function stateOf(pct: number): 'ok' | 'warn' | 'over' {
  if (pct > 100) return 'over';
  return pct < 60 ? 'ok' : 'warn';
}

/* ── 页面渲染 ── */

async function refresh(): Promise<void> {
  const el = body;
  if (!el?.isConnected) return;
  const token = ++refreshToken;
  const currentMonth = await getAccountingMonth();
  if (followsCurrentMonth || !selectedMonth) selectedMonth = currentMonth;
  const month = selectedMonth;
  const range = await accountingMonthRange(month);
  const rangeText = formatAccountingRange(range);
  // ensureMonthBudget：上月开启延续时按上月额度（含子预算）自动建档
  const [budget, usage, tree, catBudgets] = await Promise.all([
    (month === currentMonth ? ensureMonthBudget(month) : getBudget(month)), budgetUsage(month), listExpenseTree(), listCategoryBudgets(month),
  ]);
  if (token !== refreshToken || !el.isConnected) return;

  const d = new Date();
  const selectedYear = selectedAnnualYear;
  const periodControls = `<div class="bd-period"><button class="btn" data-act="period">${annual ? selectedYear + '年' : `财务月 ${month}`} ▾</button><button class="btn" data-act="mode">${annual ? '查看月预算' : '查看年度预算'}</button>${annual ? '' : '<button class="btn" data-act="copy">复制上期</button>'}</div>${annual ? '' : `<p class="tiny" style="text-align:center;margin:-4px 0 10px">${rangeText}</p>`}`;
  if (annual) {
    const range = yearRange(selectedYear);
    const [limit, summary] = await Promise.all([getAnnualBudget(selectedYear), rangeSummary(range.from, range.to)]);
    if (token !== refreshToken || !el.isConnected) return;
    el.innerHTML = `${periodControls}<section class="card budget-overview"><p class="label">${selectedYear}年总预算</p><p class="big num">${formatFenCny(limit)}</p><div class="bd-meta"><p>已使用<span class="num">${formatFenCny(summary.expense)}</span></p><p>剩余<span class="num">${formatFenCny(limit - summary.expense)}</span></p></div><button class="btn primary" data-act="setup">设置年度预算</button></section>`;
    return;
  }
  const progress = accountingRangeProgress(range, d.getTime());
  const timePct = progress.percent;

  /* 总预算卡 */
  let overviewHtml: string;
  if (budget && budget.totalLimit > 0) {
    const used = usage.totalUsed;
    const usedPct = (used / budget.totalLimit) * 100;
    const remain = budget.totalLimit - used;
    const remainDays = progress.remainingDays;
    const daily = Math.max(0, Math.floor(remain / remainDays));
    const barCls = usedPct > 100 ? 'over' : usedPct > timePct ? 'warn' : 'ok';
    let hint: string;
    if (usedPct > 100) {
      hint = `预算已超支 ${formatFenCny(used - budget.totalLimit)} —— 建议压缩本月剩余开销`;
    } else if (usedPct > timePct) {
      hint = `截至 ${d.getMonth() + 1}月${d.getDate()}日，周期进度 ${timePct.toFixed(1)}%，但预算已用 ${usedPct.toFixed(1)}% —— 消费偏快，注意后面的节奏`;
    } else {
      hint = `时间进度 ${timePct.toFixed(1)}%，预算已用 ${usedPct.toFixed(1)}% —— 节奏稳健，继续保持`;
    }
    overviewHtml = `
      <section class="card budget-overview" aria-label="财务月总预算">
        <p class="label">${month} 财务月总预算</p>
        <p class="big num">${formatFenCny(budget.totalLimit)}</p>
        <div class="bd-bar"><i class="${barCls}" style="width:${Math.max(0, Math.min(100, usedPct)).toFixed(1)}%"></i></div>
        <div class="bd-meta">
          <p>已使用<span class="num">${formatFenCny(used)}</span></p>
          <p>剩余<span class="num">${formatFenCny(remain)}</span></p>
          ${month === currentMonth ? `<p>日均可用<span class="num">${formatFenCny(daily)}</span></p>` : ''}
        </div>
        <p class="tiny" style="margin-top:8px">${month === currentMonth ? hint : `按 ${rangeText} 统计`}</p>
      </section>`;
  } else {
    overviewHtml = `
      <section class="card budget-overview" aria-label="财务月总预算">
        <p class="label">${month} 财务月总预算</p>
        <div class="bd-empty">
          <p class="sub">还没有设置所选财务月预算<br>设定总额度后，首页总览与这里会同步展示进度</p>
          <button class="btn primary" data-act="setup">设置预算</button>
        </div>
      </section>`;
  }

  /* 分类子预算 */
  const limitMap = new Map<number, number>(catBudgets.map((cb) => [cb.categoryId, cb.limit]));
  const rows = tree
    .map((g) => ({ cat: g.parent, limit: limitMap.get(g.parent.id) ?? 0 }))
    .filter((r) => r.limit > 0);
  const rowsHtml = rows.map(({ cat, limit }) => {
    const used = usage.byCategory.get(cat.id) ?? 0;
    const pct = (used / limit) * 100;
    const st = stateOf(pct);
    const flag = st === 'over' ? `<em class="bd-flag">超支 ${formatFenCny(used - limit)}</em>` : '';
    return `
      <div class="bd-row">
        <div class="bd-top"><span>${esc(cat.name)}</span><span class="num">${formatFenCny(used)} <em class="lim">/ ¥${fmtYuan0(limit)}</em>${flag}</span></div>
        <div class="bd-bar"><i class="${st}" style="width:${Math.max(0, Math.min(100, pct)).toFixed(1)}%"></i></div>
      </div>`;
  }).join('');

  el.innerHTML = `
    ${periodControls}
    ${overviewHtml}
    <section class="card" aria-label="分类子预算">
      <h3 class="card-title">分类子预算</h3>
      ${rowsHtml || '<p class="sub" style="padding:8px 0 12px">还没有分类子预算 · 点右上角设置，按支出大类分配额度</p>'}
      <p class="bd-legend"><span><i style="background:var(--income)"></i>进度良好</span><span><i style="background:var(--primary)"></i>消费偏快</span><span><i style="background:var(--over)"></i>已超支</span></p>
    </section>
    <p class="tiny" style="text-align:center">财务月结束时未用完的预算不结转 · ${budget?.autoRenew !== false ? '下个财务月自动按本期额度延续，可在预算设置中关闭' : '已关闭自动延续，下期需重新设置'}</p>`;
}

/* ── 预算设置抽屉 ── */

async function openBudgetSheet(): Promise<void> {
  if (!selectedMonth) selectedMonth = await getAccountingMonth();
  const month = selectedMonth;
  if (annual) { await openAnnualSheet(selectedAnnualYear); return; }
  const [budget, tree, catBudgets, renewDefault] = await Promise.all([
    getBudget(month), listExpenseTree(), listCategoryBudgets(month), getSetting('budget.autoRenew'),
  ]);
  const limitMap = new Map<number, number>(catBudgets.map((cb) => [cb.categoryId, cb.limit]));
  let autoRenew = budget?.autoRenew ?? renewDefault;
  const parents: Category[] = tree.map((g) => g.parent);

  openSheet({
    ariaLabel: '预算设置',
    onClose: () => sheetAbort?.abort(),
    render(el) {
      el.innerHTML = `
        <div class="sheet-head">
          <p class="sheet-title">财务月预算 · ${month}</p>
          <button class="icon-btn" data-act="close" aria-label="关闭">${iconHtml('ic-close')}</button>
        </div>
        <div class="sheet-scroll">
          <div class="field"><span>总额度</span><input class="note num" id="bd-total" inputmode="decimal" style="max-width:160px;margin-bottom:0;text-align:right" placeholder="元，留空则不设" value="${budget && budget.totalLimit > 0 ? formatFen(budget.totalLimit).replace(/,/g, '') : ''}"></div>
          <div class="field"><span>下月自动延续</span><button class="switch${autoRenew ? ' on' : ''}" id="bd-renew" role="switch" aria-checked="${autoRenew}" aria-label="下月自动按本月额度延续"></button></div>
          <p class="tiny" style="padding:2px 0 8px">财务月结束时未用完不结转 · 开启延续后，下个财务月按本期额度（含子预算）自动建档</p>
          <h3 class="card-title" style="margin:6px 0 2px">分类子预算（按支出大类）</h3>
          ${parents.map((p) => `
            <div class="field"><span>${esc(p.name)}</span><input class="note num" data-cat="${p.id}" inputmode="decimal" style="max-width:140px;margin-bottom:0;text-align:right" placeholder="不设" value="${(limitMap.get(p.id) ?? 0) > 0 ? formatFen(limitMap.get(p.id)!).replace(/,/g, '') : ''}"></div>`).join('')}
          <button class="btn primary" data-act="save" style="margin-top:14px">保存预算</button>
          <p class="tiny" style="text-align:center;margin-top:10px">子预算留空或填 0 表示不对该大类设限</p>
        </div>`;
      el.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        if (target.closest('#bd-renew')) {
          autoRenew = !autoRenew;
          const sw = el.querySelector('#bd-renew')!;
          sw.classList.toggle('on', autoRenew);
          sw.setAttribute('aria-checked', String(autoRenew));
          return;
        }
        const act = target.closest<HTMLElement>('[data-act]')?.dataset.act;
        if (act === 'close') closeSheet();
        else if (act === 'save') void save();
      }, { signal: sheetSignal() });

      let saving = false;
      async function save(): Promise<void> {
        if (saving) return;
        saving = true;
        try {
          const totalRaw = el.querySelector<HTMLInputElement>('#bd-total')!.value.trim();
          const totalFen = totalRaw ? parseYuanToFen(totalRaw) : 0;
          const catLimits: { id: number; fen: number }[] = [];
          for (const input of el.querySelectorAll<HTMLInputElement>('[data-cat]')) {
            const raw = input.value.trim();
            catLimits.push({ id: Number(input.dataset.cat), fen: raw ? parseYuanToFen(raw) : 0 });
          }
          await saveMonthlyBudget(month, totalFen, catLimits, autoRenew);
          closeSheet();
          showToast(totalFen > 0 ? `${month} 财务月预算已保存` : '已清除所选财务月总预算');
        } catch (err) {
          showToast(err instanceof Error ? err.message : String(err));
        } finally { saving = false; }
      }
    },
  });
}

async function openAnnualSheet(year: number): Promise<void> {
  const limit = await getAnnualBudget(year);
  let saving = false;
  openSheet({ ariaLabel: '年度预算设置', onClose: () => sheetAbort?.abort(), render(el) {
    el.innerHTML = `<div class="sheet-head"><p class="sheet-title">${year}年总预算</p><button class="icon-btn" data-act="close" aria-label="关闭">${iconHtml('ic-close')}</button></div><div class="sheet-scroll"><div class="field"><span>总额度</span><input class="note num" id="bd-annual" inputmode="decimal" placeholder="元，留空则不设" value="${limit ? formatFen(limit).replace(/,/g, '') : ''}"></div><button class="btn primary" data-act="save">保存预算</button></div>`;
    el.addEventListener('click', async event => {
      const act = (event.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
      if (act === 'close') closeSheet();
      if (act !== 'save' || saving) return;
      saving = true;
      try {
        const raw = el.querySelector<HTMLInputElement>('#bd-annual')!.value.trim();
        await setAnnualBudget(year, raw ? parseYuanToFen(raw) : 0);
        closeSheet();
        showToast('年度预算已保存');
      } catch (err) { showToast(err instanceof Error ? err.message : String(err)); }
      finally { saving = false; }
    }, { signal: sheetSignal() });
  } });
}

/* ── 装配 ── */

/** 注册预算中心子页（覆盖 shell 占位 sp-budget），main.ts 调用一次 */
export function initBudget(): void {
  registerSubpage('sp-budget', {
    title: '预算中心',
    render(el) {
      body = el;
      // 设置按钮挂到子页头部（router 只渲染返回与标题，与原型 L898 一致）
      const head = el.closest('.subpage')?.querySelector('.sub-head');
      if (head && !head.querySelector('[data-bd-set]')) {
        const btn = document.createElement('button');
        btn.className = 'icon-btn';
        btn.style.marginLeft = 'auto';
        btn.dataset.bdSet = '';
        btn.setAttribute('aria-label', '设置预算');
        btn.innerHTML = iconHtml('ic-set');
        btn.addEventListener('click', () => void openBudgetSheet());
        head.appendChild(btn);
      }
      el.addEventListener('click', (e) => {
        const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
        if (act === 'setup') void openBudgetSheet();
        if (act === 'mode') {
          annual = !annual;
          if (annual) selectedAnnualYear = followsCurrentMonth ? new Date().getFullYear() : Number(selectedMonth.slice(0, 4));
          void refresh();
        }
        if (act === 'period') {
          const [monthYear, month] = selectedMonth.split('-').map(Number);
          const panel = openMonthWheel({ initial: { year: annual ? selectedAnnualYear : monthYear, month: annual ? 1 : month }, onConfirm: value => {
            if (annual) selectedAnnualYear = value.year;
            else {
              selectedMonth = `${value.year}-${String(value.month).padStart(2, '0')}`;
              followsCurrentMonth = false;
            }
            void refresh();
          } });
          document.body.appendChild(panel);
        }
        if (act === 'copy') void (async () => {
          const month = selectedMonth;
          if (await getBudget(month) && !await confirmDialog({ title: '复制上期预算', message: `将替换财务月 ${month} 的总预算和分类预算，是否继续？` })) return;
          await copyPreviousBudget(month);
          showToast('已复制上期预算');
        })().catch(err => showToast(err.message));
      });
      void refresh();
    },
    onShow() { void refresh(); },
  });

  // 账单/预算/口径变化时刷新（子页关闭即销毁，refresh 内部以 isConnected 兜底）
  on('entries-changed', () => void refresh());
  on('budgets-changed', () => void refresh());
  on('settings-changed', () => void refresh());
}
