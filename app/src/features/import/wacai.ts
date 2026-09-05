/**
 * 拾光 · 挖财 Excel 解析器（features/import/wacai）
 * 严格按《拾光-挖财账单导入设计》12 列逐列解析：
 * - 表头须与挖财模版一致（列名 trim 后比对），否则拒绝整个文件；
 * - 日期时间：Excel 序列值或文本，精确到分钟；
 * - 类型列分派四分支（支出/收入/转账/借贷）；
 * - 类别「大类/小类」斜杠拆分；借贷行类别即借入/借出/还款/收款；
 * - 外币按内置参考汇率折算人民币，备注追加原币种金额说明；
 * - 收付款人（借贷）「张三:+100.00」解析往来对象；全角冒号/逗号一律兼容；
 * - 收付账户（转账）「现金:-1.00, 微信钱包:+1.00」正负拆转出/转入并与金额互校；
 * - 参与人多人分摊只按「自己」份额入账，完整明细追加备注；
 * - 标签逗号拆分；属性「已报销」→ 报销状态；属性「退款」按普通支出入账并在备注保留标注；
 *   其余无对应字段并入备注不丢信息；
 * - 支出「利息支出」归「其他/利息」（PRD 附录 A 约定）。
 */
import { parseYuanToFen } from '../../core/money';
import type { EntryType, LoanKind } from '../../core/types';

/** 挖财 12 列表头（与导出模块同一约定） */
const HEADERS = [
  '日期时间', '类型', '类别', '金额', '币种', '收付款人',
  '收付账户', '参与人', '标签', '商家', '属性', '备注',
];

/** 外币参考汇率表（1 外币 ≈ x 人民币；导入时参考汇率，备注中注明） */
const FX_RATES: Record<string, number> = {
  美元: 7.14, 港币: 0.92, 港元: 0.92, 欧元: 7.8, 日元: 0.048, 英镑: 9.1,
  台币: 0.22, 新台币: 0.22, 澳元: 4.7, 加元: 5.2, 新加坡元: 5.3, 韩元: 0.0052, 泰铢: 0.2,
};

const LOAN_KIND_BY_NAME: Record<string, LoanKind> = {
  借入: 'borrow', 借出: 'lend', 还款: 'repay', 收款: 'collect',
};

/** 解析后的一行（尚未映射到库内 id） */
export interface WacaiRow {
  /** Excel 行号（1 起，含表头行） */
  rowNo: number;
  type: EntryType;
  occurredAt: number;
  /** 入账金额（分，人民币；分摊/折算后） */
  amountFen: number;
  /** 类别键：支出「大类/小类」或单级名；收入为名称；转账/借贷为空 */
  categoryKey?: string;
  loanKind?: LoanKind;
  /** 借贷往来对象名（缺失时兜底「未指明对象」） */
  contactName?: string;
  /** 支出/收入/借贷的账户名 */
  accountName?: string;
  /** 转账转出/转入账户名 */
  fromAccountName?: string;
  toAccountName?: string;
  tags: string[];
  merchant?: string;
  /** 属性「已报销」（仅支出生效） */
  reimburseDone: boolean;
  /** 最终备注（原备注 + 追加说明） */
  note: string;
}

export interface ParseIssue {
  rowNo: number;
  message: string;
}

export interface WacaiParseResult {
  rows: WacaiRow[];
  /** 格式异常行（跳过导入） */
  issues: ParseIssue[];
  counts: { expense: number; income: number; transfer: number; loan: number };
  /** 出现过的类别键（去重，供映射步骤比对） */
  categoryKeys: string[];
  /** 出现过的账户名（去重） */
  accountNames: string[];
}

/* ── 单列解析工具 ── */

/** Excel 序列值 → 本地时间毫秒（按 UTC 分量重建，取整到分钟） */
function serialToMs(serial: number): number {
  const utc = new Date(Math.round((serial - 25569) * 86400000));
  const d = new Date(
    utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate(),
    utc.getUTCHours(), utc.getUTCMinutes(), 0, 0,
  );
  return d.getTime();
}

/** 日期时间列：序列值或文本（YYYY-MM-DD HH:mm / YYYY/M/D H:mm），失败返回 undefined */
function parseDateTime(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return serialToMs(v);
  if (typeof v === 'string') {
    const s = v.trim().replace(/\//g, '-');
    const m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{1,2}))?/.exec(s);
    if (!m) return undefined;
    const d = new Date(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), 0, 0);
    return Number.isFinite(d.getTime()) ? d.getTime() : undefined;
  }
  return undefined;
}

