import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { desc, eq } from 'drizzle-orm';
import {
  balanceForCustomer,
  formatPaisa,
  normalizePhone,
  parseWhatsAppParams,
  renderWhatsAppMessage,
  waMeNumber,
  waMeUrl,
  type Customer,
  type Sale,
  type SendResult,
  type Settings,
  type WhatsAppKind,
  type WhatsAppLogEntry,
  type WhatsAppValues,
} from '@shopledger/shared';
import type { AppConfig } from '../../config';
import { writeTx, type DB, type DbOrTx } from '../../db/client';
import { users, whatsapp_log } from '../../db/schema';
import { writeAudit } from '../../lib/audit';
import { businessToday, nowIso } from '../../lib/dates';
import { AppError, badRequest, forbidden, notFound } from '../../lib/errors';
import type { SessionUser } from '../../lib/permissions';
import { ensureInvoicePdf } from '../../pdf/invoice';
import { formatBusinessDate } from '../../pdf/format';
import { renderStatementPdf } from '../../pdf/statement';
import { auditActor } from '../auth/service';
import { customerStatement, getCustomer } from '../customers/service';
import { getSale, invoiceBalances } from '../sales/service';
import { getSettings } from '../settings/service';
import { CloudApiError, sendTemplate, uploadPdf, type CloudApiConfig, type FetchFn } from './cloud-api';

/**
 * WhatsApp (CLAUDE.md 13). Every send goes through one interface, so the
 * provider can change without touching the rest of the app:
 *
 *   click_to_chat (default): save the PDF, return a wa.me link with the
 *     message for the browser to open; the user drags the PDF into the chat.
 *   cloud_api: upload the PDF and send an approved template through the
 *     official WhatsApp Business Platform.
 *
 * Every attempt goes into whatsapp_log; a successful one also writes an
 * audit 'share' row. Messages use only the placeholders in the shared
 * package, none of which can carry margin, cost or profit.
 */
export interface WhatsAppSender {
  sendInvoice(saleId: number): Promise<SendResult>;
  sendStatement(customerId: number, from?: string, to?: string): Promise<SendResult>;
  sendReminder(customerId: number): Promise<SendResult>;
}

export interface WhatsAppDeps {
  db: DB;
  config: AppConfig;
  user: SessionUser;
  /** Injected in tests; tests never reach the network. */
  fetch?: FetchFn;
}

interface Prepared {
  kind: WhatsAppKind;
  customer: Customer;
  sale: Sale | null;
  values: WhatsAppValues;
  /** Builds and saves the PDF (absolute path), if this kind has one. */
  pdf: (() => Promise<string>) | null;
  /** File name the customer sees. */
  pdfName: string | null;
  audit: { entity: string; entity_id: number; doc_no: string; version: number | null; summary: Record<string, unknown> };
}

const MESSAGE_KEY = { invoice: 'whatsapp_invoice_message', statement: 'whatsapp_statement_message', reminder: 'whatsapp_reminder_message' } as const;
const TEMPLATE_KEY = { invoice: 'whatsapp_cloud_invoice_template', statement: 'whatsapp_cloud_statement_template', reminder: 'whatsapp_cloud_reminder_template' } as const;
const PARAMS_KEY = { invoice: 'whatsapp_cloud_invoice_params', statement: 'whatsapp_cloud_statement_params', reminder: 'whatsapp_cloud_reminder_params' } as const;
const KIND_PLURAL = { invoice: 'invoices', statement: 'statements', reminder: 'reminders' } as const;

export function cloudConfig(s: Settings): CloudApiConfig {
  return { phoneNumberId: s.whatsapp_cloud_phone_number_id, token: s.whatsapp_cloud_token, version: s.whatsapp_cloud_api_version, language: s.whatsapp_cloud_language };
}

/** Placeholder values every message can use. */
function customerValues(settings: Settings, c: Customer): WhatsAppValues {
  return {
    customer_name: c.name,
    invoice_no: '',
    invoice_date: '',
    amount: '',
    due_date: '',
    balance: balanceForCustomer(c.balance_paisa),
    overdue_amount: formatPaisa(c.overdue_paisa),
    days_overdue: String(c.overdue_days),
    business_name: settings.business_name,
  };
}

/** Stored relative to DATA_DIR with forward slashes, so the data folder can move. */
function toDataRelative(config: AppConfig, abs: string): string {
  return relative(config.dataDir, abs).split(sep).join('/');
}

