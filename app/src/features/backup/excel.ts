/**
 * 拾光 · Excel 导出（features/backup/excel）
 * 生成与挖财模版完全同构的 12 列工作表：
 * 日期时间 / 类型 / 类别 / 金额 / 币种 / 收付款人 / 收付账户 / 参与人 / 标签 / 商家 / 属性 / 备注。
 * 与 features/import 的挖财解析互逆：
 * - 转账「收付账户」输出「A:-x.xx, B:+x.xx」；
 * - 借贷「收付款人」输出方向格式（借出/还款 = 自己:-x, 对方:+x；借入/收款 = 对方:-x, 自己:+x）；
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
import { listLoanContacts } from '../../core/repo/loanRepo';
import { listMerchants } from '../../core/repo/merchantRepo';
import { listTags, listEntryIdsByTag } from '../../core/repo/tagRepo';
import { ACCOUNT_GROUPS, LOAN_KIND_META, type Entry } from '../../core/types';

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
  const [entries, expCats, incCats, groups, contacts, merchants, tags] = await Promise.all([
    listEntries({ from, to }), listCategories('expense'), listCategories('income'),
    listAccountsByGroup(), listLoanContacts(), listMerchants(), listTags(),
  ]);

  const catById = new Map(expCats.concat(incCats).map((c) => [c.id, c]));
  const acctName = new Map<number, string>();
  for (const g of ACCOUNT_GROUPS) for (const a of groups[g]) acctName.set(a.id, a.name);
  const contactName = new Map(contacts.map((c) => [c.id, c.name]));
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
      let payee = '';
      let account = '';
      if (e.type === 'transfer') {
        account = `${acctName.get(e.fromAccountId ?? -1) ?? ''}:-${amt}, ${acctName.get(e.toAccountId ?? -1) ?? ''}:+${amt}`;
      } else {
        account = acctName.get(e.accountId ?? -1) ?? '';
      }
      if (e.type === 'loan') {
        const other = contactName.get(e.loanContactId ?? -1) ?? '未指明对象';
        // 借出/还款 = 资金流出（自己:-）；借入/收款 = 资金流入（自己:+）
        payee = e.loanKind === 'lend' || e.loanKind === 'repay'
          ? `自己:-${amt}, ${other}:+${amt}`
          : `${other}:-${amt}, 自己:+${amt}`;
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
