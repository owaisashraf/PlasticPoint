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
