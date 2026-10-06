import type { TableCell, TDocumentDefinitions } from 'pdfmake/interfaces';
import { formatPaisa, formatPhone, overdueBand, type OverdueList, type Settings } from '@shopledger/shared';
import { baseStyles, documentFooter, documentHeader, renderPdf } from './common';
import { formatBusinessDate } from './format';

const BAND_FILL = { amber: '#fff4d6', orange: '#ffe2c4', red: '#ffd6d6' } as const;

/** The printable Overdue tab (CLAUDE.md 11.1 #7): one row per customer, shaded by days overdue. */
export function overdueDocDefinition(list: OverdueList, settings: Settings, filters: string): TDocumentDefinitions {
  const head: TableCell[] = ['Customer', 'Phone', 'City', 'Terms', 'Inv.', 'Overdue', 'Outstanding', 'Oldest due', 'Days', 'Last payment'].map((t, i) => ({
    text: t,
    style: 'th',
    alignment: [3, 4, 5, 6, 8].includes(i) ? 'right' : 'left',
  }));
  const body: TableCell[][] = [
    head,
    ...list.rows.map((r) => {
      const fillColor = BAND_FILL[overdueBand(r.max_days_overdue, settings)];
      const cell = (text: string, num = false): TableCell => ({ text, style: num ? 'num' : 'td', fillColor });
      return [
        { text: [{ text: r.name, bold: true }, { text: `  ${r.code}${r.status === 'bad_debt' ? ' · BAD DEBT' : ''}`, color: '#555555' }], style: 'td', fillColor },
        cell(formatPhone(r.phone)),
        cell(r.city ?? ''),
        cell(`${r.payment_terms_days}d`, true),
        cell(String(r.overdue_count), true),
        cell(formatPaisa(r.overdue_paisa), true),
        cell(r.balance_paisa < 0 ? `Advance ${formatPaisa(-r.balance_paisa)}` : formatPaisa(r.balance_paisa), true),
        cell(formatBusinessDate(r.oldest_due_date)),
        { text: String(r.max_days_overdue), style: 'num', bold: true, fillColor },
        cell(r.last_payment_date ? `${formatBusinessDate(r.last_payment_date)} · ${formatPaisa(r.last_payment_paisa ?? 0)}` : '—'),
      ];
    }),
    [
      { text: `${list.totals.customers} customer${list.totals.customers === 1 ? '' : 's'}`, style: 'totalLabel', alignment: 'left', colSpan: 5 },
      {},
      {},
      {},
      {},
      { text: formatPaisa(list.totals.overdue_paisa), style: 'totalValue' },
      { text: formatPaisa(list.totals.balance_paisa), style: 'totalValue' },
      { text: '', colSpan: 3 },
      {},
      {},
    ],
  ];

  return {
    pageSize: 'A4',
    pageOrientation: 'landscape',
    pageMargins: [30, 30, 30, 40],
    defaultStyle: { font: 'Roboto', fontSize: 9 },
    styles: baseStyles,
    footer: documentFooter(filters),
    content: [
      documentHeader(settings, 'OVERDUE CUSTOMERS', `As of ${formatBusinessDate(list.as_of)}`),
      list.rows.length
        ? { table: { headerRows: 1, widths: ['*', 'auto', 'auto', 'auto', 'auto', 'auto', 'auto', 'auto', 'auto', 'auto'], body }, layout: 'lightHorizontalLines' }
        : { text: 'No customer is overdue.', italics: true },
    ],
  };
}

export function renderOverduePdf(list: OverdueList, settings: Settings, filters: string): Promise<Buffer> {
  return renderPdf(overdueDocDefinition(list, settings, filters));
}