export function createWhatsAppSender(deps: WhatsAppDeps): WhatsAppSender {
  const { db, config, user } = deps;

  function log(
    p: Prepared,
    mode: Settings['whatsapp_mode'],
    fields: { status: 'opened' | 'sent' | 'failed'; phone: string | null; pdf?: string | null; message_id?: string | null; error?: string | null },
    target: DbOrTx = db,
  ) {
    return target
      .insert(whatsapp_log)
      .values({
        at: nowIso(),
        user_id: user.id,
        customer_id: p.customer.id,
        kind: p.kind,
        sale_id: p.sale?.id ?? null,
        doc_no: p.sale?.doc_no ?? null,
        mode,
        status: fields.status,
        phone: fields.phone,
        pdf_file: fields.pdf ? toDataRelative(config, fields.pdf) : null,
        message_id: fields.message_id ?? null,
        error: fields.error ?? null,
      })
      .returning({ id: whatsapp_log.id, at: whatsapp_log.at })
      .get();
  }

  /** The customer's WhatsApp number, or a clear error the screen turns into "edit the number". */
  function phoneOf(p: Prepared, mode: Settings['whatsapp_mode']): string {
    const raw = p.customer.phone;
    const phone = raw ? normalizePhone(raw) : null;
    if (phone) return phone;
    const missing = !raw;
    const text = missing
      ? `${p.customer.name} has no phone number. Add their WhatsApp number to send this.`
      : `${p.customer.name}'s phone number (${raw}) is not a valid mobile number. Correct it to send this.`;
    log(p, mode, { status: 'failed', phone: raw ?? null, error: text });
    throw new AppError(400, text, missing ? 'PHONE_MISSING' : 'PHONE_INVALID', { customer_id: p.customer.id });
  }

  async function send(p: Prepared): Promise<SendResult> {
    const settings = getSettings(db);
    const mode = settings.whatsapp_mode;
    const phone = phoneOf(p, mode);
    const message = renderWhatsAppMessage(settings[MESSAGE_KEY[p.kind]], p.values);
    const pdfPath = p.pdf ? await p.pdf() : null;

    let status: 'opened' | 'sent' = 'opened';
    let messageId: string | null = null;
    if (mode === 'cloud_api') {
      try {
        messageId = await sendByCloudApi(deps.fetch ?? fetch, settings, p, phone, pdfPath);
        status = 'sent';
      } catch (e) {
        const text = e instanceof CloudApiError || e instanceof AppError ? e.message : 'Sending on WhatsApp failed. Please try again.';
        log(p, mode, { status: 'failed', phone, pdf: pdfPath, error: text });
        throw new AppError(502, text, 'WHATSAPP_FAILED');
      }
    }

    // The log row and the audit 'share' row are written together.
    const row = writeTx(db, (tx) => {
      const r = log(p, mode, { status, phone, pdf: pdfPath, message_id: messageId }, tx);
      writeAudit(tx, auditActor(user), {
        action: 'share',
        entity: p.audit.entity,
        entity_id: p.audit.entity_id,
        doc_no: p.audit.doc_no,
        version_before: p.audit.version,
        version_after: p.audit.version,
        summary: { channel: 'whatsapp', kind: p.kind, mode, phone, whatsapp_log_id: r.id, ...p.audit.summary },
      });
      return r;
    });

    return {
      log_id: row.id,
      mode,
      status,
      url: mode === 'click_to_chat' ? waMeUrl(phone, message) : null,
      message,
      phone,
      pdf_name: pdfPath ? basename(pdfPath) : null,
      at: row.at,
    };
  }

  return {
    async sendInvoice(saleId) {
      const sale = getSale(db, saleId);
      if (sale.status !== 'posted') throw badRequest(`${sale.doc_no} is void and cannot be sent.`);
      const settings = getSettings(db);
      const customer = getCustomer(db, sale.customer_id);
      return send({
        kind: 'invoice',
        customer,
        sale,
        values: {
          ...customerValues(settings, customer),
          invoice_no: sale.doc_no,
          invoice_date: formatBusinessDate(sale.date),
          amount: formatPaisa(sale.total_paisa),
          due_date: formatBusinessDate(sale.due_date),
        },
        // Always A4 on WhatsApp, refreshed so the balance on it is current.
        pdf: () => ensureInvoicePdf(config.invoicesDir, sale, invoiceBalances(db, sale), getSettings(db), 'A4', true),
        pdfName: `${sale.doc_no}.pdf`,
        audit: { entity: 'sale', entity_id: sale.id, doc_no: sale.doc_no, version: sale.version, summary: {} },
      });
    },

    async sendStatement(customerId, from, to) {
      const customer = getCustomer(db, customerId);
      const settings = getSettings(db);
      const range = { from, to };
      const name = `Statement-${customer.code}-${to ?? businessToday()}.pdf`;
      return send({
        kind: 'statement',
        customer,
        sale: null,
        values: customerValues(settings, customer),
        pdf: async () => {
          const today = businessToday();
          const dir = join(config.statementsDir, today.slice(0, 4), today.slice(5, 7));
          mkdirSync(dir, { recursive: true });
          const path = join(dir, name);
          writeFileSync(path, await renderStatementPdf(getSettings(db), { kind: 'customer', ...customer }, customerStatement(db, customer.id, range), range));
          return path;
        },
        pdfName: name,
        audit: { entity: 'customer', entity_id: customer.id, doc_no: customer.code, version: null, summary: { from: from ?? null, to: to ?? null } },
      });
    },

    async sendReminder(customerId) {
      const customer = getCustomer(db, customerId);
      if (customer.overdue_paisa <= 0) throw badRequest(`Nothing is overdue for ${customer.name}.`);
      const settings = getSettings(db);
      return send({
        kind: 'reminder',
        customer,
        sale: null,
        values: customerValues(settings, customer),
        pdf: null,
        pdfName: null,
        audit: {
          entity: 'customer',
          entity_id: customer.id,
          doc_no: customer.code,
          version: null,
          summary: { overdue_paisa: customer.overdue_paisa, days_overdue: customer.overdue_days },
        },
      });
    },
  };

  async function sendByCloudApi(fetchFn: FetchFn, settings: Settings, p: Prepared, phone: string, pdfPath: string | null): Promise<string> {
    const cfg = cloudConfig(settings);
    const template = settings[TEMPLATE_KEY[p.kind]];
    if (!cfg.phoneNumberId || !cfg.token) throw new CloudApiError('The WhatsApp Cloud API is not set up. Add the phone number ID and access token in Settings → WhatsApp.');
    if (!template) throw new CloudApiError(`No WhatsApp template name is set for ${KIND_PLURAL[p.kind]}. Add it in Settings → WhatsApp.`);
    const names = parseWhatsAppParams(settings[PARAMS_KEY[p.kind]]) ?? [];
    const document = pdfPath && p.pdfName ? { id: await uploadPdf(fetchFn, cfg, readFileSync(pdfPath), p.pdfName), filename: p.pdfName } : undefined;
    return sendTemplate(fetchFn, cfg, { to: waMeNumber(phone), template, params: names.map((n) => p.values[n]), document });
  }
}

