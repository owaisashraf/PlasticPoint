/**
 * Date helpers. The business runs in Asia/Karachi. Business dates are
 * 'YYYY-MM-DD' strings in Karachi time; timestamps are ISO-8601 UTC.
 *
 * Everything reads the clock through `new Date()`, so tests control time
 * with `vi.setSystemTime()`.
 */

export const BUSINESS_TIME_ZONE = 'Asia/Karachi';

const partsFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: BUSINESS_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

interface KarachiParts {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
}

function karachiParts(d: Date): KarachiParts {
  const out: Record<string, string> = {};
  for (const p of partsFormatter.formatToParts(d)) out[p.type] = p.value;
  return {
    year: out.year ?? '0000',
    month: out.month ?? '00',
    day: out.day ?? '00',
    hour: out.hour ?? '00',
    minute: out.minute ?? '00',
  };
}

/** The current moment as an ISO-8601 UTC timestamp. */
export function nowIso(): string {
  return new Date().toISOString();
}

/** Today's business date in Karachi, 'YYYY-MM-DD'. */
export function businessToday(): string {
  return toBusinessDate(new Date());
}

/** The Karachi business date of a moment. */
export function toBusinessDate(d: Date): string {
  const p = karachiParts(d);
  return `${p.year}-${p.month}-${p.day}`;
}

/** 'YYYY-MM-DD_HHmm' in Karachi time, for file names. */
export function karachiFileStamp(d: Date = new Date()): string {
  const p = karachiParts(d);
  return `${p.year}-${p.month}-${p.day}_${p.hour}${p.minute}`;
}

/** Milliseconds between an ISO timestamp and now. */
export function msSince(iso: string): number {
  return Date.now() - Date.parse(iso);
}

export const HOUR_MS = 60 * 60 * 1000;
