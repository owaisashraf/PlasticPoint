import { existsSync, writeFileSync } from 'node:fs';
import type { Content, TableCell, TDocumentDefinitions } from 'pdfmake/interfaces';
import { amountInWords, bpToPercentString, formatPaisa, formatPhone, type Sale, type Settings } from '@shopledger/shared';
import { redact } from '../lib/redact';
import { baseStyles, documentFooter, documentHeader, documentPdfPath, renderPdf, voidWatermark } from './common';
import { formatBusinessDate } from './format';

/**
 * Customer invoice (CLAUDE.md 12): price, discount % and amount per line,
 * totals, amount in words and the running balance. It never shows supplier
 * margin, cost or profit — the sale is stripped of every financial field
 * before the document is built, so a template change cannot leak them.
 */

export type PaperSize = 'A4' | '80mm';

export interface InvoiceBalances {
  previous_balance_paisa: number;
  paid_now_paisa: number;
  total_outstanding_paisa: number;
}

/** "Advance Rs 2,000" for negative balances, as on screen. */
function balanceText(paisa: number): string {
  return paisa < 0 ? `Advance ${formatPaisa(-paisa)}` : formatPaisa(paisa);
}

const pct = (bp: number) => `${bpToPercentString(bp)}%`;

function totalsRows(s: Sale, b: InvoiceBalances): { label: string; value: string; strong?: boolean; gap?: boolean }[] {
  return [
    { label: 'Gross (qty × price)', value: formatPaisa(s.gross_paisa) },
    { label: 'Less discount', value: `−${formatPaisa(s.line_discount_paisa)}` },
    ...(s.extra_discount_paisa ? [{ label: 'Less extra discount', value: `−${formatPaisa(s.extra_discount_paisa)}` }] : []),
    ...(s.tax_paisa ? [{ label: 'Tax', value: formatPaisa(s.tax_paisa) }] : []),
    { label: 'Invoice total', value: formatPaisa(s.total_paisa), strong: true },
    { label: 'Previous balance', value: balanceText(b.previous_balance_paisa), gap: true },
    { label: 'This invoice', value: formatPaisa(s.status === 'posted' ? s.total_paisa : 0) },
    ...(b.paid_now_paisa ? [{ label: 'Paid now', value: `−${formatPaisa(b.paid_now_paisa)}` }] : []),
    { label: 'Total outstanding', value: balanceText(b.total_outstanding_paisa), strong: true },
  ];
}

function customerLines(s: Sale): string[] {
  return [s.customer_business_name, s.customer_address, s.customer_city, s.customer_phone && `Phone: ${formatPhone(s.customer_phone)}`, `Customer code: ${s.customer_code}`].filter(Boolean) as string[];
}

function a4Definition(s: Sale, b: InvoiceBalances, settings: Settings): TDocumentDefinitions {
  const lines = s.lines ?? [];
  const head: TableCell[] = ['#', 'Item', 'Description', 'Color', 'Size', 'Qty', 'Price', 'Disc %', 'Amount'].map((t, i) => ({
    text: t,
    style: 'th',
    alignment: i >= 5 ? 'right' : 'left',
  }));
  const body: TableCell[][] = [
    head,
    ...lines.map((l) => [
      { text: String(l.line_no), style: 'td' },
      { text: l.item_code, style: 'td', bold: true },
      { text: l.name, style: 'td' },
      { text: l.color || '—', style: 'td' },
      { text: l.size || '—', style: 'td' },
      { text: `${l.qty} ${l.unit}`, style: 'num' },
      { text: formatPaisa(l.list_price_paisa), style: 'num' },
      { text: pct(l.discount_bp), style: 'num' },
      { text: formatPaisa(l.line_amount_paisa), style: 'num' },
    ]),
  ];
  const totals = totalsRows(s, b);

  return {
    pageSize: 'A4',
    pageMargins: [40, 40, 40, 50],
    defaultStyle: { font: 'Roboto', fontSize: 10 },
    styles: baseStyles,
    watermark: voidWatermark(s.status === 'void'),
    footer: documentFooter('Thank you for your business.'),
    content: [
      documentHeader(settings, 'INVOICE', s.doc_no, [
        ['Date', formatBusinessDate(s.date)],
        ['Due date', formatBusinessDate(s.due_date)],
        ['Payment terms', `${s.payment_terms_days} days`],
      ]),
      {
        stack: [{ text: 'Bill to', style: 'muted' }, { text: s.customer_name, bold: true, fontSize: 12 }, ...customerLines(s).map((t) => ({ text: t, fontSize: 9 }))],
        margin: [0, 0, 0, 12],
      },
      {
        table: { headerRows: 1, widths: [16, 'auto', '*', 'auto', 'auto', 'auto', 'auto', 'auto', 'auto'], body },
        layout: 'lightHorizontalLines',
      },
      {
        columns: [
          { width: '*', stack: [{ text: amountInWords(s.total_paisa), italics: true, margin: [0, 10, 12, 0] }] },
          {
            width: 'auto',
            table: {
              body: totals.map((r) => [
                { text: r.label, style: r.strong ? 'totalLabel' : 'num', margin: [0, r.gap ? 8 : 0, 0, 0] },
                { text: r.value, style: r.strong ? 'totalValue' : 'num', margin: [0, r.gap ? 8 : 0, 0, 0] },
              ]),
            },
            layout: 'noBorders',
            margin: [0, 10, 0, 0],
          },
        ],
      },
      ...(s.notes ? [{ text: `Notes: ${s.notes}`, margin: [0, 12, 0, 0] } as Content] : []),
    ],
  };
}

