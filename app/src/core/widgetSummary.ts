import { formatFen } from './money';

export function widgetSummary(input: {expense: number; budget?: number; from: number; to: number; locked: boolean; now: number}) {
  return {
    expense: input.locked ? '••••' : formatFen(input.expense),
    remaining: input.locked ? '••••' : input.budget == null ? '未设置' : formatFen(input.budget - input.expense),
    from: input.from, to: input.to, updatedAt: input.now, private: input.locked,
  };
}
