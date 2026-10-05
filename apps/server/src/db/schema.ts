import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

// Conventions (CLAUDE.md section 7): money columns end in _paisa (integers),
// percentages end in _bp (integers), business dates are TEXT 'YYYY-MM-DD',
// timestamps are ISO-8601 UTC TEXT.

const nowIso = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

/** Key/value settings. Only values that differ from the defaults are stored. */
export const settings = sqliteTable('settings', {
  key: text().primaryKey(),
  value_json: text().notNull(),
  updated_at: text().notNull().default(nowIso),
  updated_by: integer().references(() => users.id),
});

export const users = sqliteTable(
  'users',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    username: text().notNull(),
    display_name: text().notNull(),
    password_hash: text().notNull(),
    role: text({ enum: ['superuser', 'owner', 'operator'] }).notNull(),
    active: integer({ mode: 'boolean' }).notNull().default(true),
    created_by: integer(),
    created_at: text().notNull().default(nowIso),
    updated_at: text().notNull().default(nowIso),
  },
  (t) => [
    uniqueIndex('users_username_uq').on(t.username),
    // At most one superuser, enforced by the database itself.
    uniqueIndex('users_single_superuser_uq').on(t.role).where(sql`role = 'superuser'`),
  ],
);

/** Login sessions. `id` is the SHA-256 of the cookie token, never the token itself. */
export const sessions = sqliteTable(
  'sessions',
  {
    id: text().primaryKey(),
    user_id: integer()
      .notNull()
      .references(() => users.id),
    created_at: text().notNull(),
    last_seen_at: text().notNull(),
    ip: text(),
    user_agent: text(),
  },
  (t) => [index('sessions_user_idx').on(t.user_id)],
);

/**
 * Append-only audit log (CLAUDE.md 8.14). A migration adds triggers that abort
 * any UPDATE or DELETE. user_id is not a foreign key on purpose: the log must
 * stay writable even when the acting user does not exist in this database
 * (failed logins, CLI resets, restores).
 */
export const audit_log = sqliteTable(
  'audit_log',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    at: text().notNull(),
    user_id: integer(),
    user_role: text(),
    action: text().notNull(),
    entity: text().notNull(),
    entity_id: integer(),
    doc_no: text(),
    version_before: integer(),
    version_after: integer(),
    before_json: text(),
    after_json: text(),
    summary_json: text(),
    flags: text().notNull().default('[]'),
    reason: text(),
    prev_hash: text().notNull(),
    row_hash: text().notNull(),
  },
  (t) => [
    index('audit_log_entity_idx').on(t.entity, t.entity_id),
    index('audit_log_at_idx').on(t.at),
    index('audit_log_user_idx').on(t.user_id),
    uniqueIndex('audit_log_row_hash_uq').on(t.row_hash),
  ],
);

/** Superuser review marks, kept apart so the audit log itself never changes. */
export const audit_reviews = sqliteTable(
  'audit_reviews',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    audit_id: integer()
      .notNull()
      .references(() => audit_log.id),
    reviewed_by: integer()
      .notNull()
      .references(() => users.id),
    reviewed_at: text().notNull(),
    note: text(),
  },
  (t) => [index('audit_reviews_audit_idx').on(t.audit_id)],
);

export const backup_log = sqliteTable(
  'backup_log',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    started_at: text().notNull(),
    finished_at: text(),
    /** File name only (inside DATA_DIR/backups), so the data folder stays portable. */
    file_name: text().notNull(),
    size_bytes: integer(),
    trigger: text({ enum: ['scheduled', 'startup', 'shutdown', 'manual', 'pre_restore'] }).notNull(),
    status: text({ enum: ['ok', 'failed'] }).notNull(),
    error: text(),
    /** Last audit row contained in the backup, to detect a truncated audit tail. */
    audit_last_id: integer(),
    audit_last_hash: text(),
    second_copy_status: text({ enum: ['ok', 'failed', 'skipped'] })
      .notNull()
      .default('skipped'),
    second_copy_error: text(),
  },
  (t) => [index('backup_log_started_idx').on(t.started_at)],
);

