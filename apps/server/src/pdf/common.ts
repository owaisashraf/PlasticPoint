import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces';
import type { Settings } from '@shopledger/shared';
import { formatDateTimeKarachi } from './format';

/**
 * Shared PDF helpers (CLAUDE.md 12): pdfmake with its bundled Roboto font,
 * no network or file access beyond the fonts, and the same header and footer
 * on every document.
 */

// pdfmake replaces module.exports with an instance, so load it with require.
const req = createRequire(import.meta.url);
const pdfmake = req('pdfmake') as typeof import('pdfmake');
const fontDir = dirname(req.resolve('pdfmake/fonts/Roboto/Roboto-Regular.ttf'));

let configured = false;
function configure(): void {
  if (configured) return;
  pdfmake.setFonts({
    Roboto: {
      normal: join(fontDir, 'Roboto-Regular.ttf'),
      bold: join(fontDir, 'Roboto-Medium.ttf'),
      italics: join(fontDir, 'Roboto-Italic.ttf'),
      bolditalics: join(fontDir, 'Roboto-MediumItalic.ttf'),
    },
  });
  // Documents never load anything from the network or disk except the fonts.
  pdfmake.setUrlAccessPolicy(() => false);
  pdfmake.setLocalAccessPolicy((p) => resolve(p).startsWith(resolve(fontDir)));
  configured = true;
}

export async function renderPdf(doc: TDocumentDefinitions): Promise<Buffer> {
  configure();
  return pdfmake.createPdf(doc).getBuffer();
}

/** DATA_DIR/invoices/YYYY/MM/<doc_no>-v<version>.pdf, by the document's date. */
export function documentPdfPath(invoicesDir: string, docNo: string, version: number, date: string): string {
  const dir = join(invoicesDir, date.slice(0, 4), date.slice(5, 7));
  mkdirSync(dir, { recursive: true });
  return join(dir, `${docNo}-v${version}.pdf`);
}

export const baseStyles: TDocumentDefinitions['styles'] = {
  business: { fontSize: 16, bold: true },
  muted: { color: '#555555', fontSize: 9 },
  title: { fontSize: 14, bold: true, alignment: 'right' },
  th: { bold: true, fontSize: 9, fillColor: '#eeeeee' },
  td: { fontSize: 9 },
  num: { fontSize: 9, alignment: 'right' },
  totalLabel: { bold: true, alignment: 'right' },
  totalValue: { bold: true, alignment: 'right' },
};

/** Business name and details on the left, document title and number on the right. */
export function documentHeader(settings: Settings, title: string, docNo: string, extra: [string, string][] = []): Content {
  const details = [settings.business_address, settings.business_phone && `Phone: ${settings.business_phone}`, settings.business_ntn && `NTN: ${settings.business_ntn}`, settings.business_strn && `STRN: ${settings.business_strn}`].filter(Boolean) as string[];
  return {
    columns: [
      {
        width: '*',
        stack: [{ text: settings.business_name || 'ShopLedger', style: 'business' }, ...details.map((d) => ({ text: d, style: 'muted' }))],
      },
      {
        width: 'auto',
        stack: [
          { text: title, style: 'title' },
          { text: docNo, alignment: 'right', bold: true, margin: [0, 2, 0, 4] },
          ...extra.map(([k, v]) => ({ text: [{ text: `${k}: `, color: '#555555' }, v], alignment: 'right' as const, fontSize: 9 })),
        ],
      },
    ],
    margin: [0, 0, 0, 12],
  };
}

export function documentFooter(note?: string): TDocumentDefinitions['footer'] {
  const printed = formatDateTimeKarachi(new Date());
  return (currentPage: number, pageCount: number) => ({
    columns: [
      { text: note ?? '', style: 'muted' },
      { text: `Printed ${printed} · Page ${currentPage} of ${pageCount}`, style: 'muted', alignment: 'right' },
    ],
    margin: [40, 10, 40, 0],
  });
}

/** Large grey "VOID" across the page for voided documents. */
export function voidWatermark(isVoid: boolean): TDocumentDefinitions['watermark'] {
  return isVoid ? { text: 'VOID', color: '#999999', opacity: 0.25, bold: true } : undefined;
}
