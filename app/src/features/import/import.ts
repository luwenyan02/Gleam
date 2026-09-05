/**
 * 拾光 · 挖财账单导入向导（features/import，PRD 4.16，入口在备份页）
 * 五步：①选文件（备份页触发）→ ②解析预检 → ③映射确认（支持整批自动处理）→
 * ④事务化导入（前置自动快照 + importBatch，失败全回滚）→ ⑤完成报告。
 * 解析规则见 wacai.ts；导入经 entryRepo.importEntriesBatch 复用硬规则驱动余额。
 * 查重：「时间+类型+金额+账户」，转账按 from/to 走 findTransferDuplicates（README 遗留事项 1）。
 */
import './import.css';
import { esc } from '../../core/esc';
import { registerSubpage, openSubpage, closeSubpage } from '../shell/router';
import { showToast } from '../shell/toast';
import { createSnapshot } from '../../core/repo/backupRepo';
import { listCategories, addCategory } from '../../core/repo/categoryRepo';
import { listAccounts, addAccount } from '../../core/repo/accountRepo';
import { ensureTag } from '../../core/repo/tagRepo';
import { ensureLoanContact } from '../../core/repo/loanRepo';
import { ensureMerchant, touchMerchant } from '../../core/repo/merchantRepo';
import {
  findDuplicates, findTransferDuplicates, importEntriesBatch,
  type ImportEntryItem, type NewEntry,
} from '../../core/repo/entryRepo';
import { ACCOUNT_GROUP_NAMES, type Account, type AccountGroup, type Category } from '../../core/types';
import { parseWacaiFile, type WacaiParseResult, type WacaiRow } from './wacai';
import { openPickList, type PickListItem } from '../../shared/pickList';

/* ── 向导状态 ── */

/** 分类映射计划（每个未匹配 categoryKey 一条；choice='auto' 即按建议新建） */
interface CatPlan {
  key: string;
  type: 'expense' | 'income';
  name: string;
  matchedId?: number;
  choice: number | 'auto';
}

/** 账户映射计划 */
interface AcctPlan {
  name: string;
  matchedId?: number;
  choice: number | 'auto';
  /** 新建时的分组（按名称启发式猜测） */
  group: AccountGroup;
}

interface ImportReport {
  imported: number;
  skipped: number;
  skippedRows: number[];
  byType: WacaiParseResult['counts'];
  reimburse: number;
  loanContacts: string[];
  fx: number;
  createdCats: number;
  createdAccts: number;
}

interface WizardState {
  file: File;
  result: WacaiParseResult;
  cats: CatPlan[];
  accts: AcctPlan[];
  expenseCats: Category[];
  incomeCats: Category[];
  accounts: Account[];
  step: 2 | 3 | 4 | 5;
  report?: ImportReport;
  running: boolean;
}

let state: WizardState | undefined;
let body: HTMLElement | undefined;

/* 映射页 pickList 共享 items（mappingHtml 构建，click 委托引用） */
let mapExpenseItems: PickListItem[] = [];
let mapIncomeItems: PickListItem[] = [];
let mapAcctItems: PickListItem[] = [];

/* ── 匹配与新建 ── */

/** 账户分组启发式（仅新建时用；用户可导入后在账户页改） */
function guessGroup(name: string): AccountGroup {
  if (/信用|贷记|花呗|白条/.test(name)) return 'credit';
  if (/证券|基金|股票|投资|理财/.test(name)) return 'investment';
  if (/应收|应付|欠款/.test(name)) return 'receivable';
  if (/储值|预付|购物卡|公交卡|饭卡|校园卡/.test(name)) return 'stored';
  if (/微信|支付宝|钱包|余额|零钱|网商|云闪付/.test(name)) return 'online';
  if (/银行|储蓄|借记|存折|卡/.test(name)) return 'debit';
  return 'other';
}

/** 分类精确匹配：两级键先配大类+小类，退化配同名小类；单级先小类再大类 */
function matchCategory(type: 'expense' | 'income', name: string, expense: Category[], income: Category[]): number | undefined {
  if (type === 'income') return income.find((c) => c.name === name)?.id;
  if (name.includes('/')) {
    const [big, small] = name.split('/', 2).map((s) => s.trim());
    const bigCat = expense.find((c) => c.parentId == null && c.name === big);
    if (bigCat) {
      const child = expense.find((c) => c.parentId === bigCat.id && c.name === small);
      if (child) return child.id;
    }
    return expense.find((c) => c.parentId != null && c.name === small)?.id;
  }
  return (
    expense.find((c) => c.parentId != null && c.name === name)?.id
    ?? expense.find((c) => c.parentId == null && c.name === name)?.id
  );
}

