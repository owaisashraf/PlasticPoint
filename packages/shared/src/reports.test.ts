import { describe, expect, it } from 'vitest';
import { fiscalYear, fiscalYearStartOf, monthRange } from './reports';

describe('fiscal year', () => {
  it('July–June by default (Pakistan)', () => {
    const fy = fiscalYear(2026, 7);
    expect(fy).toMatchObject({ label: '2026-27', start: '2026-07-01', end: '2027-06-30' });
    expect(fy.months[0]).toBe('2026-07');
    expect(fy.months[11]).toBe('2027-06');
  });

  it('calendar year when it starts in January', () => {
    expect(fiscalYear(2026, 1)).toMatchObject({ label: '2026', start: '2026-01-01', end: '2026-12-31' });
  });

  it('which fiscal year a date is in, at the boundaries', () => {
    expect(fiscalYearStartOf('2026-06-30', 7)).toBe(2025);
    expect(fiscalYearStartOf('2026-07-01', 7)).toBe(2026);
    expect(fiscalYearStartOf('2027-01-15', 7)).toBe(2026);
    expect(fiscalYearStartOf('2026-12-31', 1)).toBe(2026);
  });

  it('month ranges, including February in leap years', () => {
    expect(monthRange('2028-02')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(monthRange('2026-12')).toEqual({ from: '2026-12-01', to: '2026-12-31' });
  });
});
