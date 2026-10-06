/**
 * Hand-written CSV export (CLAUDE.md 11: no extra library). Output opens
 * correctly in Excel: UTF-8 with a byte-order mark, CRLF line ends, and every
 * text cell quoted when needed.
 */

export type CsvValue = string | number | null | undefined;

/** Text that Excel would run as a formula gets a leading apostrophe. */
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(v: CsvValue): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return String(v);
  if (/^-?\d+(\.\d+)?$/.test(v)) return v; // a plain number, e.g. from rupeesCell
  const text = FORMULA_START.test(v) ? `'${v}` : v;
  return /[",\r\n']/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Byte-order mark: tells Excel the file is UTF-8. */
const BOM = String.fromCharCode(0xfeff);

export function toCsv(header: readonly string[], rows: readonly (readonly CsvValue[])[]): string {
  return `${BOM}${[header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

/** Paisa as a plain rupee number for spreadsheets: 123450 → "1234.50" (integer math, no float). */
export function rupeesCell(paisa: number): string {
  const sign = paisa < 0 ? '-' : '';
  const abs = Math.abs(paisa);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}