/**
 * 按计划新建分类：两级键补齐大类+小类；单级支出归入「其他」大类下的小类。
 * 传入的 expense 数组会被就地追加，供同批后续键复用。
 */
async function createCategory(plan: CatPlan, expense: Category[], income: Category[]): Promise<number> {
  if (plan.type === 'income') {
    const id = await addCategory({ name: plan.name, icon: 'ic-coin', kind: 'income' });
    income.push({ id, name: plan.name, icon: 'ic-coin', kind: 'income' } as Category);
    return id;
  }
  const [big, small] = plan.name.includes('/')
    ? plan.name.split('/', 2).map((s) => s.trim())
    : ['其他', plan.name];
  let bigCat = expense.find((c) => c.parentId == null && c.name === big);
  if (!bigCat) {
    const bigId = await addCategory({ name: big, icon: 'ic-tag', kind: 'expense' });
    bigCat = { id: bigId, name: big, icon: 'ic-tag', kind: 'expense' } as Category;
    expense.push(bigCat);
  }
  const exist = expense.find((c) => c.parentId === bigCat!.id && c.name === small);
  if (exist) return exist.id;
  const id = await addCategory({ name: small, icon: 'ic-tag', kind: 'expense', parentId: bigCat.id });
  expense.push({ id, name: small, icon: 'ic-tag', kind: 'expense', parentId: bigCat.id } as Category);
  return id;
}

/* ── 第②步 → 第③步的数据准备 ── */

async function buildPlans(result: WacaiParseResult): Promise<Pick<WizardState, 'cats' | 'accts' | 'expenseCats' | 'incomeCats' | 'accounts'>> {
  const [expenseCats, incomeCats, accounts] = await Promise.all([
    listCategories('expense'), listCategories('income'), listAccounts(),
  ]);
  const cats: CatPlan[] = result.categoryKeys.map((full) => {
    const i = full.indexOf(':');
    const type = full.slice(0, i) as 'expense' | 'income';
    const name = full.slice(i + 1);
    const matchedId = matchCategory(type, name, expenseCats, incomeCats);
    return { key: full, type, name, matchedId, choice: matchedId ?? 'auto' };
  });
  const accts: AcctPlan[] = result.accountNames.map((name) => {
    const matchedId = accounts.find((a) => a.name === name)?.id;
    return { name, matchedId, choice: matchedId ?? 'auto', group: guessGroup(name) };
  });
  return { cats, accts, expenseCats, incomeCats, accounts };
}

/* ── 第④步：事务化导入 ── */

