import { describe, expect, it } from 'vitest';
import {
  amountInWords,
  applyBp,
  formatPaisa,
  numberToWordsPk,
  paisaToInput,
  parseRupeesToPaisa,
  roundDiv,
  spreadLargestRemainder,
} from './money';

describe('roundDiv (half-up)', () => {
  it('rounds halves away from zero', () => {
    expect(roundDiv(5, 2)).toBe(3);
    expect(roundDiv(4, 2)).toBe(2);
    expect(roundDiv(7, 3)).toBe(2);
    expect(roundDiv(8, 3)).toBe(3);
    expect(roundDiv(-5, 2)).toBe(-3);
    expect(roundDiv(-7, 3)).toBe(-2);
  });
  it('refuses floats and division by zero', () => {
    expect(() => roundDiv(1.5, 1)).toThrow();
    expect(() => roundDiv(1, 0)).toThrow();
  });
});

describe('applyBp', () => {
  it('works on line totals: 1,000 at 12% and 10%', () => {
    expect(applyBp(100_000, 1200)).toBe(12_000);
    expect(applyBp(100_000, 1000)).toBe(10_000);
  });
  it('rounds to the nearest paisa', () => {
    // 3 × Rs 333.33 = 99999 paisa; 12.5% = 12499.875 -> 12500
    expect(applyBp(99_999, 1250)).toBe(12_500);
    // 0.5 paisa rounds up
    expect(applyBp(50, 100)).toBe(1);
    expect(applyBp(49, 100)).toBe(0);
  });
});

describe('spreadLargestRemainder', () => {
  it('always sums exactly to the total', () => {
    const parts = spreadLargestRemainder(10_000, [33_333, 33_333, 33_334]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(10_000);
    expect(parts).toEqual([3333, 3333, 3334]);
  });
  it('gives leftover paisa to the largest remainders, ties to the earlier line', () => {
    expect(spreadLargestRemainder(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(spreadLargestRemainder(1, [5, 5])).toEqual([1, 0]);
  });
  it('handles zero weights, negatives and empty input', () => {
    expect(spreadLargestRemainder(10, [0, 0])).toEqual([5, 5]);
    expect(spreadLargestRemainder(-100, [1, 1, 1])).toEqual([-34, -33, -33]);
    expect(spreadLargestRemainder(0, [3, 4])).toEqual([0, 0]);
    expect(spreadLargestRemainder(5, [])).toEqual([]);
  });
  it('works on many random cases', () => {
    for (let i = 0; i < 200; i++) {
      const weights = Array.from({ length: 1 + (i % 7) }, (_, j) => ((i * 7919 + j * 104_729) % 100_000) + 1);
      const total = (i * 31_337) % 500_000;
      const parts = spreadLargestRemainder(total, weights);
      expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
      expect(parts.every((p) => Number.isInteger(p) && p >= 0)).toBe(true);
    }
  });
});

describe('formatPaisa', () => {
  it('formats with grouping and hides zero paisa', () => {
    expect(formatPaisa(123_456_700)).toBe('Rs 1,234,567');
    expect(formatPaisa(123_450)).toBe('Rs 1,234.50');
    expect(formatPaisa(5)).toBe('Rs 0.05');
    expect(formatPaisa(0)).toBe('Rs 0');
    expect(formatPaisa(-50_000)).toBe('-Rs 500');
  });
  it('paisaToInput gives editable text', () => {
    expect(paisaToInput(123_450)).toBe('1234.5');
    expect(paisaToInput(100_000)).toBe('1000');
    expect(paisaToInput(-105)).toBe('-1.05');
  });
});

describe('parseRupeesToPaisa', () => {
  it('parses typed rupees', () => {
    expect(parseRupeesToPaisa('1,234')).toBe(123_400);
    expect(parseRupeesToPaisa('1234.5')).toBe(123_450);
    expect(parseRupeesToPaisa('Rs 1,234.50')).toBe(123_450);
    expect(parseRupeesToPaisa('0.01')).toBe(1);
  });
  it('handles negatives only when allowed', () => {
    expect(parseRupeesToPaisa('-500')).toBeNull();
    expect(parseRupeesToPaisa('-500', { allowNegative: true })).toBe(-50_000);
  });
  it('rejects bad input', () => {
    for (const bad of ['', 'abc', '1.234', '1e3', '12.5.0']) expect(parseRupeesToPaisa(bad)).toBeNull();
  });
});

describe('amount in words', () => {
  it('uses thousand, lakh and crore', () => {
    expect(numberToWordsPk(234_000)).toBe('Two Lakh Thirty Four Thousand');
    expect(numberToWordsPk(1_234_567)).toBe('Twelve Lakh Thirty Four Thousand Five Hundred Sixty Seven');
    expect(numberToWordsPk(10_000_000)).toBe('One Crore');
    expect(numberToWordsPk(123_456_789)).toBe('Twelve Crore Thirty Four Lakh Fifty Six Thousand Seven Hundred Eighty Nine');
    expect(numberToWordsPk(1_000_000_000_000)).toBe('One Lakh Crore');
    expect(numberToWordsPk(105)).toBe('One Hundred Five');
    expect(numberToWordsPk(0)).toBe('Zero');
  });
  it('formats rupees and paisa', () => {
    expect(amountInWords(23_400_000)).toBe('Rupees Two Lakh Thirty Four Thousand Only');
    expect(amountInWords(90_050)).toBe('Rupees Nine Hundred and Fifty Paisa Only');
    expect(amountInWords(0)).toBe('Rupees Zero Only');
  });
});
