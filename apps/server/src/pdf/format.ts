import { BUSINESS_TIME_ZONE } from '../lib/dates';

const fmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: BUSINESS_TIME_ZONE,
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** "05 Oct 2026, 21:05" in Karachi time. */
export function formatDateTimeKarachi(d: Date): string {
  return fmt.format(d);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '2026-10-05' -> '05 Oct 2026'. */
export function formatBusinessDate(date: string): string {
  const [y, m, d] = date.split('-');
  return `${d} ${MONTHS[Number(m) - 1] ?? m} ${y}`;
}
