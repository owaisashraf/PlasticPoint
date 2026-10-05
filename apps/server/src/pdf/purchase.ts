import { existsSync, writeFileSync } from 'node:fs';
import type { TableCell, TDocumentDefinitions } from 'pdfmake/interfaces';
import { amountInWords, bpToPercentString, formatPaisa, type Purchase, type Settings } from '@shopledger/shared';
import { baseStyles, documentFooter, documentHeader, documentPdfPath, renderPdf, voidWatermark } from './common';
import { formatBusinessDate } from './format';

/**
 * Purchase document (internal: shows supplier margin and cost, as copied
 * from the manufacturer's bill). Never given to customers.
 */
export function purchaseDocDefinition(p: Purchase, settings: Settings): TDocumentDefinitions {
  const lines = p.lines ?? [];
  const head: TableCell[] = ['#', 'Item', 'Description', 'Color', 'Size', 'Qty', 'Price', 'Margin', 'Cost'].map((t, i) => ({
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
      { text: `${l.qty}${l.returned_qty ? ` (−${l.returned_qty})` : ''}`, style: 'num' },
      { text: formatPaisa(l.list_price_paisa), style: 'num' },
      { text: `${bpToPercentString(l.supplier_margin_bp ?? 0)}%`, style: 'num' },
      { text: formatPaisa(l.line_cost_paisa ?? 0), style: 'num' },
    ]),
  ];

  const totals: [string, string][] = [
    ['Gross (qty × price)', formatPaisa(p.gross_paisa)],
    ['Less supplier margin', formatPaisa(p.margin_paisa ?? 0)],
    ['Total cost', formatPaisa(p.total_cost_paisa ?? 0)],
  ];

  return {
    pageSize: 'A4',
    pageMargins: [40, 40, 40, 50],
    defaultStyle: { font: 'Roboto', fontSize: 10 },
    styles: baseStyles,
    watermark: voidWatermark(p.status === 'void'),
    footer: documentFooter('Internal document — not for customers'),
    content: [
      documentHeader(settings, 'PURCHASE', p.doc_no, [
        ['Date', formatBusinessDate(p.date)],
        ...(p.supplier_ref ? ([['Supplier bill', p.supplier_ref]] as [string, string][]) : []),
      ]),
      { text: [{ text: 'Supplier: ', color: '#555555' }, { text: p.supplier_name, bold: true }], margin: [0, 0, 0, 10] },
      {
        table: { headerRows: 1, widths: [16, 'auto', '*', 'auto', 'auto', 'auto', 'auto', 'auto', 'auto'], body },
        layout: 'lightHorizontalLines',
      },
      {
        columns: [
          { width: '*', text: '' },
          {
            width: 'auto',
            table: {
              body: totals.map(([k, v], i) => [
                { text: k, style: i === totals.length - 1 ? 'totalLabel' : 'num' },
                { text: v, style: i === totals.length - 1 ? 'totalValue' : 'num' },
              ]),
            },
            layout: 'noBorders',
            margin: [0, 10, 0, 0],
          },
        ],
      },
      { text: amountInWords(p.total_cost_paisa ?? 0), italics: true, margin: [0, 8, 0, 0] },
      ...(p.returns?.length
        ? [
            { text: 'Returns', bold: true, margin: [0, 14, 0, 4] as [number, number, number, number] },
            ...p.returns.map((r) => ({
              text: `${r.doc_no} · ${formatBusinessDate(r.date)} · ${formatPaisa(r.total_cost_paisa ?? 0)} · ${r.reason}`,
              fontSize: 9,
            })),
          ]
        : []),
      ...(p.notes ? [{ text: `Notes: ${p.notes}`, margin: [0, 12, 0, 0] as [number, number, number, number] }] : []),
      { text: `Entered by ${p.created_by_name ?? '—'}`, style: 'muted', margin: [0, 16, 0, 0] },
    ],
  };
}

/** Writes the PDF for this version if it does not exist yet and returns its path. */
export async function ensurePurchasePdf(invoicesDir: string, p: Purchase, settings: Settings, force = false): Promise<string> {
  const path = documentPdfPath(invoicesDir, p.doc_no, p.version, p.date);
  if (force || !existsSync(path)) writeFileSync(path, await renderPdf(purchaseDocDefinition(p, settings)));
  return path;
}
