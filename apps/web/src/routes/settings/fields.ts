import type { SettingKey } from '@shopledger/shared';

export type FieldDef =
  | { key: SettingKey; label: string; kind: 'text'; hint?: string; wide?: boolean }
  | { key: SettingKey; label: string; kind: 'int'; min: number; max: number; suffix?: string; hint?: string }
  | { key: SettingKey; label: string; kind: 'percent'; hint?: string }
  | { key: SettingKey; label: string; kind: 'bool'; hint?: string }
  | { key: SettingKey; label: string; kind: 'select'; options: [string, string][]; hint?: string }
  | { key: SettingKey; label: string; kind: 'time'; hint?: string };

export interface SectionDef {
  id: string;
  title: string;
  description?: string;
  fields: FieldDef[];
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export const SECTIONS: SectionDef[] = [
  {
    id: 'business',
    title: 'Business',
    description: 'Printed on invoices and statements.',
    fields: [
      { key: 'business_name', label: 'Business name', kind: 'text', wide: true },
      { key: 'business_address', label: 'Address', kind: 'text', wide: true },
      { key: 'business_phone', label: 'Phone', kind: 'text' },
      { key: 'business_ntn', label: 'NTN', kind: 'text' },
      { key: 'business_strn', label: 'STRN', kind: 'text' },
    ],
  },
  {
    id: 'terms',
    title: 'Payment terms',
    fields: [
      {
        key: 'default_payment_terms_days',
        label: 'Default payment terms',
        kind: 'int',
        min: 0,
        max: 365,
        suffix: 'days',
        hint: 'Given to new customers. Each customer and each sale can change it.',
      },
      { key: 'grace_days', label: 'Grace days', kind: 'int', min: 0, max: 90, suffix: 'days', hint: 'Extra days after the due date before an invoice counts as overdue.' },
      { key: 'overdue_amber_max_days', label: 'Amber up to', kind: 'int', min: 1, max: 365, suffix: 'days overdue' },
      { key: 'overdue_orange_max_days', label: 'Orange up to', kind: 'int', min: 2, max: 730, suffix: 'days overdue', hint: 'Anything later is red.' },
    ],
  },
  {
    id: 'pricing',
    title: 'Prices & discounts',
    description: 'Every percentage is taken off the product price. Example: price Rs 1,000, supplier margin 12% → cost Rs 880; customer discount 10% → customer pays Rs 900; profit Rs 20.',
    fields: [
      { key: 'default_supplier_margin_bp', label: 'Default supplier margin', kind: 'percent', hint: 'Used when creating products.' },
      { key: 'default_customer_discount_bp', label: 'Default customer discount', kind: 'percent', hint: 'Used when creating products.' },
      { key: 'retail_discount_reduction_bp', label: 'Smaller discount for retailers by', kind: 'percent', hint: 'Subtracted from the discount for retail customers. 0 means the same as wholesalers.' },
      { key: 'min_profit_bp', label: 'Minimum profit', kind: 'percent', hint: 'Lowest allowed profit on a sale line, as a % of price.' },
      {
        key: 'below_min_profit_action',
        label: 'When profit is below the minimum',
        kind: 'select',
        options: [
          ['warn', 'Warn only'],
          ['require_owner', 'Ask for owner approval'],
        ],
        hint: 'Selling below cost always needs owner approval.',
      },
      { key: 'operators_can_record_purchases', label: 'Operators can record purchases', kind: 'bool', hint: 'The purchase screen shows supplier margin and cost.' },
      { key: 'include_depreciation_in_profit', label: 'Include depreciation in net profit', kind: 'bool' },
    ],
  },
  {
    id: 'stock',
    title: 'Stock',
    fields: [
      {
        key: 'allow_negative_stock',
        label: 'Allow selling more than in stock',
        kind: 'bool',
        hint: 'Off: owner confirmation is needed. On: a warning only.',
      },
    ],
  },
  {
    id: 'fiscal',
    title: 'Fiscal year',
    fields: [
      {
        key: 'fiscal_year_start_month',
        label: 'Fiscal year starts in',
        kind: 'select',
        options: MONTHS.map((m, i) => [String(i + 1), m]),
        hint: 'July for the Pakistani fiscal year (July–June).',
      },
    ],
  },
  {
    id: 'documents',
    title: 'Documents',
    description: 'Prefixes for document numbers, e.g. INV-000123. Numbers are never reused.',
    fields: [
      { key: 'prefix_sale', label: 'Sale invoice', kind: 'text' },
      { key: 'prefix_purchase', label: 'Purchase', kind: 'text' },
      { key: 'prefix_sales_return', label: 'Sales return', kind: 'text' },
      { key: 'prefix_purchase_return', label: 'Purchase return', kind: 'text' },
      { key: 'prefix_receipt', label: 'Receipt', kind: 'text' },
      { key: 'prefix_refund', label: 'Refund', kind: 'text' },
      { key: 'prefix_supplier_payment', label: 'Supplier payment', kind: 'text' },
      { key: 'prefix_write_off', label: 'Write-off', kind: 'text' },
      { key: 'prefix_expense', label: 'Expense', kind: 'text' },
      { key: 'prefix_asset', label: 'Asset', kind: 'text' },
      {
        key: 'invoice_paper_size',
        label: 'Invoice paper',
        kind: 'select',
        options: [
          ['A4', 'A4'],
          ['80mm', '80 mm thermal'],
        ],
      },
    ],
  },
  {
    id: 'network',
    title: 'Network',
    fields: [
      {
        key: 'allow_lan_access',
        label: 'Allow other devices on the shop Wi-Fi',
        kind: 'bool',
        hint: 'Takes effect after ShopLedger is restarted.',
      },
    ],
  },
  {
    id: 'backups',
    title: 'Backups',
    fields: [
      { key: 'backup_time', label: 'Daily backup time', kind: 'time', hint: '24-hour time. A backup is also taken at start-up (if the last is over 12 hours old) and when ShopLedger closes.' },
      {
        key: 'backup_second_folder',
        label: 'Second backup folder (optional)',
        kind: 'text',
        wide: true,
        hint: 'A USB drive or a Google Drive / OneDrive folder on this laptop, e.g. D:\\ShopLedger-Backups',
      },
    ],
  },
];
