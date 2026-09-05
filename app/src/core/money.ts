/**
 * 拾光 · 金额换算（分 ↔ 元 唯一出入口）
 * 所有金额在数据层以「分」（整数）存储；任何 UI 展示与输入解析都必须经过本模块，
 * 严禁在业务代码中出现 `/100`、`*100` 或 toFixed 直接换算。
 */

/**
 * 把用户输入的元字符串解析为分（整数）。
 * 规则与原型一致：整数与小数合计最多 8 位数字，小数最多 2 位。
 * @param input 元字符串，如 '12.5'、'0.01'、'1,234.56'（容忍千分位逗号与前后空格）
 * @returns 分（非负整数）
 * @throws 输入非法（空、非数字、超位数、负数）时抛出 Error
 */
export function parseYuanToFen(input: string): number {
  const s = input.replace(/,/g, '').trim();
  if (!s) throw new Error('金额不能为空');
  if (!/^\d+(\.\d*)?$/.test(s)) throw new Error(`金额格式非法：${input}`);
  const [intPart, decPart = ''] = s.split('.');
  if (decPart.length > 2) throw new Error('小数最多 2 位');
  const digits = intPart.replace(/^0+(?=\d)/, '') + decPart;
  if (digits.replace(/^0+/, '').length > 8) throw new Error('整数与小数合计最多 8 位数字');
  const fen = Math.round(Number(intPart) * 100 + Number(decPart.padEnd(2, '0') || '0'));
  if (!Number.isSafeInteger(fen)) throw new Error(`金额超出范围：${input}`);
  return fen;
}

/**
 * 把分格式化为千分位、两位小数的元字符串。
 * @param fen 分（整数，可为负）
 * @param opts.sign true 时正数前加 '+'，负数天然带 '-'
 * @returns 如 '3,286.40'、'-1,200.00'、'+86.50'
 */
export function formatFen(fen: number, opts: { sign?: boolean } = {}): string {
  const neg = fen < 0;
  const abs = Math.abs(Math.round(fen));
  const yuan = Math.floor(abs / 100);
  const dec = String(abs % 100).padStart(2, '0');
  const grouped = yuan.toLocaleString('zh-CN');
  const body = `${grouped}.${dec}`;
  if (neg) return `-${body}`;
  return opts.sign ? `+${body}` : body;
}

/**
 * 带 ¥ 符号的格式化，负数为 '-¥xx'（对齐原型 fmtS）。
 * @param fen 分（整数，可为负）
 */
export function formatFenCny(fen: number): string {
  return fen < 0 ? `-¥${formatFen(-fen)}` : `¥${formatFen(fen)}`;
}
