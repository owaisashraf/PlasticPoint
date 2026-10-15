import type { TableCell, TDocumentDefinitions } from 'pdfmake/interfaces';
import { formatPaisa, formatPhone, type Settings, type Statement } from '@shopledger/shared';
import { baseStyles, documentFooter, documentHeader, renderPdf } from './common';
import { formatBusinessDate } from './format';

/**
 * Account statement (CLAUDE.md 11.1 #1, 11.2): balance brought forward,
 * every entry with a running balance, and the closing balance. Ledger
 * entries never carry cost or profit, so a statement is safe to give out.
 */

export interface StatementParty {
  kind: 'customer' | 'supplier';
  name: string;
  code?: string | null;
  business_name?: string | null;
  phone?: string | null;
  city?: string | null;
  address?: string | null;
}

/** Customers: positive = they owe us. Suppliers: positive = we owe them. */
function balanceText(paisa: number, kind: StatementParty['kind']): string {
  if (paisa >= 0) return formatPaisa(paisa);
  return `${kind === 'customer' ? 'Advance' : 'Advance paid'} ${formatPaisa(-paisa)}`;
}

export function statementDocDefinition(settings: Settings, party: StatementParty, st: Statement, range: { from?: string; to?: string }): TDocumentDefinitions {
  const period = range.from || range.to ? `${range.from ? formatBusinessDate(range.from) : 'Start'} – ${range.to ? formatBusinessDate(range.to) : 'Today'}` : 'All entries';
  const head: TableCell[] = ['Date', 'Details', 'Debit', 'Credit', 'Balance'].map((t, i) => ({ text: t, style: 'th', alignment: i >= 2 ? 'right' : 'left' }));
  const body: TableCell[][] = [
    head,
    [{ text: '', style: 'td' }, { text: 'Balance brought forward', style: 'td', italics: true }, { text: '', style: 'num' }, { text: '', style: 'num' }, { text: balanceText(st.opening_balance_paisa, party.kind), style: 'num' }],
    ...st.lines.map((l) => [
      { text: formatBusinessDate(l.date), style: 'td' },
      { text: l.narration ?? l.entry_type, style: 'td' },
      { text: l.debit_paisa ? formatPaisa(l.debit_paisa) : '', style: 'num' },
      { text: l.credit_paisa ? formatPaisa(l.credit_paisa) : '', style: 'num' },
      { text: balanceText(l.balance_paisa, party.kind), style: 'num' },
    ]),
  ];
  const details = [party.business_name, party.address, party.city, party.phone && `Phone: ${formatPhone(party.phone)}`, party.code && `Code: ${party.code}`].filter(Boolean) as string[];
  const closingLabel = party.kind === 'customer' ? 'Closing balance (you owe)' : 'Closing balance (we owe)';

  return {
    pageSize: 'A4',
    pageMargins: [40, 40, 40, 50],
    defaultStyle: { font: 'Roboto', fontSize: 10 },
    styles: baseStyles,
    footer: documentFooter(),
    content: [
      documentHeader(settings, 'STATEMENT', period),
      { stack: [{ text: party.kind === 'customer' ? 'Customer' : 'Supplier', style: 'muted' }, { text: party.name, bold: true, fontSize: 12 }, ...details.map((t) => ({ text: t, fontSize: 9 }))], margin: [0, 0, 0, 12] },
      { table: { headerRows: 1, widths: ['auto', '*', 'auto', 'auto', 'auto'], body }, layout: 'lightHorizontalLines' },
      {
        columns: [
          { width: '*', text: '' },
          {
            width: 'auto',
            table: { body: [[{ text: closingLabel, style: 'totalLabel' }, { text: balanceText(st.closing_balance_paisa, party.kind), style: 'totalValue' }]] },
            layout: 'noBorders',
            margin: [0, 10, 0, 0],
          },
        ],
      },
    ],
  };
}

export function renderStatementPdf(settings: Settings, party: StatementParty, st: Statement, range: { from?: string; to?: string }): Promise<Buffer> {
  return renderPdf(statementDocDefinition(settings, party, st, range));
}
