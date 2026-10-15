/**
 * Money is an integer number of paisa (Rs 1 = 100 paisa). These helpers do
 * all rounding with integer math and only format at the edges.
 */

export const PAISA_PER_RUPEE = 100;

function assertInt(n: number, what: string): void {
  if (!Number.isSafeInteger(n)) throw new Error(`${what} must be a safe integer, got ${n}`);
}

/**
 * Integer division rounded half-up (half away from zero), e.g. for
 * discount = round(gross × bp ÷ 10000).
 */
export function roundDiv(numerator: number, denominator: number): number {
  assertInt(numerator, 'numerator');
  assertInt(denominator, 'denominator');
  if (denominator === 0) throw new Error('Division by zero');
  const sign = Math.sign(numerator) * Math.sign(denominator);
  const n = Math.abs(numerator);
  const d = Math.abs(denominator);
  const q = Math.floor(n / d);
  const r = n - q * d;
  return sign * (2 * r >= d ? q + 1 : q);
}

/** `bp` basis points of `amountPaisa`, rounded half-up to the paisa. */
export function applyBp(amountPaisa: number, bp: number): number {
  return roundDiv(amountPaisa * bp, 10_000);
}

/**
 * Splits `total` into integer parts proportional to `weights`, using the
 * largest-remainder method so the parts add up to `total` exactly.
 * Ties go to the earlier weight. All-zero weights get an even split.
 */
export function spreadLargestRemainder(total: number, weights: readonly number[]): number[] {
  assertInt(total, 'total');
  if (weights.length === 0) return [];
  weights.forEach((w) => {
    assertInt(w, 'weight');
    if (w < 0) throw new Error('Weights cannot be negative');
  });
  const sumW = weights.reduce((a, b) => a + b, 0);
  const ws = sumW === 0 ? weights.map(() => 1) : weights;
  const sum = sumW === 0 ? weights.length : sumW;

  const sign = total < 0 ? -1 : 1;
  const abs = Math.abs(total);
  const parts = ws.map((w) => Math.floor((abs * w) / sum));
  const rema = ws.map((w, i) => ({ i, r: abs * w - (parts[i] ?? 0) * sum }));
  let left = abs - parts.reduce((a, b) => a + b, 0);
  rema.sort((a, b) => b.r - a.r || a.i - b.i);
  for (const { i } of rema) {
    if (left <= 0) break;
    parts[i] = (parts[i] ?? 0) + 1;
    left--;
  }
  return parts.map((p) => sign * p);
}

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Whole rupees and leftover paisa of the absolute amount: 123450 -> 1234 and 50. */
function splitPaisa(paisa: number): { rupees: number; frac: number } {
  assertInt(paisa, 'paisa');
  const abs = Math.abs(paisa);
  return { rupees: Math.floor(abs / PAISA_PER_RUPEE), frac: abs % PAISA_PER_RUPEE };
}

/**
 * "Rs 1,234,567" — paisa shown only when non-zero ("Rs 1,234.50").
 * Negative amounts get a leading minus ("-Rs 500").
 */
export function formatPaisa(paisa: number): string {
  const { rupees, frac } = splitPaisa(paisa);
  const sign = paisa < 0 ? '-' : '';
  const fracStr = frac === 0 ? '' : `.${String(frac).padStart(2, '0')}`;
  return `${sign}Rs ${groupThousands(String(rupees))}${fracStr}`;
}

/** "1234.5" style text for form inputs (no "Rs", no grouping). */
export function paisaToInput(paisa: number): string {
  const { rupees, frac } = splitPaisa(paisa);
  const sign = paisa < 0 ? '-' : '';
  if (frac === 0) return `${sign}${rupees}`;
  return `${sign}${rupees}.${String(frac).padStart(2, '0').replace(/0$/, '')}`;
}

/**
 * Parses rupees typed by a user ("1,234", "1234.5", "Rs 1,234.50") into
 * paisa. Returns null if invalid or if it has more than two decimals.
 */
export function parseRupeesToPaisa(text: string, opts: { allowNegative?: boolean } = {}): number | null {
  let s = text.trim().replace(/^rs\.?\s*/i, '').replace(/,/g, '').trim();
  let sign = 1;
  if (s.startsWith('-')) {
    if (!opts.allowNegative) return null;
    sign = -1;
    s = s.slice(1).trim();
  }
  const m = /^(\d{1,13})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const paisa = Number(m[1]) * PAISA_PER_RUPEE + Number((m[2] ?? '').padEnd(2, '0'));
  return sign * paisa;
}

// --- Amount in words (Pakistani style: thousand, lakh, crore) --------------

const ONES = [
  'Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function under100(n: number): string {
  if (n < 20) return ONES[n] ?? '';
  const t = TENS[Math.floor(n / 10)] ?? '';
  return n % 10 ? `${t} ${ONES[n % 10]}` : t;
}

function under1000(n: number): string {
  const h = Math.floor(n / 100);
  const rest = n % 100;
  const parts: string[] = [];
  if (h) parts.push(`${ONES[h]} Hundred`);
  if (rest) parts.push(under100(rest));
  return parts.join(' ');
}

/** 234000 -> "Two Lakh Thirty Four Thousand". Crore repeats for very large numbers. */
export function numberToWordsPk(n: number): string {
  assertInt(n, 'number');
  if (n < 0) return `Minus ${numberToWordsPk(-n)}`;
  if (n === 0) return 'Zero';
  const crore = Math.floor(n / 10_000_000);
  const lakh = Math.floor((n % 10_000_000) / 100_000);
  const thousand = Math.floor((n % 100_000) / 1000);
  const rest = n % 1000;
  const parts: string[] = [];
  if (crore) parts.push(`${numberToWordsPk(crore)} Crore`);
  if (lakh) parts.push(`${under100(lakh)} Lakh`);
  if (thousand) parts.push(`${under100(thousand)} Thousand`);
  if (rest) parts.push(under1000(rest));
  return parts.join(' ');
}

/** "Rupees Two Lakh Thirty Four Thousand Only" / "... and Fifty Paisa Only". */
export function amountInWords(paisa: number): string {
  const { rupees, frac } = splitPaisa(paisa);
  const neg = paisa < 0 ? 'Minus ' : '';
  const words = `Rupees ${neg}${numberToWordsPk(rupees)}`;
  return frac ? `${words} and ${under100(frac)} Paisa Only` : `${words} Only`;
}