async function runImport(): Promise<void> {
  const st = state;
  if (!st || st.running) return;
  st.running = true;
  st.step = 4;
  renderStep();
  try {
    // 前置自动快照（7 天内可在备份页撤销）
    await createSnapshot('import', `导入「${st.file.name}」前`);

    // 解析映射计划：分类 / 账户（choice=数字即用户指定；'auto' 按建议匹配或新建）
    const catIds = new Map<string, number>();
    for (const p of st.cats) {
      if (typeof p.choice === 'number') catIds.set(p.key, p.choice);
      else if (p.matchedId != null) catIds.set(p.key, p.matchedId);
      else catIds.set(p.key, await createCategory(p, st.expenseCats, st.incomeCats));
    }
    const acctIds = new Map<string, number>();
    for (const p of st.accts) {
      if (typeof p.choice === 'number') acctIds.set(p.name, p.choice);
      else if (p.matchedId != null) acctIds.set(p.name, p.matchedId);
      else acctIds.set(p.name, await addAccount({ name: p.name, group: p.group, balance: 0 }));
    }
    const createdCats = st.cats.filter((p) => p.choice === 'auto' && p.matchedId == null).length;
    const createdAccts = st.accts.filter((p) => p.choice === 'auto' && p.matchedId == null).length;

    // 标签 / 商家 / 往来对象（事务外 ensure，导入事务内只引用 id）
    const tagIds = new Map<string, number>();
    const merchantIds = new Map<string, number>();
    const contactIds = new Map<string, number>();
    for (const row of st.result.rows) {
      for (const t of row.tags) if (!tagIds.has(t)) tagIds.set(t, await ensureTag(t));
      if (row.merchant && !merchantIds.has(row.merchant)) merchantIds.set(row.merchant, await ensureMerchant(row.merchant));
      if (row.contactName && !contactIds.has(row.contactName)) contactIds.set(row.contactName, await ensureLoanContact(row.contactName));
    }

    // 查重（时间+类型+金额+账户；转账按 from/to）→ 命中默认跳过
    const items: ImportEntryItem[] = [];
    const importedRows: WacaiRow[] = [];
    const skippedRows: number[] = [];
    for (const row of st.result.rows) {
      const dup = row.type === 'transfer'
        ? await findTransferDuplicates(
          row.occurredAt, row.amountFen,
          acctIds.get(row.fromAccountName!), acctIds.get(row.toAccountName!),
        )
        : await findDuplicates(row.occurredAt, row.type, row.amountFen, acctIds.get(row.accountName!));
      if (dup.length) { skippedRows.push(row.rowNo); continue; }
      items.push({ input: rowToEntry(row, catIds, acctIds, contactIds, merchantIds), tagIds: row.tags.map((t) => tagIds.get(t)!) });
      importedRows.push(row);
    }

    // 单事务写入（含 importBatch），任一笔失败全回滚
    if (items.length) {
      await importEntriesBatch(items, {
        source: 'wacai',
        fileName: st.file.name,
        counts: { ...st.result.counts, skipped: skippedRows.length },
        snapshotRef: `导入「${st.file.name}」前`,
      });
      for (const row of importedRows) {
        if (row.merchant) await touchMerchant(merchantIds.get(row.merchant)!);
      }
    }

    st.report = {
      imported: items.length,
      skipped: skippedRows.length,
      skippedRows,
      byType: st.result.counts,
      reimburse: importedRows.filter((r) => r.reimburseDone).length,
      loanContacts: [...new Set(importedRows.filter((r) => r.contactName).map((r) => r.contactName!))],
      fx: importedRows.filter((r) => r.note.includes('按导入时参考汇率')).length,
      createdCats,
      createdAccts,
    };
    st.step = 5;
  } catch (err) {
    showToast(`导入失败，已全部回滚：${err instanceof Error ? err.message : String(err)}`);
    st.step = 3;
  } finally {
    st.running = false;
    renderStep();
  }
}

/** 解析行 → NewEntry（金额已是折算/分摊后的分） */
function rowToEntry(
  row: WacaiRow,
  catIds: Map<string, number>,
  acctIds: Map<string, number>,
  contactIds: Map<string, number>,
  merchantIds: Map<string, number>,
): NewEntry {
  const base = {
    type: row.type, amount: row.amountFen, occurredAt: row.occurredAt,
    note: row.note || undefined,
    merchantId: row.merchant ? merchantIds.get(row.merchant) : undefined,
  };
  if (row.type === 'transfer') {
    return { ...base, fromAccountId: acctIds.get(row.fromAccountName!), toAccountId: acctIds.get(row.toAccountName!) };
  }
  if (row.type === 'loan') {
    return { ...base, loanKind: row.loanKind, loanContactId: contactIds.get(row.contactName!), accountId: acctIds.get(row.accountName!) };
  }
  return {
    ...base,
    categoryId: catIds.get(`${row.type}:${row.categoryKey!}`),
    accountId: acctIds.get(row.accountName!),
    // 属性「已报销」仅为状态标记：挖财导出不含到账账户与到账金额，故不写
    // reimburseAccountId/reimbursedAmount，不产生报销到账的余额效果；
    // 余额与「报销计收入」统计口径均按未到账处理，属预期行为。
    reimburseStatus: row.type === 'expense' && row.reimburseDone ? 'done' : 'none',
  };
}

/* ── 渲染 ── */

function stepsHtml(cur: number): string {
  const names = ['选文件', '解析预检', '映射确认', '导入', '完成'];
  return `<div class="imp-steps">${names.map((n, i) => `<span${i + 1 === cur ? ' class="on"' : ''}>${i + 1} ${n}</span>`).join('')}</div>`;
}

function renderStep(): void {
  const el = body;
  const st = state;
  if (!el?.isConnected || !st) return;
  if (st.step === 2) el.innerHTML = stepsHtml(2) + precheckHtml(st);
  else if (st.step === 3) el.innerHTML = stepsHtml(3) + mappingHtml(st);
  else if (st.step === 4) el.innerHTML = `${stepsHtml(4)}<section class="card"><h3 class="card-title">正在导入…</h3><p class="sub">已自动创建快照，正在事务化写入，请勿关闭页面</p></section>`;
  else el.innerHTML = stepsHtml(5) + reportHtml(st);
}

