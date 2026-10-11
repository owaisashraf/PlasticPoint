import { z } from 'zod';
import { DEFAULT_WHATSAPP_MESSAGES, DEFAULT_WHATSAPP_PARAMS, parseWhatsAppParams, WHATSAPP_MODES } from './whatsapp';

const bp = z.number().int().min(0).max(10_000);
const prefix = z
  .string()
  .trim()
  .regex(/^[A-Z]{2,6}$/, 'Use 2 to 6 capital letters');

const message = z.string().trim().min(1, 'Enter the message').max(1000);
const templateName = z
  .string()
  .trim()
  .regex(/^[a-z0-9_]{0,512}$/, 'Template names use small letters, numbers and _ only');
const templateParams = z
  .string()
  .trim()
  .max(300)
  .refine((v) => parseWhatsAppParams(v) !== null, 'Use placeholder names from the list, separated by commas');

/**
 * Every setting with its type and default. The settings table stores only the
 * values that differ from these defaults.
 */
export const settingsSchema = z
  .object({
    // Business details (printed on invoices)
    business_name: z.string().trim().max(120).default(''),
    business_address: z.string().trim().max(300).default(''),
    business_phone: z.string().trim().max(40).default(''),
    business_ntn: z.string().trim().max(40).default(''),
    business_strn: z.string().trim().max(40).default(''),

    // Payment terms
    default_payment_terms_days: z.number().int().min(0).max(365).default(30),
    grace_days: z.number().int().min(0).max(90).default(0),

    // Overdue colour bands: 1..amber_max amber, ..orange_max orange, beyond red
    overdue_amber_max_days: z.number().int().min(1).max(365).default(15),
    overdue_orange_max_days: z.number().int().min(2).max(730).default(45),

    // Price and discount
    default_supplier_margin_bp: bp.default(1200),
    default_customer_discount_bp: bp.default(1000),
    retail_discount_reduction_bp: bp.default(0),
    min_profit_bp: bp.default(0),
    below_min_profit_action: z.enum(['warn', 'require_owner']).default('warn'),
    operators_can_record_purchases: z.boolean().default(true),
    include_depreciation_in_profit: z.boolean().default(true),

    // Stock
    allow_negative_stock: z.boolean().default(false),

    // Fiscal year
    fiscal_year_start_month: z.number().int().min(1).max(12).default(7),

    // Document prefixes
    prefix_sale: prefix.default('INV'),
    prefix_purchase: prefix.default('PUR'),
    prefix_sales_return: prefix.default('SRN'),
    prefix_purchase_return: prefix.default('PRN'),
    prefix_receipt: prefix.default('RCV'),
    prefix_refund: prefix.default('RFD'),
    prefix_supplier_payment: prefix.default('PAY'),
    prefix_write_off: prefix.default('WOF'),
    prefix_expense: prefix.default('EXP'),
    prefix_asset: prefix.default('AST'),

    // Invoices
    invoice_paper_size: z.enum(['A4', '80mm']).default('A4'),

    // Network
    allow_lan_access: z.boolean().default(false),

    // Backups
    backup_time: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use 24-hour time, for example 21:00')
      .default('21:00'),
    backup_second_folder: z.string().trim().max(500).default(''),

    // WhatsApp (CLAUDE.md 13)
    whatsapp_mode: z.enum(WHATSAPP_MODES).default('click_to_chat'),
    whatsapp_invoice_message: message.default(DEFAULT_WHATSAPP_MESSAGES.invoice),
    whatsapp_statement_message: message.default(DEFAULT_WHATSAPP_MESSAGES.statement),
    whatsapp_reminder_message: message.default(DEFAULT_WHATSAPP_MESSAGES.reminder),
    // Cloud API (optional, official WhatsApp Business Platform)
    whatsapp_cloud_phone_number_id: z
      .string()
      .trim()
      .regex(/^(\d{5,30})?$/, 'The phone number ID is the long number shown in the WhatsApp Manager')
      .default(''),
    /** Secret: never sent to the browser, never written to the audit log or logs. */
    whatsapp_cloud_token: z.string().trim().max(1000).default(''),
    whatsapp_cloud_api_version: z
      .string()
      .trim()
      .regex(/^v\d{1,3}\.\d$/, 'Use a version like v23.0')
      .default('v23.0'),
    whatsapp_cloud_language: z
      .string()
      .trim()
      .regex(/^[a-z]{2,3}(_[A-Z]{2})?$/, 'Use a language code like en or en_US')
      .default('en'),
    whatsapp_cloud_invoice_template: templateName.default(''),
    whatsapp_cloud_statement_template: templateName.default(''),
    whatsapp_cloud_reminder_template: templateName.default(''),
    whatsapp_cloud_invoice_params: templateParams.default(DEFAULT_WHATSAPP_PARAMS.invoice),
    whatsapp_cloud_statement_params: templateParams.default(DEFAULT_WHATSAPP_PARAMS.statement),
    whatsapp_cloud_reminder_params: templateParams.default(DEFAULT_WHATSAPP_PARAMS.reminder),
  })
  .strict();