/** Counters for customer codes and document numbers. Numbers are never reused. */
export const sequences = sqliteTable('sequences', {
  name: text().primaryKey(),
  last_value: integer().notNull(),
});

// --- Parties -----------------------------------------------------------------

/**
 * Customers. Balances and opening balances are not stored here: they come from
 * ledger_entries (the opening balance is an 'opening_balance' entry).
 * A trigram FTS5 index (customers_fts) is kept in sync by triggers in a
 * hand-written migration.
 */
export const customers = sqliteTable(
  'customers',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    code: text().notNull(),
    name: text().notNull(),
    business_name: text(),
    type: text({ enum: ['wholesaler', 'retailer'] }).notNull(),
    phone: text(),
    alt_phone: text(),
    city: text(),
    area: text(),
    address: text(),
    ntn: text(),
    credit_limit_paisa: integer().notNull().default(0),
    payment_terms_days: integer().notNull(),
    status: text({ enum: ['active', 'inactive', 'bad_debt'] }).notNull().default('active'),
    bad_debt_marked_at: text(),
    bad_debt_reason: text(),
    notes: text(),
    created_by: integer().references(() => users.id),
    created_at: text().notNull().default(nowIso),
    updated_at: text().notNull().default(nowIso),
  },
  (t) => [
    uniqueIndex('customers_code_uq').on(t.code),
    index('customers_status_idx').on(t.status),
    index('customers_city_idx').on(t.city),
    check('customers_credit_limit_ck', sql`${t.credit_limit_paisa} >= 0`),
  ],
);

/** The manufacturer we buy from. A table, because more suppliers may come later. */
export const suppliers = sqliteTable('suppliers', {
  id: integer().primaryKey({ autoIncrement: true }),
  name: text().notNull(),
  phone: text(),
  address: text(),
  ntn: text(),
  notes: text(),
  active: integer({ mode: 'boolean' }).notNull().default(true),
  created_at: text().notNull().default(nowIso),
  updated_at: text().notNull().default(nowIso),
});

// --- Products ----------------------------------------------------------------

/** One price per product, shared by all its sizes and colors (CLAUDE.md 8.10). */
export const products = sqliteTable(
  'products',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    item_code: text().notNull(),
    name: text().notNull(),
    category: text(),
    unit: text({ enum: ['pcs', 'dozen', 'set', 'carton'] }).notNull().default('pcs'),
    sizes: text({ mode: 'json' }).$type<string[]>().notNull().default(sql`'[]'`),
    colors: text({ mode: 'json' }).$type<string[]>().notNull().default(sql`'[]'`),
    list_price_paisa: integer().notNull(),
    supplier_margin_bp: integer().notNull(),
    default_customer_discount_bp: integer().notNull(),
    max_customer_discount_bp: integer(),
    active: integer({ mode: 'boolean' }).notNull().default(true),
    created_by: integer().references(() => users.id),
    created_at: text().notNull().default(nowIso),
    updated_at: text().notNull().default(nowIso),
  },
  (t) => [
    uniqueIndex('products_item_code_uq').on(t.item_code),
    index('products_category_idx').on(t.category),
    check('products_price_ck', sql`${t.list_price_paisa} > 0`),
    check('products_margin_ck', sql`${t.supplier_margin_bp} BETWEEN 0 AND 10000`),
    check('products_discount_ck', sql`${t.default_customer_discount_bp} BETWEEN 0 AND 10000`),
    check('products_max_discount_ck', sql`${t.max_customer_discount_bp} IS NULL OR ${t.max_customer_discount_bp} BETWEEN 0 AND 10000`),
  ],
);

/** One product + color + size. Stock and document lines point here. No price of its own. */
export const product_variants = sqliteTable(
  'product_variants',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    product_id: integer()
      .notNull()
      .references(() => products.id),
    color: text().notNull().default(''),
    size: text().notNull().default(''),
    sku: text().notNull(),
    /** Weighted average actual purchase cost; null until the first purchase. */
    avg_cost_paisa: integer(),
    low_stock_threshold: integer().notNull().default(0),
    active: integer({ mode: 'boolean' }).notNull().default(true),
    created_at: text().notNull().default(nowIso),
    updated_at: text().notNull().default(nowIso),
  },
  (t) => [
    uniqueIndex('product_variants_sku_uq').on(t.sku),
    uniqueIndex('product_variants_combo_uq').on(t.product_id, t.color, t.size),
  ],
);