// --- History and the "Open folder" button ---------------------------------------------

export function whatsappHistory(db: DB, q: { sale_id?: number; customer_id?: number }): WhatsAppLogEntry[] {
  const where = q.sale_id !== undefined ? eq(whatsapp_log.sale_id, q.sale_id) : eq(whatsapp_log.customer_id, q.customer_id ?? 0);
  return db
    .select({
      id: whatsapp_log.id,
      at: whatsapp_log.at,
      kind: whatsapp_log.kind,
      mode: whatsapp_log.mode,
      status: whatsapp_log.status,
      phone: whatsapp_log.phone,
      doc_no: whatsapp_log.doc_no,
      sale_id: whatsapp_log.sale_id,
      customer_id: whatsapp_log.customer_id,
      user_name: users.display_name,
      error: whatsapp_log.error,
      pdf_file: whatsapp_log.pdf_file,
    })
    .from(whatsapp_log)
    .leftJoin(users, eq(users.id, whatsapp_log.user_id))
    .where(where)
    .orderBy(desc(whatsapp_log.id))
    .limit(50)
    .all()
    .map(({ pdf_file, ...r }) => ({ ...r, pdf_name: pdf_file ? (pdf_file.split('/').pop() ?? null) : null }));
}

export type FolderOpener = (file: string) => void;

/** Opens Windows Explorer with the file selected. */
export const explorerOpener: FolderOpener = (file) => {
  spawn('explorer.exe', [`/select,"${file}"`], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref();
};

const LOCAL_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * "PDF saved — Open folder". Only from a browser on the shop laptop itself,
 * and only for a file this log row saved inside DATA_DIR.
 */
export function openLogFolder(db: DB, config: AppConfig, logId: number, requestIp: string, opener: FolderOpener | null): { file: string } {
  if (!LOCAL_ADDRESSES.has(requestIp)) throw forbidden('Open folder only works on the shop laptop itself. Use that laptop, or download the PDF instead.');
  if (!opener) throw badRequest('Opening the folder only works on Windows.');
  const row = db.select({ pdf_file: whatsapp_log.pdf_file }).from(whatsapp_log).where(eq(whatsapp_log.id, logId)).get();
  if (!row) throw notFound('That WhatsApp send was not found.');
  if (!row.pdf_file) throw badRequest('Nothing was saved for this message.');
  const file = resolve(config.dataDir, ...row.pdf_file.split('/'));
  if (!file.startsWith(resolve(config.dataDir) + sep) || !existsSync(file)) throw notFound('The PDF is no longer in the data folder.');
  opener(file);
  return { file: basename(file) };
}