/** 金额单元格（数字或数字文本，保留两位）→ 分；非法抛错 */
function cellToFen(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[,，\s]/g, ''));
  if (!Number.isFinite(n) || n < 0) throw new Error(`金额非法：${String(v)}`);
  return parseYuanToFen(n.toFixed(2));
}

/** 「名字:±金额」清单解析（兼容全角冒号/逗号），如「自己:-100.00，张三:+100.00」 */
function parsePairs(text: string): { name: string; signedFen: number }[] {
  return text.split(/[,，]/).map((seg) => seg.trim()).filter(Boolean).map((seg) => {
    const idx = seg.search(/[:：]/);
    if (idx < 0) return { name: seg, signedFen: NaN };
    const name = seg.slice(0, idx).trim();
    const amtText = seg.slice(idx + 1).trim();
    const sign = amtText.startsWith('-') ? -1 : 1;
    const numText = amtText.replace(/^[+-]/, '');
    let fen = NaN;
    try { fen = parseYuanToFen(numText); } catch { /* 保留 NaN，由调用方判断 */ }
    return { name, signedFen: sign * fen };
  });
}

function cellText(v: unknown): string {
  if (v == null) return '';
  return String(v).trim();
}

/* ── 主解析 ── */

/**
 * 读取挖财 Excel 文件并逐行解析。
 * @throws Error 首行表头与挖财 12 列不匹配时拒绝整个文件
 */
