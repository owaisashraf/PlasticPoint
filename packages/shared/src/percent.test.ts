import { describe, expect, it } from 'vitest';
import { bpToPercentString, formatBp, parsePercentToBp } from './percent';

describe('percent helpers', () => {
  it('formats basis points', () => {
    expect(formatBp(2250)).toBe('22.5%');
    expect(formatBp(1200)).toBe('12%');
    expect(formatBp(1234)).toBe('12.34%');
    expect(formatBp(5)).toBe('0.05%');
    expect(formatBp(0)).toBe('0%');
    expect(bpToPercentString(-150)).toBe('-1.5');
  });

  it('rejects non-integer basis points', () => {
    expect(() => formatBp(12.5)).toThrow();
  });

  it('parses user input without floats', () => {
    expect(parsePercentToBp('12')).toBe(1200);
    expect(parsePercentToBp('12.5')).toBe(1250);
    expect(parsePercentToBp('12.50')).toBe(1250);
    expect(parsePercentToBp(' 7.25 % ')).toBe(725);
    expect(parsePercentToBp('0.01')).toBe(1);
    expect(parsePercentToBp('22.5')).toBe(2250);
  });

  it('rejects invalid input', () => {
    for (const bad of ['', 'abc', '12.345', '-5', '1e3', '12,5']) {
      expect(parsePercentToBp(bad)).toBeNull();
    }
  });
});
