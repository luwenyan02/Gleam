export type CalculatorOperator = '+' | '-' | '*' | '/';

export interface CalculatorState {
  amount: string;
  previous: number | null;
  operator: CalculatorOperator | null;
}

export const OPERATOR_SYMBOL: Record<CalculatorOperator, string> = {
  '+': ' + ', '-': ' − ', '*': ' × ', '/': ' ÷ ',
};

export function applyCalculation(state: CalculatorState): void {
  if (state.operator == null || state.previous == null) return;
  const current = Number.parseFloat(state.amount || '0');
  let result = state.previous;
  if (state.operator === '+') result = state.previous + current;
  else if (state.operator === '-') result = state.previous - current;
  else if (state.operator === '*') result = state.previous * current;
  else if (current !== 0) result = state.previous / current;
  result = Math.round(Math.max(0, result) * 100) / 100;
  state.amount = result ? String(result) : '';
  state.previous = null;
  state.operator = null;
}

export function chooseOperator(state: CalculatorState, operator: CalculatorOperator): void {
  if (state.operator != null && !state.amount) { state.operator = operator; return; }
  if (state.operator != null && state.amount) applyCalculation(state);
  if (!state.amount) return;
  state.previous = Number.parseFloat(state.amount);
  state.amount = '';
  state.operator = operator;
}

/** 追加数字或小数点；总计最多 8 位数字，小数最多 2 位。 */
export function appendDigit(state: CalculatorState, char: string): void {
  if (char === '.') {
    if (!state.amount.includes('.')) state.amount = (state.amount || '0') + '.';
    return;
  }
  if (!/^\d$/.test(char)) return;
  let next = state.amount + char;
  if (next.includes('.') && next.split('.')[1].length > 2) return;
  if (next.replace('.', '').length > 8) return;
  if (next.length > 1 && next[0] === '0' && next[1] !== '.') next = next.replace(/^0+/, '') || '0';
  state.amount = next;
}

export function deleteDigit(state: CalculatorState): void {
  if (state.amount) state.amount = state.amount.slice(0, -1);
  else if (state.operator != null) {
    state.amount = String(state.previous ?? '');
    state.previous = null;
    state.operator = null;
  }
}