export type Settings = z.infer<typeof settingsSchema>;
export type SettingKey = keyof Settings;

export const SETTING_KEYS = Object.keys(settingsSchema.shape) as SettingKey[];

export const DEFAULT_SETTINGS: Settings = settingsSchema.parse({});

/**
 * Partial update sent by the Settings page. The defaults are removed first:
 * in zod 4, .partial() would still fill every missing key with its default,
 * and a patch would then reset every setting it did not mention.
 */
const patchShape = Object.fromEntries(
  Object.entries(settingsSchema.shape).map(([k, v]) => [k, (v as z.ZodDefault<z.ZodType>).unwrap().optional()]),
) as { [K in SettingKey]: z.ZodOptional<z.ZodType<Settings[K]>> };

export const settingsPatchSchema = z.object({
  changes: z.object(patchShape).strict(),
});
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

/** Cross-field rules, checked on the merged result of a patch. */
export function validateSettings(s: Settings): string[] {
  const errors: string[] = [];
  if (s.overdue_orange_max_days <= s.overdue_amber_max_days) {
    errors.push('The orange band must end after the amber band.');
  }
  const prefixes = [
    s.prefix_sale,
    s.prefix_purchase,
    s.prefix_sales_return,
    s.prefix_purchase_return,
    s.prefix_receipt,
    s.prefix_refund,
    s.prefix_supplier_payment,
    s.prefix_write_off,
    s.prefix_expense,
    s.prefix_asset,
  ];
  if (new Set(prefixes).size !== prefixes.length) {
    errors.push('Each document type needs its own prefix.');
  }
  if (s.whatsapp_mode === 'cloud_api' && (!s.whatsapp_cloud_phone_number_id || !s.whatsapp_cloud_token || !s.whatsapp_cloud_invoice_template)) {
    errors.push('To use the WhatsApp Cloud API, first save the phone number ID, the access token and the invoice template name.');
  }
  return errors;
}

/**
 * Settings every logged-in user may read (used for invoices, terms and
 * colours). Price, margin and profit settings are owner+ only.
 */
export const PUBLIC_SETTING_KEYS = [
  'business_name',
  'business_address',
  'business_phone',
  'business_ntn',
  'business_strn',
  'default_payment_terms_days',
  'grace_days',
  'overdue_amber_max_days',
  'overdue_orange_max_days',
  'default_customer_discount_bp',
  'retail_discount_reduction_bp',
  'allow_negative_stock',
  'fiscal_year_start_month',
  'invoice_paper_size',
  'operators_can_record_purchases',
  'whatsapp_mode',
] as const satisfies readonly SettingKey[];

export type PublicSettings = Pick<Settings, (typeof PUBLIC_SETTING_KEYS)[number]>;

/** Settings that only take effect after ShopLedger is restarted. */
export const RESTART_SETTING_KEYS: readonly SettingKey[] = ['allow_lan_access'];

/** Settings that are never sent to the browser or written to the audit log. */
export const SECRET_SETTING_KEYS = ['whatsapp_cloud_token'] as const satisfies readonly SettingKey[];
export type SecretSettingKey = (typeof SECRET_SETTING_KEYS)[number];

/** What GET /api/settings returns: secrets blanked, with a flag saying whether each is set. */
export type SettingsView = Settings & { secrets_set: Record<SecretSettingKey, boolean> };
