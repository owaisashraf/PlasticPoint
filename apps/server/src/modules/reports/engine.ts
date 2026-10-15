import type { Content, TableCell, TDocumentDefinitions } from 'pdfmake/interfaces';
import {
  bpToPercentString,
  can,
  fiscalYear,
  fiscalYearStartOf,
  formatPaisa,
  reportQuerySchema,
  type ReportCell,
  type ReportColumn,
  type ReportDef,
  type ReportKind,
  type ReportResult,
  type ReportRow,
  type Settings,
} from '@shopledger/shared';
import type { z } from 'zod';
import type { DB } from '../../db/client';
import { rupeesCell, toCsv } from '../../lib/csv';
import { businessToday } from '../../lib/dates';
import type { SessionUser } from '../../lib/permissions';
import { isFinancialField, redact } from '../../lib/redact';
import { baseStyles, documentFooter, documentHeader, renderPdf } from '../../pdf/common';
import { formatBusinessDate } from '../../pdf/format';
import { getSettings } from '../settings/service';

export type ReportQueryOut = z.output<typeof reportQuerySchema>;

export interface ReportCtx {
  db: DB;
  user: SessionUser;
  /** May see cost, profit and margins (finance.view). */
  finance: boolean;
  q: ReportQueryOut;
  settings: Settings;
  today: string;
}

/** What a report builder returns; the engine adds the key and title. */
export type ReportBody = Omit<ReportResult, 'key' | 'title'>;
export type ReportBuilder = (ctx: ReportCtx) => ReportBody;

export function makeCtx(db: DB, user: SessionUser, q: ReportQueryOut): ReportCtx {
  return { db, user, finance: can(user, 'finance.view'), q, settings: getSettings(db), today: businessToday() };
}

// --- Periods -----------------------------------------------------------------------------

/** The current fiscal year so far: its first day to today. */
export function fiscalYearToDate(ctx: ReportCtx): { from: string; to: string } {
  const fy = fiscalYear(fiscalYearStartOf(ctx.today, ctx.settings.fiscal_year_start_month), ctx.settings.fiscal_year_start_month);
  return { from: fy.start, to: ctx.today };
}

/** The period asked for, or a default: today, this month so far, or this fiscal year so far. */
export function period(ctx: ReportCtx, fallback: 'today' | 'month' | 'fiscal_year'): { from: string; to: string } {
  const to = ctx.q.to ?? ctx.today;
  if (ctx.q.from) return { from: ctx.q.from, to };
  if (fallback === 'today') return { from: to, to };
  if (fallback === 'month') return { from: `${to.slice(0, 7)}-01`, to };
  return { from: fiscalYearToDate(ctx).from, to };
}

export function periodText(p: { from: string; to: string }): string {
  return p.from === p.to ? formatBusinessDate(p.from) : `${formatBusinessDate(p.from)} – ${formatBusinessDate(p.to)}`;
}

/** "Wholesalers · Lahore" from the common filters. */
export function filterText(ctx: ReportCtx, extra: (string | null | undefined)[] = []): string {
  return [ctx.q.type ? (ctx.q.type === 'wholesaler' ? 'Wholesalers' : 'Retailers') : null, ctx.q.city ?? null, ctx.q.category ?? null, ...extra].filter(Boolean).join(' · ');
}

export const subtitle = (...parts: (string | null | undefined)[]) => parts.filter(Boolean).join(' · ');

// --- Finishing -----------------------------------------------------------------------

/**
 * Removes cost, profit and margin columns (and values) for users without
 * finance.view. Builders already leave them out; this is the safety net.
 */
export function finalize(def: ReportDef, body: ReportBody, ctx: ReportCtx): ReportResult {
  const result: ReportResult = { key: def.key, title: def.title, ...body };
  if (ctx.finance) return result;
  return redact({ ...result, columns: result.columns.filter((c) => !isFinancialField(c.key)) }, ctx.user);
}

// --- Rendering -------------------------------------------------------------------------

/** A cell as text, the way the screen shows it. */
export function cellText(v: ReportCell | undefined, kind: ReportKind): string {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'number') {
    if (kind === 'money') return formatPaisa(v);
    if (kind === 'percent') return `${bpToPercentString(v)}%`;
    if (kind === 'days') return `${v} d`;
    if (kind === 'int') return String(v);
  }
  if (kind === 'date' && typeof v === 'string') return formatBusinessDate(v);
  return String(v);
}