function precheckHtml(st: WizardState): string {
  const { counts, issues, rows } = st.result;
  const unCat = st.cats.filter((p) => p.matchedId == null).length;
  const unAcct = st.accts.filter((p) => p.matchedId == null).length;
  return `
    <section class="card">
      <h3 class="card-title">解析预检 · ${esc(st.file.name)}</h3>
      <p class="sub">共解析出 <b>${rows.length}</b> 条有效流水（空行已跳过）</p>
      <div class="imp-stat">
        <b>支出 ${counts.expense}</b><b>收入 ${counts.income}</b>
        <b>转账 ${counts.transfer}</b><b>借贷 ${counts.loan}</b>
      </div>
      <p class="sub" style="margin-top:10px">待确认：未匹配分类 ${unCat} 项 · 未匹配账户 ${unAcct} 项（下一步指定或自动新建）</p>
      ${issues.length ? `
      <div class="imp-issues">
        <p><b>格式异常 ${issues.length} 行（将跳过）</b></p>
        ${issues.map((i) => `<p>第 ${i.rowNo} 行：${esc(i.message)}</p>`).join('')}
      </div>` : ''}
      <div class="btn-row" style="margin-top:14px">
        <button class="btn ghost" data-act="cancel">取消</button>
        <button class="btn primary" data-act="to-map"${rows.length ? '' : ' disabled'}>下一步：映射确认</button>
      </div>
    </section>`;
}

function mappingHtml(st: WizardState): string {
  const unCats = st.cats.filter((p) => p.matchedId == null);
  const unAccts = st.accts.filter((p) => p.matchedId == null);
  /* 构建共享 items（所有行复用同一引用） */
  mapExpenseItems = st.expenseCats.filter((c) => c.parentId != null).map((c) => ({
    value: c.id,
    label: `${st.expenseCats.find((b) => b.id === c.parentId)?.name ?? ''}/${c.name}`,
  }));
  mapIncomeItems = st.incomeCats.map((c) => ({ value: c.id, label: c.name }));
  mapAcctItems = st.accounts.map((a) => ({ value: a.id, label: a.name }));
  const catLabel = (p: CatPlan): string => {
    if (p.choice === 'auto') return `自动新建「${esc(p.name)}」`;
    const items = p.type === 'income' ? mapIncomeItems : mapExpenseItems;
    return esc(items.find((it) => it.value === p.choice)?.label ?? '未知');
  };
  const acctLabel = (p: AcctPlan): string => {
    if (p.choice === 'auto') return `自动新建（${ACCOUNT_GROUP_NAMES[p.group]}）`;
    return esc(mapAcctItems.find((it) => it.value === p.choice)?.label ?? '未知');
  };
  return `
    <section class="card imp-map">
      <h3 class="card-title">映射确认</h3>
      ${unCats.length || unAccts.length ? `
      <p class="sub">以下项目在拾光中不存在，可逐项指定现有项，或保持「自动新建」</p>
      ${unCats.length ? `
      <table class="map-table"><thead><tr><th>挖财分类</th><th>拾光处理</th></tr></thead><tbody>
        ${unCats.map((p) => `<tr><td>${esc(p.name)}${p.type === 'income' ? '（收入）' : ''}</td><td><button class="pick-btn" data-cat="${esc(p.key)}">${catLabel(p)}</button></td></tr>`).join('')}
      </tbody></table>` : ''}
      ${unAccts.length ? `
      <table class="map-table" style="margin-top:10px"><thead><tr><th>挖财账户</th><th>拾光处理</th></tr></thead><tbody>
        ${unAccts.map((p) => `<tr><td>${esc(p.name)}</td><td><button class="pick-btn" data-acct="${esc(p.name)}">${acctLabel(p)}</button></td></tr>`).join('')}
      </tbody></table>` : ''}
      <div class="btn-row" style="margin-top:12px">
        <button class="btn ghost" data-act="auto-all">按建议自动处理</button>
      </div>` : '<p class="sub">全部分类与账户均已精确匹配，无需处理 ✓</p>'}
      <p class="tiny" style="margin-top:10px">导入前会自动创建本地快照（7 天内可撤销）；重复账单（时间+类型+金额+账户一致）将自动跳过</p>
      <div class="btn-row" style="margin-top:8px">
        <button class="btn ghost" data-act="to-pre">上一步</button>
        <button class="btn primary" data-act="run">开始导入</button>
      </div>
    </section>`;
}

