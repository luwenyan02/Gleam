export type CalculatorOperator = '+' | '-' | '*' | '/';

export interface CalculatorState {
  amount: string;
  previous: number | null;
  /** 连续运算时保留操作符左侧的精确金额；旧调用方可省略。 */
  previousAmount?: string;
  operator: CalculatorOperator | null;
}

export const OPERATOR_SYMBOL: Record<CalculatorOperator, string> = {
  '+': ' + ', '-': ' − ', '*': ' × ', '/': ' ÷ ',
};

const CENTS_PER_YUAN = 100n;
const MAX_SAFE_CENTS = BigInt(Number.MAX_SAFE_INTEGER);

function parseAmountToCents(amount: string): bigint {
  const normalized = amount || '0';
  const match = /^(-?)(\d+)(?:\.(\d{0,2}))?$/.exec(normalized);
  if (!match) throw new Error(`金额格式非法：${amount}`);
  const fraction = (match[3] ?? '').padEnd(2, '0');
  const cents = BigInt(match[2]) * CENTS_PER_YUAN + BigInt(fraction || '0');
  return match[1] ? -cents : cents;
}

function numberToCents(amount: number): bigint {
  const cents = Math.round(amount * Number(CENTS_PER_YUAN));
  if (!Number.isFinite(amount) || !Number.isSafeInteger(cents)) {
    throw new Error('计算结果超出安全范围');
  }
  return BigInt(cents);
}

/** 精确执行 Math.round(numerator / denominator)，半值向正无穷方向取整。 */
function roundRational(numerator: bigint, denominator: bigint): bigint {
  if (denominator < 0n) return roundRational(-numerator, -denominator);
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder >= 0n) {
    return quotient + (remainder * 2n >= denominator ? 1n : 0n);
  }
  return quotient - (-remainder * 2n > denominator ? 1n : 0n);
}

function formatCents(cents: bigint): string {
  const sign = cents < 0n ? '-' : '';
  const absolute = cents < 0n ? -cents : cents;
  const yuan = absolute / CENTS_PER_YUAN;
  const fraction = absolute % CENTS_PER_YUAN;
  if (fraction === 0n) return `${sign}${yuan}`;
  if (fraction % 10n === 0n) return `${sign}${yuan}.${fraction / 10n}`;
  return `${sign}${yuan}.${String(fraction).padStart(2, '0')}`;
}

export function applyCalculation(state: CalculatorState): void {
  if (state.operator == null || (state.previousAmount == null && state.previous == null)) return;
  const previous = state.previousAmount == null
    ? numberToCents(state.previous!)
    : parseAmountToCents(state.previousAmount);
  const current = parseAmountToCents(state.amount);
  if (state.operator === '/' && current === 0n) throw new Error('除数不能为零');
  let result: bigint;
  if (state.operator === '+') result = previous + current;
  else if (state.operator === '-') result = previous - current;
  else if (state.operator === '*') result = roundRational(previous * current, CENTS_PER_YUAN);
  else result = roundRational(previous * CENTS_PER_YUAN, current);
  if (result > MAX_SAFE_CENTS || result < -MAX_SAFE_CENTS) {
    throw new Error('计算结果超出安全范围');
  }
  state.amount = formatCents(result);
  state.previous = null;
  delete state.previousAmount;
  state.operator = null;
}

export function chooseOperator(state: CalculatorState, operator: CalculatorOperator): void {
  if (state.operator != null && !state.amount) { state.operator = operator; return; }
  if (state.operator != null && state.amount) applyCalculation(state);
  if (!state.amount) return;
  state.previous = Number.parseFloat(state.amount);
  state.previousAmount = state.amount;
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
    state.amount = state.previousAmount ?? String(state.previous ?? '');
    state.previous = null;
    delete state.previousAmount;
    state.operator = null;
  }
}
