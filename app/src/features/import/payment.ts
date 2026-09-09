/** 微信支付 / 支付宝本地导出文件适配器。只接纳方向明确且已完成的普通收支。 */
import { parseYuanToFen } from '../../core/money';
import type { ImportSource, ParseIssue, WacaiParseResult, WacaiRow } from './wacai';

type PaymentSource = Exclude<ImportSource, 'wacai'>;

const HEADER_ALIASES = {
  occurredAt: ['付款时间', '交易时间', '交易创建时间'],
  kind: ['交易类型', '类型', '交易分类'],
  category: ['交易分类'],
  counterparty: ['交易对方', '收付款人'],
  product: ['商品说明', '商品名称', '商品'],
  direction: ['收/支', '收支'],
  amount: ['金额（元）', '金额(元)', '金额'],
  account: ['收/付款方式', '支付方式', '付款方式'],
  status: ['交易状态', '当前状态', '状态'],
  externalId: ['交易订单号', '交易单号', '交易号'],
  merchantOrderId: ['商家订单号', '商户单号'],
  note: ['备注'],
  refund: ['成功退款（元）', '成功退款(元)', '退款金额（元）', '退款金额(元)'],
} as const;

type HeaderField = keyof typeof HEADER_ALIASES;
type HeaderIndex = Partial<Record<HeaderField, number>>;

function normalizeHeader(value: unknown): string {
  return String(value ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/[\s　]+/g, '')
    .replace(/：$/, ':')
    .trim();
}

function text(value: unknown): string {
  return String(value ?? '').replace(/^\uFEFF/, '').trim();
}

function findHeader(grid: unknown[][]): { rowIndex: number; index: HeaderIndex } {
  for (let rowIndex = 0; rowIndex < grid.length; rowIndex++) {
    const headers = grid[rowIndex].map(normalizeHeader);
    const index: HeaderIndex = {};
    for (const [field, aliases] of Object.entries(HEADER_ALIASES) as [HeaderField, readonly string[]][]) {
      const found = headers.findIndex((header) => aliases.some((alias) => normalizeHeader(alias) === header));
      if (found >= 0) index[field] = found;
    }
    if (index.occurredAt != null && index.direction != null && index.amount != null && index.status != null) {
      return { rowIndex, index };
    }
  }
  throw new Error('未找到微信或支付宝账单明细表头，请选择解压后的 CSV / Excel 明细文件');
}