function reportHtml(st: WizardState): string {
  const r = st.report!;
  return `
    <section class="card imp-report">
      <h3 class="card-title">导入完成</h3>
      <p class="big num">${r.imported} <small style="font-size:13px;font-weight:400">条成功入账</small></p>
      <p>支出 ${r.byType.expense} · 收入 ${r.byType.income} · 转账 ${r.byType.transfer} · 借贷 ${r.byType.loan}（解析计数）</p>
      <p>跳过重复 ${r.skipped} 条${r.skippedRows.length ? `（行号 ${r.skippedRows.join('、')}）` : ''} · 格式异常跳过 ${st.result.issues.length} 条</p>
      ${r.reimburse ? `<p>报销：${r.reimburse} 条已标记「已报销」（无到账账户信息，仅记状态）</p>` : ''}
      ${r.loanContacts.length ? `<p>借贷往来：已建立/更新往来对象 ${esc(r.loanContacts.join('、'))}，余额随账单联动</p>` : ''}
      ${r.fx ? `<p>外币折算：${r.fx} 条按导入时参考汇率折算为人民币，原币种金额在备注中保留</p>` : ''}
      ${r.createdCats || r.createdAccts ? `<p>自动新建：分类 ${r.createdCats} 项 · 账户 ${r.createdAccts} 项</p>` : ''}
      <p class="tiny" style="margin-top:6px">导入前的数据快照可在「备份与恢复」页一键撤销（保留 7 天）</p>
      <div class="btn-row" style="margin-top:12px">
        <button class="btn primary" data-act="done">完成</button>
      </div>
    </section>`;
}

/* ── 装配 ── */

/**
 * 备份页入口：选好文件后调用，解析并打开向导子页。
 * 表头不符等致命错误在此拦截（toast），不进入向导。
 */
export async function openImportWizard(file: File): Promise<void> {
  try {
    const result = await parseWacaiFile(file);
    const plans = await buildPlans(result);
    state = { file, result, ...plans, step: 2, running: false };
    openSubpage('sp-import');
  } catch (err) {
    showToast(err instanceof Error ? err.message : String(err));
  }
}

/** 注册导入向导子页（sp-import），main.ts 调用一次 */
export function initImport(): void {
  registerSubpage('sp-import', {
    title: '挖财账单导入',
    render(el) {
      body = el;
      el.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const st = state;
        if (!st || st.running) return;
        /* pick-btn：分类映射 */
        const catBtn = target.closest<HTMLElement>('[data-cat]');
        if (catBtn) {
          const p = st.cats.find((c) => c.key === catBtn.dataset.cat);
          if (!p) return;
          const autoItem: PickListItem = { value: 'auto', label: `自动新建「${p.name}」` };
          openPickList({
            container: el,
            title: '选择分类',
            items: [autoItem, ...(p.type === 'income' ? mapIncomeItems : mapExpenseItems)],
            selected: p.choice,
            onPick(value, label) {
              p.choice = value === 'auto' ? 'auto' : Number(value);
              catBtn.textContent = label;
            },
          });
          return;
        }
        /* pick-btn：账户映射 */
        const acctBtn = target.closest<HTMLElement>('[data-acct]');
        if (acctBtn) {
          const p = st.accts.find((a) => a.name === acctBtn.dataset.acct);
          if (!p) return;
          const autoItem: PickListItem = { value: 'auto', label: `自动新建（${ACCOUNT_GROUP_NAMES[p.group]}）` };
          openPickList({
            container: el,
            title: '选择账户',
            items: [autoItem, ...mapAcctItems],
            selected: p.choice,
            onPick(value, label) {
              p.choice = value === 'auto' ? 'auto' : Number(value);
              acctBtn.textContent = label;
            },
          });
          return;
        }
        const act = target.closest<HTMLElement>('[data-act]')?.dataset.act;
        if (!act) return;
        if (act === 'cancel' || act === 'done') closeSubpage();
        else if (act === 'to-map') { st.step = 3; renderStep(); }
        else if (act === 'to-pre') { st.step = 2; renderStep(); }
        else if (act === 'auto-all') {
          for (const p of st.cats) if (p.matchedId == null) p.choice = 'auto';
          for (const p of st.accts) if (p.matchedId == null) p.choice = 'auto';
          renderStep();
          showToast('已全部设为按建议自动处理');
        } else if (act === 'run') void runImport();
      });
      renderStep();
    },
  });
}
