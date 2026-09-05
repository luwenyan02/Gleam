import { describe, expect, it } from 'vitest';
import {
  applyCalculation,
  appendDigit,
  chooseOperator,
  type CalculatorState,
} from '../src/features/entry/entryCalculator';

describe('记账计算器', () => {
  it('按从左到右规则连续计算并限制两位小数', () => {
    const state: CalculatorState = { amount: '12.5', previous: null, operator: null };
    chooseOperator(state, '+');
    appendDigit(state, '7');
    applyCalculation(state);
    expect(state).toEqual({ amount: '19.5', previous: null, operator: null });

    appendDigit(state, '.');
    appendDigit(state, '1');
    appendDigit(state, '2');
    appendDigit(state, '3');
    expect(state.amount).toBe('19.51');
  });

  it('除零不会产生无效金额', () => {
    const state: CalculatorState = { amount: '8', previous: null, operator: null };
    chooseOperator(state, '/');
    appendDigit(state, '0');
    applyCalculation(state);
    expect(state.amount).toBe('8');
  });
});