export const product_price_history = sqliteTable(
  'product_price_history',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    product_id: integer()
      .notNull()
      .references(() => products.id),
    effective_date: text().notNull(),
    list_price_paisa: integer().notNull(),
    supplier_margin_bp: integer().notNull(),
    default_customer_discount_bp: integer().notNull(),
    changed_by: integer().references(() => users.id),
    created_at: text().notNull().default(nowIso),
  },
  (t) => [index('product_price_history_product_idx').on(t.product_id, t.id)],
);

// --- Ledger and stock ---------------------------------------------------------

/**
 * Customer and supplier ledgers (CLAUDE.md 8.3).
 * Customer balance = Σdebit − Σcredit; supplier balance = Σcredit − Σdebit.
 * party_id is not a foreign key because it points at customers or suppliers.
 */
export const ledger_entries = sqliteTable(
  'ledger_entries',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    party_type: text({ enum: ['customer', 'supplier'] }).notNull(),
    party_id: integer().notNull(),
    date: text().notNull(),
    debit_paisa: integer().notNull().default(0),
    credit_paisa: integer().notNull().default(0),
    entry_type: text().notNull(),
    source_type: text().notNull(),
    source_id: integer().notNull(),
    narration: text(),
    created_at: text().notNull().default(nowIso),
  },
  (t) => [
    index('ledger_entries_party_idx').on(t.party_type, t.party_id, t.date),
    index('ledger_entries_source_idx').on(t.source_type, t.source_id),
    check('ledger_entries_amounts_ck', sql`${t.debit_paisa} >= 0 AND ${t.credit_paisa} >= 0`),
    check('ledger_entries_one_side_ck', sql`(${t.debit_paisa} = 0) <> (${t.credit_paisa} = 0)`),
  ],
);

/** Stock on hand for a variant = Σ qty_change. */
export const stock_movements = sqliteTable(
  'stock_movements',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    variant_id: integer()
      .notNull()
      .references(() => product_variants.id),
    date: text().notNull(),
    qty_change: integer().notNull(),
    unit_cost_paisa: integer(),
    source_type: text().notNull(),
    source_id: integer().notNull(),
    created_at: text().notNull().default(nowIso),
  },
  (t) => [
    index('stock_movements_variant_idx').on(t.variant_id),
    index('stock_movements_source_idx').on(t.source_type, t.source_id),
    check('stock_movements_qty_ck', sql`${t.qty_change} <> 0`),
  ],
);

// --- Purchases (CLAUDE.md 8.9) ---------------------------------------------------

/** Goods bought from the supplier. Totals are captured at posting (part of the document). */
export const purchases = sqliteTable(
  'purchases',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    doc_no: text().notNull(),
    supplier_id: integer()
      .notNull()
      .references(() => suppliers.id),
    date: text().notNull(),
    supplier_ref: text(),
    notes: text(),
    gross_paisa: integer().notNull(),
    margin_paisa: integer().notNull(),
    /** What we owe the supplier for this bill (gross − margin). */
    total_cost_paisa: integer().notNull(),
    status: text({ enum: ['posted', 'void'] }).notNull().default('posted'),
    version: integer().notNull().default(1),
    created_by: integer().references(() => users.id),
    updated_by: integer().references(() => users.id),
    created_at: text().notNull().default(nowIso),
    updated_at: text().notNull().default(nowIso),
  },
  (t) => [
    uniqueIndex('purchases_doc_no_uq').on(t.doc_no),
    index('purchases_date_idx').on(t.date),
    index('purchases_supplier_idx').on(t.supplier_id, t.status),
  ],
);

