import { formatFen } from '../../core/money';

/** 七列日历只显示紧凑绝对值；方向与完整金额由日期按钮和当日汇总提供。 */
export function compactCalendarAmount(fen: number): string {
  const yuan = Number(formatFen(Math.abs(fen)).replaceAll(',', ''));
  if (yuan < 1) return String(yuan);
  if (yuan < 10_000) return String(Math.floor(yuan));
  const units: [number, string][] = [[1_000_000_000_000, '万亿'], [100_000_000, '亿'], [10_000, '万']];
  const [scale, unit] = units.find(([minimum]) => yuan >= minimum)!;
  const scaled = yuan / scale;
  const value = Number(scaled.toFixed(scaled < 100 && unit !== '万亿' ? 1 : 0));
  // 四位数进位后改用更高单位，避免「10000万」撑出七列格子。
  if (value >= 10_000 && unit === '万') return '1亿';
  if (value >= 10_000 && unit === '亿') return '1万亿';
  return `${value}${unit}`;
}