const kindOf = (row: ReportRow, col: ReportColumn): ReportKind => (col.kind === 'money' && typeof row._kind === 'string' ? (row._kind as ReportKind) : col.kind);

export function reportCsv(r: ReportResult): string {
  const csvCell = (v: ReportCell | undefined, kind: ReportKind) => {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number' && kind === 'money') return rupeesCell(v);
    if (typeof v === 'number' && kind === 'percent') return bpToPercentString(v);
    return v;
  };
  const headOf = (c: ReportColumn) => {
    if (c.kind === 'money') return `${c.label} (Rs)`;
    if (c.kind === 'percent') return `${c.label} (%)`;
    return c.label;
  };
  const head = r.columns.map(headOf);
  const rows = r.rows.map((row) => r.columns.map((c) => csvCell(row[c.key], kindOf(row, c))));
  if (r.totals) rows.push(r.columns.map((c, i) => (i === 0 && r.totals?.[c.key] === undefined ? 'Total' : csvCell(r.totals?.[c.key], c.kind))));
  return toCsv(head, rows);
}

export async function reportPdf(r: ReportResult, def: ReportDef, settings: Settings): Promise<Buffer> {
  const numeric = (k: ReportKind) => k === 'money' || k === 'int' || k === 'percent' || k === 'days';
  const head: TableCell[] = r.columns.map((c) => ({ text: c.label, style: 'th', alignment: numeric(c.kind) ? 'right' : 'left' }));
  const body: TableCell[][] = [
    head,
    ...r.rows.map((row) =>
      r.columns.map((c) => {
        const k = kindOf(row, c);
        return { text: cellText(row[c.key], k), style: numeric(k) ? 'num' : 'td', bold: !!row._strong };
      }),
    ),
  ];
  if (r.totals) {
    body.push(r.columns.map((c, i) => ({ text: i === 0 && r.totals?.[c.key] === undefined ? 'Total' : cellText(r.totals?.[c.key], c.kind), style: numeric(c.kind) ? 'num' : 'td', bold: true })));
  }
  const summary: Content[] = r.summary.length
    ? [
        {
          columns: r.summary.map((s) => ({ width: 'auto', stack: [{ text: s.label, style: 'muted' }, { text: cellText(s.value, s.kind), bold: true, fontSize: 11 }], margin: [0, 0, 18, 0] })),
          margin: [0, 0, 0, 10],
        } as Content,
      ]
    : [];
  // The name column takes the spare width (not a short code before it).
  const wide = Math.max(0, r.columns.findIndex((c) => c.key === 'name'));
  // Wide tables get a smaller font so they fit the page.
  const fontSize = r.columns.length > 10 ? 7 : 8;
  const doc: TDocumentDefinitions = {
    pageSize: 'A4',
    pageOrientation: def.landscape || r.columns.length > 8 ? 'landscape' : 'portrait',
    pageMargins: [30, 30, 30, 40],
    defaultStyle: { font: 'Roboto', fontSize },
    styles: { ...baseStyles, th: { bold: true, fontSize, fillColor: '#eeeeee' }, td: { fontSize }, num: { fontSize, alignment: 'right' } },
    footer: documentFooter(r.notes.join(' ')),
    content: [
      documentHeader(settings, r.title.toUpperCase(), r.subtitle),
      ...summary,
      r.rows.length
        ? { table: { headerRows: 1, widths: r.columns.map((_, i) => (i === wide ? '*' : 'auto')), body }, layout: 'lightHorizontalLines' }
        : { text: 'Nothing to show for this period.', italics: true },
    ],
  };
  return renderPdf(doc);
}

// --- Small helpers for builders ---------------------------------------------------------

export const col = (key: string, label: string, kind: ReportKind = 'text'): ReportColumn => ({ key, label, kind });

/** Sum of a numeric column over rows. */
export function total(rows: ReportRow[], key: string): number {
  return rows.reduce((a, r) => a + (typeof r[key] === 'number' ? (r[key] as number) : 0), 0);
}

/** Whole days between two 'YYYY-MM-DD' dates (b − a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}