/** 80 mm thermal roll: one column, page as long as the content. */
function thermalDefinition(s: Sale, b: InvoiceBalances, settings: Settings): TDocumentDefinitions {
  const lines = s.lines ?? [];
  const details = [settings.business_address, settings.business_phone && `Phone: ${settings.business_phone}`, settings.business_ntn && `NTN: ${settings.business_ntn}`].filter(Boolean) as string[];
  const rule: Content = { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 207, y2: 0, lineWidth: 0.5, dash: { length: 2 } }], margin: [0, 4, 0, 4] };
  const pair = (k: string, v: string, bold = false): Content => ({ columns: [{ text: k, width: '*' }, { text: v, width: 'auto', alignment: 'right' }], bold });

  return {
    pageSize: { width: 227, height: 'auto' },
    pageMargins: [10, 10, 10, 10],
    defaultStyle: { font: 'Roboto', fontSize: 8 },
    watermark: voidWatermark(s.status === 'void'),
    content: [
      { text: settings.business_name || 'ShopLedger', bold: true, fontSize: 11, alignment: 'center' },
      ...details.map((d) => ({ text: d, alignment: 'center' as const })),
      rule,
      { text: `INVOICE ${s.doc_no}`, bold: true, alignment: 'center' },
      pair('Date', formatBusinessDate(s.date)),
      pair('Due', `${formatBusinessDate(s.due_date)} (${s.payment_terms_days} days)`),
      pair('Customer', `${s.customer_name} (${s.customer_code})`),
      ...(s.customer_phone ? [pair('Phone', formatPhone(s.customer_phone))] : []),
      rule,
      ...lines.flatMap((l): Content[] => [
        { text: `${l.item_code} ${l.name}${l.color || l.size ? ` · ${[l.color, l.size].filter(Boolean).join(' ')}` : ''}`, bold: true },
        pair(`  ${l.qty} × ${formatPaisa(l.list_price_paisa)} − ${pct(l.discount_bp)}`, formatPaisa(l.line_amount_paisa)),
      ]),
      rule,
      ...totalsRows(s, b).map((r) => ({ ...(pair(r.label, r.value, r.strong) as object), margin: [0, r.gap ? 4 : 0, 0, 0] }) as Content),
      { text: amountInWords(s.total_paisa), italics: true, margin: [0, 4, 0, 0] },
      ...(s.notes ? [{ text: `Notes: ${s.notes}`, margin: [0, 4, 0, 0] } as Content] : []),
      { text: 'Thank you for your business.', alignment: 'center', margin: [0, 6, 0, 0] },
    ],
  };
}

export function invoiceDocDefinition(sale: Sale, balances: InvoiceBalances, settings: Settings, size: PaperSize): TDocumentDefinitions {
  // No user: removes supplier margin, cost and profit from the sale and its lines.
  const s = redact(sale, null);
  return size === '80mm' ? thermalDefinition(s, balances, settings) : a4Definition(s, balances, settings);
}

/** DATA_DIR/invoices/YYYY/MM/<doc_no>-v<version>.pdf (80 mm copies end in -80mm). Written if missing or forced. */
export async function ensureInvoicePdf(invoicesDir: string, sale: Sale, balances: InvoiceBalances, settings: Settings, size: PaperSize, force = false): Promise<string> {
  const base = documentPdfPath(invoicesDir, sale.doc_no, sale.version, sale.date);
  const path = size === '80mm' ? base.replace(/\.pdf$/, '-80mm.pdf') : base;
  if (force || !existsSync(path)) writeFileSync(path, await renderPdf(invoiceDocDefinition(sale, balances, settings, size)));
  return path;
}
