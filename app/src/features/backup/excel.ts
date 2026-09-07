/**
 * 拾光 · Excel 导出（features/backup/excel）
 * 生成与挖财模版完全同构的 12 列工作表：
 * 日期时间 / 类型 / 类别 / 金额 / 币种 / 收付款人 / 收付账户 / 参与人 / 标签 / 商家 / 属性 / 备注。
 * 与 features/import 的挖财解析互逆：
 * - 转账「收付账户」输出「A:-x.xx, B:+x.xx」；
 * - 借贷「收付账户」按真实 from/to 输出「A:-x, B:+x」，可原样导入为资金与应收应付双账户；
 * - 已报销支出输出属性「已报销」；退款记录（refundFlag）输出属性「退款」
 *   （createRefund 强制 reimburseStatus='none' 且编辑抽屉对退款隐藏报销开关，两者不会并存）。
 * 文件名：拾光账单_YYYY-MM.xlsx（落地走 download.saveBlobFile：Web 浏览器下载 / Android 写 Documents+分享）。
 * xlsx 体积大（约 800KB），按需动态 import，Vite 自动拆为独立 chunk。
 */
import { saveBlobFile } from './download';
import { formatFen } from '../../core/money';
import { listEntries } from '../../core/repo/entryRepo';
import { listCategories } from '../../core/repo/categoryRepo';
import { listAccountsByGroup } from '../../core/repo/accountRepo';
import { listMerchants } from '../../core/repo/merchantRepo';
import { listTags, listEntryIdsByTag } from '../../core/repo/tagRepo';
import { ACCOUNT_GROUPS, LOAN_KIND_META, type Entry } from '../../core/types';
import { formatWacaiPair } from '../import/wacai';

/** 挖财 12 列表头（导入解析校验的同一份约定） */
export const WACAI_HEADERS = [
  '日期时间', '类型', '类别', '金额', '币种', '收付款人',
  '收付账户', '参与人', '标签', '商家', '属性', '备注',
] as const;

const TYPE_NAMES: Record<Entry['type'], string> = {
  expense: '支出', income: '收入', transfer: '转账', loan: '借贷',
};

/** 分（正整数）→ 元字符串（无千分位，两位小数），仅供导出单元格 */
function yuanText(fen: number): string {
  return formatFen(fen).replace(/,/g, '');
}

function dateText(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 借贷双账户按实际资金流向输出，供导出/导入往返保真。 */
export function wacaiLoanAccountText(
  entry: Pick<Entry, 'type' | 'loanKind' | 'fromAccountId' | 'toAccountId'>,
  accountNames: ReadonlyMap<number, string>,
  amountYuan: string,
): string {
  const fromName = entry.fromAccountId == null ? undefined : accountNames.get(entry.fromAccountId);
  const toName = entry.toAccountId == null ? undefined : accountNames.get(entry.toAccountId);
  if (entry.type !== 'loan' || !entry.loanKind || !fromName || !toName) {
    throw new Error('借贷账单缺少完整的双账户信息');
  }
  return `${formatWacaiPair(fromName, `-${amountYuan}`)}, ${formatWacaiPair(toName, `+${amountYuan}`)}`;
}

/**
 * 导出某月账单为 Excel 并落地为文件。
 * @param month 'YYYY-MM'
 * @returns 导出的账单条数
 */
export async function exportMonthExcel(month: string): Promise<number> {
  const XLSX = await import('xlsx');
  const [y, m] = month.split('-').map(Number);
  const from = new Date(y, m - 1, 1).getTime();
  const to = new Date(y, m, 1).getTime();
  const [entries, expCats, incCats, groups, merchants, tags] = await Promise.all([
    listEntries({ from, to }), listCategories('expense'), listCategories('income'),
    listAccountsByGroup(), listMerchants(), listTags(),
  ]);

  const catById = new Map(expCats.concat(incCats).map((c) => [c.id, c]));
  const acctName = new Map<number, string>();
  for (const g of ACCOUNT_GROUPS) for (const a of groups[g]) acctName.set(a.id, a.name);
  const merchantName = new Map(merchants.map((mm) => [mm.id, mm.name]));
  // 标签：tagId→name 与 entryId→names（经 tagRepo 反查，避免直查 db）
  const tagNamesByEntry = new Map<number, string[]>();
  for (const t of tags) {
    for (const eid of await listEntryIdsByTag(t.id)) {
      const arr = tagNamesByEntry.get(eid);
      if (arr) arr.push(t.name);
      else tagNamesByEntry.set(eid, [t.name]);
    }
  }

  /** 类别列：支出两级「大类/小类」、收入单级、转账固定、借贷为小类名 */
  const categoryText = (e: Entry): string => {
    if (e.type === 'transfer') return '转账';
    if (e.type === 'loan') return LOAN_KIND_META[e.loanKind!].name;
    const cat = e.categoryId != null ? catById.get(e.categoryId) : undefined;
    if (!cat) return e.type === 'income' ? '收入' : '支出';
    if (cat.parentId != null) {
      const parent = catById.get(cat.parentId);
      return parent ? `${parent.name}/${cat.name}` : cat.name;
    }
    return cat.name;
  };

  const rows = entries
    .slice()
    .sort((a, b) => a.occurredAt - b.occurredAt)
    .map((e) => {
      const amt = yuanText(e.amount);
      const payee = '';
      let account = '';
      if (e.type === 'transfer') {
        account = `${formatWacaiPair(acctName.get(e.fromAccountId ?? -1) ?? '', `-${amt}`)}, ${formatWacaiPair(acctName.get(e.toAccountId ?? -1) ?? '', `+${amt}`)}`;
      } else if (e.type === 'loan') {
        account = wacaiLoanAccountText(e, acctName, amt);
      } else {
        account = acctName.get(e.accountId ?? -1) ?? '';
      }
      return [
        dateText(e.occurredAt),
        TYPE_NAMES[e.type],
        categoryText(e),
        Number(amt),
        '人民币',
        payee,
        account,
        '自己',
        (tagNamesByEntry.get(e.id) ?? []).join(','),
        e.merchantId != null ? merchantName.get(e.merchantId) ?? '' : '',
        e.refundFlag ? '退款' : e.type === 'expense' && e.reimburseStatus === 'done' ? '已报销' : '',
        e.note ?? '',
      ];
    });

  const ws = XLSX.utils.aoa_to_sheet([[...WACAI_HEADERS], ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'sheet1');
  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
  await saveBlobFile(
    new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
    `拾光账单_${month}.xlsx`,
  );
  return rows.length;
}