export const purchase_items = sqliteTable(
  'purchase_items',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    purchase_id: integer()
      .notNull()
      .references(() => purchases.id),
    line_no: integer().notNull(),
    variant_id: integer()
      .notNull()
      .references(() => product_variants.id),
    qty: integer().notNull(),
    /** Price on the manufacturer's bill. */
    list_price_paisa: integer().notNull(),
    supplier_margin_bp: integer().notNull(),
    line_gross_paisa: integer().notNull(),
    line_margin_paisa: integer().notNull(),
    line_cost_paisa: integer().notNull(),
    unit_cost_paisa: integer().notNull(),
  },
  (t) => [
    index('purchase_items_purchase_idx').on(t.purchase_id),
    index('purchase_items_variant_idx').on(t.variant_id),
    check('purchase_items_qty_ck', sql`${t.qty} > 0`),
    check('purchase_items_margin_ck', sql`${t.supplier_margin_bp} BETWEEN 0 AND 10000`),
  ],
);

/** Goods sent back to the supplier (debit note), always linked to the original purchase. */
export const purchase_returns = sqliteTable(
  'purchase_returns',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    doc_no: text().notNull(),
    purchase_id: integer()
      .notNull()
      .references(() => purchases.id),
    supplier_id: integer()
      .notNull()
      .references(() => suppliers.id),
    date: text().notNull(),
    reason: text().notNull(),
    total_cost_paisa: integer().notNull(),
    status: text({ enum: ['posted', 'void'] }).notNull().default('posted'),
    version: integer().notNull().default(1),
    created_by: integer().references(() => users.id),
    updated_by: integer().references(() => users.id),
    created_at: text().notNull().default(nowIso),
    updated_at: text().notNull().default(nowIso),
  },
  (t) => [uniqueIndex('purchase_returns_doc_no_uq').on(t.doc_no), index('purchase_returns_purchase_idx').on(t.purchase_id), index('purchase_returns_date_idx').on(t.date)],
);

export const purchase_return_items = sqliteTable(
  'purchase_return_items',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    return_id: integer()
      .notNull()
      .references(() => purchase_returns.id),
    purchase_item_id: integer()
      .notNull()
      .references(() => purchase_items.id),
    variant_id: integer()
      .notNull()
      .references(() => product_variants.id),
    qty: integer().notNull(),
    unit_cost_paisa: integer().notNull(),
    line_cost_paisa: integer().notNull(),
  },
  (t) => [
    index('purchase_return_items_return_idx').on(t.return_id),
    index('purchase_return_items_item_idx').on(t.purchase_item_id),
    check('purchase_return_items_qty_ck', sql`${t.qty} > 0`),
  ],
);

// --- Sales (CLAUDE.md 8.10, 8.11) ---------------------------------------------------

/**
 * Goods sold to a customer. Totals are part of the document. Paid and
 * outstanding amounts are never stored: they come from payment_allocations.
 */
export const sales = sqliteTable(
  'sales',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    doc_no: text().notNull(),
    customer_id: integer()
      .notNull()
      .references(() => customers.id),
    date: text().notNull(),
    payment_terms_days: integer().notNull(),
    due_date: text().notNull(),
    /** Σ qty × price */
    gross_paisa: integer().notNull(),
    /** Σ line discounts */
    line_discount_paisa: integer().notNull(),
    extra_discount_paisa: integer().notNull().default(0),
    tax_paisa: integer().notNull().default(0),
    /** gross − line discounts − extra discount + tax: what the customer owes for this invoice */
    total_paisa: integer().notNull(),
    status: text({ enum: ['posted', 'void'] }).notNull().default('posted'),
    version: integer().notNull().default(1),
    notes: text(),
    /** The owner or superuser who approved a safety-rule exception, if any. */
    approved_by: integer().references(() => users.id),
    created_by: integer().references(() => users.id),
    updated_by: integer().references(() => users.id),
    created_at: text().notNull().default(nowIso),
    updated_at: text().notNull().default(nowIso),
  },
  (t) => [
    uniqueIndex('sales_doc_no_uq').on(t.doc_no),
    index('sales_customer_idx').on(t.customer_id, t.status, t.due_date),
    index('sales_date_idx').on(t.date),
    check('sales_amounts_ck', sql`${t.total_paisa} >= 0 AND ${t.extra_discount_paisa} >= 0 AND ${t.tax_paisa} >= 0`),
  ],
);

