import { z } from 'zod';
import { formatPaisa } from './money';
import { businessDateSchema } from './common';

/**
 * WhatsApp messages (CLAUDE.md 13). Message texts are editable in settings
 * and may use only these placeholders. None of them can carry supplier
 * margin, cost or profit, so a customer message can never show them.
 */
export const WHATSAPP_PLACEHOLDERS = [
  'customer_name',
  'invoice_no',
  'invoice_date',
  'amount',
  'due_date',
  'balance',
  'overdue_amount',
  'days_overdue',
  'business_name',
] as const;

export type WhatsAppPlaceholder = (typeof WHATSAPP_PLACEHOLDERS)[number];
export type WhatsAppValues = Record<WhatsAppPlaceholder, string>;

export const WHATSAPP_MODES = ['click_to_chat', 'cloud_api'] as const;
export type WhatsAppMode = (typeof WHATSAPP_MODES)[number];

export const WHATSAPP_KINDS = ['invoice', 'statement', 'reminder'] as const;
export type WhatsAppKind = (typeof WHATSAPP_KINDS)[number];

export const DEFAULT_WHATSAPP_MESSAGES: Record<WhatsAppKind, string> = {
  invoice:
    'Assalam o Alaikum {customer_name},\n\nYour invoice {invoice_no} dated {invoice_date} for {amount} is attached. Please pay by {due_date}.\nYour total balance is {balance}.\n\nThank you,\n{business_name}',
  statement: 'Assalam o Alaikum {customer_name},\n\nYour account statement is attached. Your balance is {balance}.\n\nThank you,\n{business_name}',
  reminder:
    'Assalam o Alaikum {customer_name},\n\nThis is a friendly reminder that {overdue_amount} on your account is overdue (up to {days_overdue} days). Your total balance is {balance}. Please arrange the payment at your earliest.\n\nThank you,\n{business_name}',
};

/** Default Cloud API template body parameters ({{1}}, {{2}}, …) for each kind. */
export const DEFAULT_WHATSAPP_PARAMS: Record<WhatsAppKind, string> = {
  invoice: 'customer_name,invoice_no,amount,due_date',
  statement: 'customer_name,balance',
  reminder: 'customer_name,overdue_amount,days_overdue,balance',
};

function isPlaceholder(name: string): name is WhatsAppPlaceholder {
  return (WHATSAPP_PLACEHOLDERS as readonly string[]).includes(name);
}

/** Replaces {placeholder}s; anything unknown is left as typed. */
export function renderWhatsAppMessage(template: string, values: Partial<WhatsAppValues>): string {
  return template.replace(/\{([a-z_]+)\}/g, (whole, key: string) => (isPlaceholder(key) ? (values[key] ?? '') : whole));
}

/** Placeholders in a message that are not in the list (to warn while editing). */
export function unknownPlaceholders(template: string): string[] {
  const found = [...template.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1] as string);
  return [...new Set(found.filter((k) => !isPlaceholder(k)))];
}

/** "customer_name, amount" → ['customer_name', 'amount']; null if any name is unknown. */
export function parseWhatsAppParams(text: string): WhatsAppPlaceholder[] | null {
  const names = text
    .split(',')
    .map((s) => s.trim().replace(/^\{|\}$/g, ''))
    .filter(Boolean);
  return names.every(isPlaceholder) ? names : null;
}

/** Balance as customers read it: "Rs 12,000", or "Advance Rs 2,000" when they have paid ahead. */
export function balanceForCustomer(paisa: number): string {
  return paisa < 0 ? `Advance ${formatPaisa(-paisa)}` : formatPaisa(paisa);
}

/** "923001234567" for wa.me links (E.164 without the +). */
export function waMeNumber(e164: string): string {
  return e164.replace(/\D/g, '');
}

export function waMeUrl(e164: string, message: string): string {
  return `https://wa.me/${waMeNumber(e164)}?text=${encodeURIComponent(message)}`;
}

// --- API ------------------------------------------------------------------------------

export const whatsappStatementSchema = z.object({
  from: businessDateSchema.optional(),
  to: businessDateSchema.optional(),
});
export type WhatsAppStatementInput = z.infer<typeof whatsappStatementSchema>;

export const whatsappHistoryQuerySchema = z
  .object({
    sale_id: z.coerce.number().int().positive().optional(),
    customer_id: z.coerce.number().int().positive().optional(),
  })
  .refine((q) => q.sale_id !== undefined || q.customer_id !== undefined, 'Give a sale or a customer.');

/** What a send returns to the screen. */
export interface SendResult {
  log_id: number;
  mode: WhatsAppMode;
  /** opened: the wa.me link is ready to open (click-to-chat); sent: delivered to WhatsApp (Cloud API). */
  status: 'opened' | 'sent';
  /** Click-to-chat: the wa.me link to open in a new tab. */
  url: string | null;
  message: string;
  phone: string;
  /** File name of the saved PDF (none for reminders). */
  pdf_name: string | null;
  at: string;
}

export interface WhatsAppLogEntry {
  id: number;
  at: string;
  kind: WhatsAppKind;
  mode: WhatsAppMode;
  status: 'opened' | 'sent' | 'failed';
  phone: string | null;
  doc_no: string | null;
  sale_id: number | null;
  customer_id: number;
  user_name: string | null;
  error: string | null;
  pdf_name: string | null;
}

/** Error codes a send can fail with, so the screen can offer to fix the phone number. */
export const WHATSAPP_PHONE_ERRORS = ['PHONE_MISSING', 'PHONE_INVALID'] as const;

export interface CloudApiCheck {
  ok: true;
  display_phone_number: string | null;
  verified_name: string | null;
}