function parseCsv(content: string): string[][] {
  const firstLines = content.split(/\r?\n/, 12);
  const comma = firstLines.reduce((sum, line) => sum + (line.match(/,/g)?.length ?? 0), 0);
  const tab = firstLines.reduce((sum, line) => sum + (line.match(/\t/g)?.length ?? 0), 0);
  const delimiter = tab > comma ? '\t' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    if (quoted) {
      if (char === '"' && content[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === delimiter) {
      row.push(cell);
      cell = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && content[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function decodeText(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('gb18030').decode(bytes);
  }
}

async function readGrid(file: File): Promise<unknown[][]> {
  const buffer = await file.arrayBuffer();
  if (/\.xlsx?$/i.test(file.name)) {
    const XLSX = await import('xlsx');
    const workbook = XLSX.read(buffer, { type: 'array' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    if (!sheet) throw new Error('文件中没有工作表');
    return XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: '' });
  }
  return parseCsv(decodeText(buffer));
}

function parseDateTime(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const utc = new Date(Math.round((value - 25569) * 86400000));
    return new Date(
      utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate(),
      utc.getUTCHours(), utc.getUTCMinutes(), utc.getUTCSeconds(), 0,
    ).getTime();
  }
  const raw = text(value).replace(/\//g, '-');
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/.exec(raw);
  if (!match) throw new Error(`交易时间无法解析：${raw || '空'}`);
  const [year, month, day, hour, minute, second] = [
    +match[1], +match[2], +match[3], +(match[4] ?? 0), +(match[5] ?? 0), +(match[6] ?? 0),
  ];
  const date = new Date(year, month - 1, day, hour, minute, second, 0);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day
    || date.getHours() !== hour || date.getMinutes() !== minute || date.getSeconds() !== second) {
    throw new Error(`交易时间不是有效日期：${raw}`);
  }
  return date.getTime();
}

function amountFen(value: unknown, allowZero = false): number {
  const raw = text(value).replace(/[¥￥,，\s]/g, '').replace(/^\+/, '');
  if (!raw && allowZero) return 0;
  const amount = parseYuanToFen(raw || '0');
  if (amount < 0 || (!allowZero && amount === 0)) throw new Error('金额须大于 0');
  return amount;
}

function paymentAccount(source: PaymentSource, value: string): string {
  const raw = value.replace(/^\//, '').trim();
  if (source === 'wechat') {
    if (!raw || raw === '零钱') return '微信零钱';
    if (raw === '零钱通') return '微信零钱通';
    return raw;
  }
  if (!raw || raw === '余额') return '支付宝余额';
  return raw;
}

function isNeutral(source: PaymentSource, kind: string, direction: string): boolean {
  if (!/^(支出|收入)$/.test(direction)) return true;
  if (source === 'wechat' && /零钱(充值|提现)|信用卡还款|理财通|零钱通(转入|转出)/.test(kind)) return true;
  if (source === 'alipay' && /余额宝(转入|转出)|充值|提现/.test(kind)) return true;
  return false;
}

function invalidStatus(status: string): string | undefined {
  if (/退款/.test(status)) return '退款交易缺少可核对的原账单关联，默认不导入';
  if (/关闭|失败|撤销|未支付|等待|处理中/.test(status)) return `交易状态为「${status}」，不是已完成收支`;
  return undefined;
}

function cell(row: unknown[], index: HeaderIndex, field: HeaderField): string {
  const column = index[field];
  return column == null ? '' : text(row[column]);
}

function noteFor(row: unknown[], index: HeaderIndex, source: PaymentSource): string {
  const pieces: string[] = [];
  const product = cell(row, index, 'product');
  const kind = cell(row, index, 'kind');
  const category = cell(row, index, 'category');
  const note = cell(row, index, 'note');
  const merchantOrderId = cell(row, index, 'merchantOrderId');
  if (product) pieces.push(`商品：${product}`);
  if (kind && kind !== category) pieces.push(`交易类型：${kind}`);
  if (category) pieces.push(`交易分类：${category}`);
  if (note) pieces.push(note);
  if (merchantOrderId) pieces.push(`${source === 'wechat' ? '商户' : '商家'}订单号：${merchantOrderId}`);
  return pieces.join('；');
}

/** 解析微信支付或支付宝本地导出的 CSV / Excel 明细。 */
export async function parsePaymentFile(file: File, source: PaymentSource): Promise<WacaiParseResult> {
  const grid = await readGrid(file);
  const { rowIndex: headerRow, index } = findHeader(grid);
  const rows: WacaiRow[] = [];
  const issues: ParseIssue[] = [];
  const counts = { expense: 0, income: 0, transfer: 0, loan: 0 };
  const categoryKeys = new Set<string>();
  const accountNames = new Set<string>();

  for (let rowIndex = headerRow + 1; rowIndex < grid.length; rowIndex++) {
    const raw = grid[rowIndex] ?? [];
    if (raw.every((value) => !text(value))) continue;
    const rowNo = rowIndex + 1;
    try {
      const status = cell(raw, index, 'status');
      const statusError = invalidStatus(status);
      if (statusError) throw new Error(statusError);
      const refund = cell(raw, index, 'refund');
      if (refund && amountFen(refund, true) > 0) {
        throw new Error(`成功退款 ${refund} 元，但缺少可核对的原账单关联，默认不导入`);
      }
      const direction = cell(raw, index, 'direction').replace(/\s/g, '');
      const kind = cell(raw, index, 'kind');
      if (isNeutral(source, kind, direction)) {
        throw new Error(`${direction || kind || '该行'}属于中性或账户间资金流转，缺少双账户信息，默认不导入`);
      }
      const type = direction === '支出' ? 'expense' : 'income';
      const categoryKey = type === 'expense'
        ? `其他/${source === 'wechat' ? '微信支付' : '支付宝账单'}`
        : '其他收入';
      const accountName = paymentAccount(source, cell(raw, index, 'account'));
      const counterparty = cell(raw, index, 'counterparty');
      const parsed: WacaiRow = {
        rowNo,
        source,
        externalId: cell(raw, index, 'externalId') || undefined,
        type,
        occurredAt: parseDateTime(raw[index.occurredAt!]),
        amountFen: amountFen(raw[index.amount!]),
        categoryKey,
        accountName,
        tags: [],
        merchant: counterparty || undefined,
        reimburseDone: false,
        note: noteFor(raw, index, source),
      };
      rows.push(parsed);
      counts[type]++;
      categoryKeys.add(`${type}:${categoryKey}`);
      accountNames.add(accountName);
    } catch (error) {
      issues.push({ rowNo, message: error instanceof Error ? error.message : String(error) });
    }
  }

  return {
    source,
    rows,
    issues,
    counts,
    categoryKeys: [...categoryKeys],
    accountNames: [...accountNames],
  };
}
