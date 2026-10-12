/**
 * A simulated clock for the demo seed. The server reads the time only through
 * `new Date()` and `Date.now()` (lib/dates.ts), so swapping the global Date
 * lets the seed post 18 months of documents "on" their own days: created_at,
 * audit timestamps, same-day edit rules and overdue all line up.
 */

const RealDate = Date;

export interface SimClock {
  set(ms: number): void;
  now(): number;
  /** Puts the real clock back. */
  restore(): void;
}

export function installSimClock(): SimClock {
  let simNow = RealDate.now();
  class SimDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(simNow);
      else super(...(args as [string | number]));
    }
    static override now(): number {
      return simNow;
    }
  }
  globalThis.Date = SimDate as unknown as DateConstructor;
  return {
    set: (ms) => {
      simNow = ms;
    },
    now: () => simNow,
    restore: () => {
      globalThis.Date = RealDate;
    },
  };
}

/** The real current time, whatever the simulated clock says. */
export const realNow = (): number => RealDate.now();

/** Milliseconds for a Karachi wall-clock time (UTC+5, no daylight saving). */
export function karachiMs(date: string, hour: number, minute = 0): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return RealDate.UTC(y, m - 1, d, hour - 5, minute);
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new RealDate(RealDate.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const target = new RealDate(RealDate.UTC(y, m - 1 + months, 1));
  const last = new RealDate(RealDate.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return new RealDate(RealDate.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(d, last))).toISOString().slice(0, 10);
}

export function dayOfWeek(date: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new RealDate(RealDate.UTC(y, m - 1, d)).getUTCDay();
}

export function daysBetween(a: string, b: string): number {
  return Math.round((RealDate.parse(`${b}T00:00:00Z`) - RealDate.parse(`${a}T00:00:00Z`)) / 86_400_000);
}