/** Sale lines. Price, discount, cost and profit are captured at posting (part of the document). */
export const sale_items = sqliteTable(
  'sale_items',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    sale_id: integer()
      .notNull()
      .references(() => sales.id),
    line_no: integer().notNull(),
    variant_id: integer()
      .notNull()
      .references(() => product_variants.id),
    qty: integer().notNull(),
    /** The product's price at the time of sale. */
    list_price_paisa: integer().notNull(),
    /** What the system suggested. */
    default_discount_bp: integer().notNull(),
    /** What was actually given. */
    discount_bp: integer().notNull(),
    discount_overridden: integer({ mode: 'boolean' }).notNull().default(false),
    line_gross_paisa: integer().notNull(),
    line_discount_paisa: integer().notNull(),
    /** After the line discount and this line's share of the extra invoice discount. */
    line_net_paisa: integer().notNull(),
    unit_cost_paisa: integer().notNull(),
    cost_source: text({ enum: ['purchase_avg', 'estimated'] }).notNull(),
    line_cost_paisa: integer().notNull(),
    profit_paisa: integer().notNull(),
  },
  (t) => [
    index('sale_items_sale_idx').on(t.sale_id),
    index('sale_items_variant_idx').on(t.variant_id),
    check('sale_items_qty_ck', sql`${t.qty} > 0`),
    check('sale_items_discount_ck', sql`${t.discount_bp} BETWEEN 0 AND 10000 AND ${t.default_discount_bp} BETWEEN 0 AND 10000`),
  ],
);

// --- Payments and allocation (CLAUDE.md 8.5) ----------------------------------------

/**
 * Money received from a customer (receipt), paid to the supplier, or refunded
 * to a customer for returned goods.
 */
export const payments = sqliteTable(
  'payments',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    doc_no: text().notNull(),
    kind: text({ enum: ['receipt', 'supplier_payment', 'refund'] }).notNull().default('receipt'),
    party_type: text({ enum: ['customer', 'supplier'] }).notNull(),
    party_id: integer().notNull(),
    date: text().notNull(),
    amount_paisa: integer().notNull(),
    method: text({ enum: ['cash', 'bank', 'cheque', 'online'] }).notNull(),
    reference: text(),
    cheque_no: text(),
    cheque_bank: text(),
    cheque_date: text(),
    status: text({ enum: ['posted', 'void', 'bounced'] }).notNull().default('posted'),
    /** Set when the money was taken at the counter together with this sale. */
    sale_id: integer().references(() => sales.id),
    /** Refunds: the sales return the money was paid back for. */
    sales_return_id: integer().references(() => sales_returns.id),
    bounced_at: text(),
    bounce_reason: text(),
    version: integer().notNull().default(1),
    notes: text(),
    created_by: integer().references(() => users.id),
    updated_by: integer().references(() => users.id),
    created_at: text().notNull().default(nowIso),
    updated_at: text().notNull().default(nowIso),
  },
  (t) => [
    uniqueIndex('payments_doc_no_uq').on(t.doc_no),
    index('payments_party_idx').on(t.party_type, t.party_id, t.date),
    index('payments_date_idx').on(t.date),
    check('payments_amount_ck', sql`${t.amount_paisa} > 0`),
  ],
);

/**
 * Links money or credit to what it pays off (CLAUDE.md 8.5): an invoice or,
 * when sale_id is null, the customer's owed opening balance (treated as the
 * oldest debt). Sources are receipts, sales returns, write-offs and an
 * opening advance (source_type 'opening_balance', source_id = customer id).
 */
export const payment_allocations = sqliteTable(
  'payment_allocations',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    customer_id: integer()
      .notNull()
      .references(() => customers.id),
    source_type: text({ enum: ['payment', 'sales_return', 'write_off', 'opening_balance'] }).notNull(),
    source_id: integer().notNull(),
    /** Null means the customer's opening balance. */
    sale_id: integer().references(() => sales.id),
    amount_paisa: integer().notNull(),
    /** Picked by the user (kept when auto allocations are recalculated). */
    is_manual: integer({ mode: 'boolean' }).notNull().default(false),
    created_at: text().notNull().default(nowIso),
  },
  (t) => [
    index('payment_allocations_sale_idx').on(t.sale_id),
    index('payment_allocations_customer_idx').on(t.customer_id),
    index('payment_allocations_source_idx').on(t.source_type, t.source_id),
    check('payment_allocations_amount_ck', sql`${t.amount_paisa} > 0`),
  ],
);

