/**
 * 构成图与排行共用正净额基数；退款超过本项支出时，负净额单列而非负占比。
 * 仅计算展示口径，不修改账务金额。正净额 - 退款净额 = 当前维度净额。
 */
export function positiveComposition(rows: readonly { amount: number }[]): { positive: number; refund: number; net: number } {
  let positive = 0, refund = 0;
  for (const { amount } of rows) {
    if (amount > 0) positive += amount;
    else refund -= amount;
  }
  return { positive, refund, net: positive - refund };
}

export function compositionPercent(amount: number, positive: number): number | null {
  return amount > 0 && positive > 0 ? (amount / positive) * 100 : null;
}