export async function parseWacaiFile(file: File): Promise<WacaiParseResult> {
  const XLSX = await import('xlsx'); // 按需加载（约 800KB），Vite 自动拆包
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) throw new Error('文件中没有工作表');
  const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: null });
  if (!grid.length) throw new Error('工作表为空');

  const header = (grid[0] ?? []).map((c) => cellText(c));
  for (let i = 0; i < HEADERS.length; i++) {
    if (header[i] !== HEADERS[i]) {
      throw new Error(`表头与挖财模版不符：第 ${i + 1} 列应为「${HEADERS[i]}」，实际为「${header[i] || '空'}」`);
    }
  }

  const rows: WacaiRow[] = [];
  const issues: ParseIssue[] = [];
  const counts = { expense: 0, income: 0, transfer: 0, loan: 0 };
  const categoryKeys = new Set<string>();
  const accountNames = new Set<string>();

  for (let r = 1; r < grid.length; r++) {
    const raw = grid[r] ?? [];
    const rowNo = r + 1;
    // 空行（全部空或仅空白）跳过，不计异常
    if (raw.every((c) => cellText(c) === '')) continue;

    try {
      const [cDate, cType, cCat, cAmt, cCur, cPayee, cAcct, cPart, cTags, cMerchant, cAttr, cNote] =
        raw.map((c) => c);
      const noteParts: string[] = [];
      const baseNote = cellText(cNote);

      const occurredAt = parseDateTime(cDate);
      if (occurredAt === undefined) throw new Error(`日期时间无法解析：${cellText(cDate)}`);

      const typeName = cellText(cType);
      const type: EntryType | undefined = ({ 支出: 'expense', 收入: 'income', 转账: 'transfer', 借贷: 'loan' } as const)[
        typeName as '支出' | '收入' | '转账' | '借贷'
      ];
      if (!type) throw new Error(`未知类型：${typeName || '空'}`);

      // 金额 + 币种：外币按参考汇率折算，备注保留原币种金额
      let amountFen = cellToFen(cAmt);
      const currency = cellText(cCur);
      if (currency && currency !== '人民币' && currency !== 'CNY') {
        const rate = FX_RATES[currency];
        if (!rate) throw new Error(`不支持的币种：${currency}`);
        const originYuan = (amountFen / 100).toFixed(2);
        amountFen = Math.round(amountFen * rate);
        noteParts.push(`原币种 ${currency} ${originYuan}，按导入时参考汇率 ${rate} 折算`);
      }
      if (amountFen <= 0) throw new Error('金额须大于 0');

      const catText = cellText(cCat);
      const acctText = cellText(cAcct);
      const payeeText = cellText(cPayee);
      const partText = cellText(cPart);
      const attrText = cellText(cAttr);

      const row: WacaiRow = {
        rowNo, type, occurredAt, amountFen, tags: [], reimburseDone: false, note: '',
      };

      /* 类型四分支 */
      if (type === 'transfer') {
        // 转账：收付账户「A:-1.00, B:+1.00」正负拆转出/转入
        const pairs = parsePairs(acctText);
        const fromP = pairs.find((p) => p.signedFen < 0);
        const toP = pairs.find((p) => p.signedFen > 0);
        if (!fromP || !toP) throw new Error(`转账收付账户无法解析：${acctText}`);
        row.fromAccountName = fromP.name;
        row.toAccountName = toP.name;
        accountNames.add(fromP.name);
        accountNames.add(toP.name);
        // 与金额列互校：转出腿须等于金额；转入腿不等（换汇）时记备注
        if (Math.abs(fromP.signedFen) !== amountFen) {
          throw new Error(`转账转出金额 ${Math.abs(fromP.signedFen) / 100} 与金额列不符`);
        }
        if (toP.signedFen !== amountFen) {
          noteParts.push(`转入账户到账 ${(toP.signedFen / 100).toFixed(2)}（原表转入腿与转出金额不同）`);
        }
        // 转账行无类别能力字段：非「转账」的类别并入备注
        if (catText && catText !== '转账') noteParts.push(`类别：${catText}`);
        if (payeeText) noteParts.push(`收付款人：${payeeText}`);
      } else if (type === 'loan') {
        // 借贷：类别列即借入/借出/还款/收款；收付款人解析往来对象
        const kind = LOAN_KIND_BY_NAME[catText];
        if (!kind) throw new Error(`借贷类别无法识别：${catText || '空'}`);
        row.loanKind = kind;
        if (!acctText) throw new Error('借贷行缺少收付账户');
        row.accountName = acctText;
        accountNames.add(acctText);
        const other = parsePairs(payeeText).find((p) => p.name && p.name !== '自己');
        row.contactName = other?.name ?? '未指明对象';
        if (!other && payeeText) noteParts.push(`收付款人：${payeeText}`);
      } else {
        // 支出 / 收入
        if (!acctText) throw new Error(`${typeName}行缺少收付账户`);
        row.accountName = acctText;
        accountNames.add(acctText);
        // 类别：支出「利息支出」归「其他/利息」（附录 A）；其余原样为键
        let key = catText;
        if (type === 'expense' && (key === '利息支出' || key === '利息')) key = '其他/利息';
        if (!key) throw new Error('缺少类别');
        row.categoryKey = key;
        categoryKeys.add(`${type}:${key}`);
        // 参与人多人分摊：只按「自己」份额入账，完整明细进备注
        if (partText && /[:：]/.test(partText)) {
          const shares = parsePairs(partText);
          if (shares.length > 1 || (shares.length === 1 && shares[0].name !== '自己')) {
            const self = shares.find((p) => p.name === '自己');
            const selfFen = self && Number.isFinite(self.signedFen) ? Math.abs(self.signedFen) : 0;
            if (selfFen <= 0) throw new Error(`分摊中「自己」份额无法解析：${partText}`);
            noteParts.push(`分摊明细：${partText}（原总额 ${(amountFen / 100).toFixed(2)}）`);
            row.amountFen = selfFen;
          }
        }
        // 非借贷行收付款人无对应字段 → 备注
        if (payeeText) noteParts.push(`收付款人：${payeeText}`);
        // 属性「已报销」仅标记状态：导出文件无到账账户/金额，入库时不产生到账余额效果（见 import.ts rowToEntry）
        if (type === 'expense' && attrText === '已报销') row.reimburseDone = true;
        // 属性「退款」（拾光导出的退款记录）：跨文件无法还原与原支出的关联（refundOfEntryId 丢失），
        // 按普通支出入账，仅在备注保留标注，属预期局限；不影响查重（查重只看时间/类型/金额/账户）
        if (type === 'expense' && attrText === '退款') {
          noteParts.push('属性：退款（原为退款记录，跨文件导入无法还原关联，已按普通支出入账）');
        }
      }

      // 标签 / 商家 / 属性（未消化的取值并入备注）
      row.tags = cellText(cTags).split(/[,，]/).map((s) => s.trim()).filter(Boolean);
      row.merchant = cellText(cMerchant) || undefined;
      if (attrText && !(row.type === 'expense' && (attrText === '已报销' || attrText === '退款'))) {
        noteParts.push(`属性：${attrText}`);
      }
      row.note = [baseNote, ...noteParts].filter(Boolean).join('；');

      rows.push(row);
      counts[type]++;
    } catch (err) {
      issues.push({ rowNo, message: err instanceof Error ? err.message : String(err) });
    }
  }

  return {
    rows, issues, counts,
    categoryKeys: [...categoryKeys],
    accountNames: [...accountNames],
  };
}
