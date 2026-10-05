/**
 * Percentages are stored as integer basis points: 1% = 100 bp, 22.5% = 2250.
 * These helpers convert at the edges without using floating point.
 */

export const BP_PER_PERCENT = 100;
export const MAX_BP = 10_000;

/** 2250 -> "22.5%", 1200 -> "12%", 1234 -> "12.34%". */
export function formatBp(bp: number): string {
  return `${bpToPercentString(bp)}%`;
}

/** 2250 -> "22.5" (no % sign), for form inputs. */
export function bpToPercentString(bp: number): string {
  if (!Number.isInteger(bp)) throw new Error(`Basis points must be an integer, got ${bp}`);
  const sign = bp < 0 ? '-' : '';
  const abs = Math.abs(bp);
  const whole = Math.trunc(abs / BP_PER_PERCENT);
  const frac = abs % BP_PER_PERCENT;
  if (frac === 0) return `${sign}${whole}`;
  const fracStr = String(frac).padStart(2, '0').replace(/0$/, '');
  return `${sign}${whole}.${fracStr}`;
}

/**
 * Parses a percentage typed by a user ("12", "12.5", "12.50", " 7.25 % ")
 * into basis points. Returns null if the text is not a valid percentage with
 * at most two decimal places.
 */
export function parsePercentToBp(text: string): number | null {
  const cleaned = text.trim().replace(/%$/, '').trim();
  const m = /^(\d{1,5})(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!m) return null;
  const whole = Number(m[1]);
  const frac = Number((m[2] ?? '').padEnd(2, '0'));
  return whole * BP_PER_PERCENT + frac;
}
