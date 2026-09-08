import { describe, expect, it } from 'vitest';
import {
  applyCalculation,
  appendDigit,
  chooseOperator,
  deleteDigit,
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

  it('除零时拒绝计算并保留原运算状态', () => {
    const state: CalculatorState = { amount: '8', previous: null, operator: null };
    chooseOperator(state, '/');
    appendDigit(state, '0');
    expect(() => applyCalculation(state)).toThrow('除数不能为零');
    expect(state).toEqual({ amount: '0', previous: 8, previousAmount: '8', operator: '/' });
  });

  it('负中间值可继续按从左到右规则计算', () => {
    const state: CalculatorState = { amount: '5', previous: null, operator: null };
    chooseOperator(state, '-');
    appendDigit(state, '8');
    chooseOperator(state, '+');
    appendDigit(state, '1');
    appendDigit(state, '0');
    applyCalculation(state);
    expect(state.amount).toBe('7');
  });

  it('最终负值保留符号交由保存层拒绝', () => {
    const state: CalculatorState = { amount: '5', previous: null, operator: null };
    chooseOperator(state, '-');
    appendDigit(state, '8');
    applyCalculation(state);
    expect(state.amount).toBe('-3');
  });

  it('零中间值可继续参与乘法', () => {
    const state: CalculatorState = { amount: '5', previous: null, operator: null };
    chooseOperator(state, '-');
    appendDigit(state, '5');
    chooseOperator(state, '*');
    appendDigit(state, '1');
    appendDigit(state, '0');
    applyCalculation(state);
    expect(state.amount).toBe('0');
  });

  it('零中间值可继续参与减法', () => {
    const state: CalculatorState = { amount: '5', previous: null, operator: null };
    chooseOperator(state, '-');
    appendDigit(state, '5');
    chooseOperator(state, '-');
    appendDigit(state, '2');
    applyCalculation(state);
    expect(state.amount).toBe('-2');
  });

  it('精确按 Math.round 的正半值规则保留两位小数', () => {
    const state: CalculatorState = { amount: '2.01', previous: null, operator: null };
    chooseOperator(state, '/');
    appendDigit(state, '2');
    applyCalculation(state);
    expect(state.amount).toBe('1.01');
  });

  it('超大中间结果连续运算仍保留每一分', () => {
    const state: CalculatorState = { amount: '50000000', previous: null, operator: null };
    chooseOperator(state, '*');
    for (const digit of '900000') appendDigit(state, digit);
    applyCalculation(state);
    expect(state.amount).toBe('45000000000000');
    expect(state.previousAmount).toBeUndefined();

    chooseOperator(state, '+');
    expect(state.previousAmount).toBe('45000000000000');
    for (const digit of '0.02') appendDigit(state, digit);
    applyCalculation(state);
    expect(state.amount).toBe('45000000000000.02');
    expect(state.previousAmount).toBeUndefined();

    chooseOperator(state, '+');
    expect(state.previousAmount).toBe('45000000000000.02');
    appendDigit(state, '0');
    applyCalculation(state);
    expect(state.amount).toBe('45000000000000.02');
    expect(state.previousAmount).toBeUndefined();
  });

  it('除零后可删除零并更换除数继续计算', () => {
    const state: CalculatorState = { amount: '8', previous: null, operator: null };
    chooseOperator(state, '/');
    appendDigit(state, '0');
    expect(() => applyCalculation(state)).toThrow('除数不能为零');
    deleteDigit(state);
    appendDigit(state, '2');
    applyCalculation(state);
    expect(state.amount).toBe('4');
  });

  it('退格撤销算符时恢复原金额并清理中间状态', () => {
    const state: CalculatorState = { amount: '12.34', previous: null, operator: null };
    chooseOperator(state, '+');
    deleteDigit(state);
    expect(state).toEqual({ amount: '12.34', previous: null, operator: null });
  });

  it('旧调用方未传精确文本时仍从 previous 计算', () => {
    const state: CalculatorState = { amount: '2', previous: 8, operator: '/' };
    applyCalculation(state);
    expect(state.amount).toBe('4');
  });
});