// --- Sales returns (CLAUDE.md 8.7) -------------------------------------------------

/** Goods coming back from a customer (credit note), always linked to the original invoice. */
export const sales_returns = sqliteTable(
  'sales_returns',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    doc_no: text().notNull(),
    sale_id: integer()
      .notNull()
      .references(() => sales.id),
    customer_id: integer()
      .notNull()
      .references(() => customers.id),
    date: text().notNull(),
    reason: text().notNull(),
    /** Credit given: the discounted amount the customer actually paid for these goods. */
    total_paisa: integer().notNull(),
    status: text({ enum: ['posted', 'void'] }).notNull().default('posted'),
    version: integer().notNull().default(1),
    created_by: integer().references(() => users.id),
    updated_by: integer().references(() => users.id),
    created_at: text().notNull().default(nowIso),
    updated_at: text().notNull().default(nowIso),
  },
  (t) => [
    uniqueIndex('sales_returns_doc_no_uq').on(t.doc_no),
    index('sales_returns_sale_idx').on(t.sale_id),
    index('sales_returns_customer_idx').on(t.customer_id),
    index('sales_returns_date_idx').on(t.date),
  ],
);

export const sales_return_items = sqliteTable(
  'sales_return_items',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    return_id: integer()
      .notNull()
      .references(() => sales_returns.id),
    sale_item_id: integer()
      .notNull()
      .references(() => sale_items.id),
    variant_id: integer()
      .notNull()
      .references(() => product_variants.id),
    qty: integer().notNull(),
    /** The sale line's unit cost: stock comes back in at what it went out at. */
    unit_cost_paisa: integer().notNull(),
    /** returned qty × (line net ÷ qty) */
    line_net_paisa: integer().notNull(),
    line_cost_paisa: integer().notNull(),
    /** line net − line cost, taken off gross profit in the period of the return. */
    profit_reversed_paisa: integer().notNull(),
  },
  (t) => [
    index('sales_return_items_return_idx').on(t.return_id),
    index('sales_return_items_item_idx').on(t.sale_item_id),
    check('sales_return_items_qty_ck', sql`${t.qty} > 0`),
  ],
);

// --- Bad debt (CLAUDE.md 8.8) ----------------------------------------------------

export const write_offs = sqliteTable(
  'write_offs',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    doc_no: text().notNull(),
    customer_id: integer()
      .notNull()
      .references(() => customers.id),
    date: text().notNull(),
    amount_paisa: integer().notNull(),
    reason: text().notNull(),
    status: text({ enum: ['posted', 'void'] }).notNull().default('posted'),
    version: integer().notNull().default(1),
    created_by: integer().references(() => users.id),
    updated_by: integer().references(() => users.id),
    created_at: text().notNull().default(nowIso),
    updated_at: text().notNull().default(nowIso),
  },
  (t) => [
    uniqueIndex('write_offs_doc_no_uq').on(t.doc_no),
    index('write_offs_customer_idx').on(t.customer_id),
    index('write_offs_date_idx').on(t.date),
    check('write_offs_amount_ck', sql`${t.amount_paisa} > 0`),
  ],
);

/** A recovered bad debt: all or part of a write-off taken back (a debit), before the receipt is recorded. */
export const write_off_reversals = sqliteTable(
  'write_off_reversals',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    write_off_id: integer()
      .notNull()
      .references(() => write_offs.id),
    customer_id: integer()
      .notNull()
      .references(() => customers.id),
    date: text().notNull(),
    amount_paisa: integer().notNull(),
    reason: text().notNull(),
    created_by: integer().references(() => users.id),
    created_at: text().notNull().default(nowIso),
  },
  (t) => [
    index('write_off_reversals_write_off_idx').on(t.write_off_id),
    index('write_off_reversals_date_idx').on(t.date),
    check('write_off_reversals_amount_ck', sql`${t.amount_paisa} > 0`),
  ],
);
