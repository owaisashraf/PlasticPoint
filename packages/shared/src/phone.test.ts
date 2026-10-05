import { describe, expect, it } from 'vitest';
import { formatPhone, localPhoneDigits, normalizePhone } from './phone';

describe('phone numbers', () => {
  it('normalizes Pakistani mobile numbers to E.164', () => {
    for (const input of ['0300-1234567', '0300 1234567', '03001234567', '+92 300 1234567', '923001234567', '+923001234567']) {
      expect(normalizePhone(input), input).toBe('+923001234567');
    }
  });
  it('accepts landlines with area codes', () => {
    expect(normalizePhone('042-35761234')).toBe('+924235761234');
  });
  it('rejects invalid numbers', () => {
    for (const bad of ['', '123', '0300-12345', 'abc']) expect(normalizePhone(bad), bad).toBeNull();
  });
  it('formats for display and search', () => {
    expect(formatPhone('+923001234567')).toBe('0300 1234567');
    expect(localPhoneDigits('+923001234567')).toBe('03001234567');
    expect(formatPhone(null)).toBe('');
  });
});
