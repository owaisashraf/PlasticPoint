import { and, desc, eq, gte, inArray, lte, notInArray, sql, type SQL } from 'drizzle-orm';
import {
  DOCUMENT_ENTITIES,
  changelogQuerySchema,
  type ChangeDetail,
  type ChangeRow,
  type DiscountOverrideRow,
  type Sale,
} from '@shopledger/shared';
import type { z } from 'zod';
import { writeTx, type DB, type DbOrTx } from '../../db/client';
import { audit_log, audit_reviews, customers, product_variants, products, sale_items, sales, suppliers, users } from '../../db/schema';
import { nowIso } from '../../lib/dates';
import { diffSnapshots } from '../../lib/documents';
import { notFound } from '../../lib/errors';
import type { SessionUser } from '../../lib/permissions';
import { getSettings } from '../settings/service';

type Query = z.output<typeof changelogQuerySchema>;
type AuditRow = typeof audit_log.$inferSelect;
type Snap = Record<string, unknown>;

// --- Reading the log ------------------------------------------------------------------

/** The party a row belongs to, as SQL, for the customer filter. */
const customerIdSql = sql`coalesce(
  json_extract(${audit_log.after_json}, '$.customer_id'),
  json_extract(${audit_log.before_json}, '$.customer_id'),
  json_extract(${audit_log.summary_json}, '$.customer_id'),
  CASE WHEN json_extract(coalesce(${audit_log.after_json}, ${audit_log.before_json}), '$.party_type') = 'customer'
       THEN json_extract(coalesce(${audit_log.after_json}, ${audit_log.before_json}), '$.party_id') END)`;

/** Flagged = any flag other than by_operator (which is information, not a warning). */
const flaggedSql = sql`EXISTS (SELECT 1 FROM json_each(${audit_log.flags}) WHERE value <> 'by_operator')`;
const reviewedSql = sql`EXISTS (SELECT 1 FROM audit_reviews r WHERE r.audit_id = ${audit_log.id})`;

/** Business (Karachi, UTC+5) date of the audit timestamp. */
const atDateSql = sql`date(${audit_log.at}, '+5 hours')`;

function conditions(q: Query): SQL | undefined {
  const conds: (SQL | undefined)[] = [];
  if (q.tab === 'invoices') conds.push(eq(audit_log.entity, 'sale'));
  else if (q.tab === 'documents') conds.push(inArray(audit_log.entity, [...DOCUMENT_ENTITIES]));
  else conds.push(notInArray(audit_log.entity, ['sale', ...DOCUMENT_ENTITIES]));
  if (q.from) conds.push(gte(atDateSql, q.from));
  if (q.to) conds.push(lte(atDateSql, q.to));
  if (q.user_id) conds.push(eq(audit_log.user_id, q.user_id));
  if (q.role) conds.push(eq(audit_log.user_role, q.role));
  if (q.action) conds.push(eq(audit_log.action, q.action));
  if (q.entity) conds.push(eq(audit_log.entity, q.entity));
  if (q.customer_id) conds.push(sql`${customerIdSql} = ${q.customer_id}`);
  if (q.flag) conds.push(sql`EXISTS (SELECT 1 FROM json_each(${audit_log.flags}) WHERE value = ${q.flag})`);
  if (q.flagged_only) conds.push(flaggedSql);
  if (q.unreviewed) conds.push(sql`NOT ${reviewedSql}`);
  if (q.q) {
    const like = `%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    conds.push(sql`(coalesce(${audit_log.doc_no}, '') LIKE ${like} ESCAPE '\\' OR coalesce(${audit_log.reason}, '') LIKE ${like} ESCAPE '\\')`);
  }
  return and(...conds);
}

const parse = (s: string | null): Snap | null => (s ? (JSON.parse(s) as Snap) : null);
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

/** The document total in a snapshot (0 once void). */
function totalOf(entity: string, s: Snap | null): number | null {
  if (!s) return null;
  if (s.status === 'void') return 0;
  switch (entity) {
    case 'sale':
    case 'sales_return':
      return num(s.total_paisa);
    case 'purchase':
    case 'purchase_return':
      return num(s.total_cost_paisa);
    case 'payment':
    case 'write_off':
      return num(s.amount_paisa);
    default:
      return null;
  }
}

/** What a document adds to the customer's balance (or what we owe the supplier). */
function balanceEffect(entity: string, s: Snap | null): number {
  if (!s || s.status !== 'posted') return 0;
  switch (entity) {
    case 'sale':
    case 'purchase':
      return totalOf(entity, s) ?? 0;
    case 'sales_return':
    case 'purchase_return':
      return -(totalOf(entity, s) ?? 0);
    case 'payment':
      return s.kind === 'refund' ? num(s.amount_paisa) : -num(s.amount_paisa);
    case 'write_off':
      return -(num(s.amount_paisa) - num(s.reversed_paisa));
    default:
      return 0;
  }
}

const HAS_TOTAL = new Set(['sale', 'sales_return', 'purchase', 'purchase_return', 'payment', 'write_off']);

function partyNames(db: DbOrTx, rows: { before: Snap | null; after: Snap | null }[]) {
  const custIds = new Set<number>();
  const supIds = new Set<number>();
  for (const { before, after } of rows) {
    const s = after ?? before;
    if (!s) continue;
    if (typeof s.customer_id === 'number') custIds.add(s.customer_id);
    if (typeof s.supplier_id === 'number') supIds.add(s.supplier_id);
    if (typeof s.party_id === 'number') (s.party_type === 'supplier' ? supIds : custIds).add(s.party_id);
  }
  const c = new Map(custIds.size ? db.select({ id: customers.id, name: customers.name }).from(customers).where(inArray(customers.id, [...custIds])).all().map((r) => [r.id, r.name]) : []);
  const sp = new Map(supIds.size ? db.select({ id: suppliers.id, name: suppliers.name }).from(suppliers).where(inArray(suppliers.id, [...supIds])).all().map((r) => [r.id, r.name]) : []);
  return (s: Snap | null): string | null => {
    if (!s) return null;
    if (typeof s.customer_id === 'number') return c.get(s.customer_id) ?? null;
    if (typeof s.supplier_id === 'number') return sp.get(s.supplier_id) ?? null;
    if (typeof s.party_id === 'number') return (s.party_type === 'supplier' ? sp : c).get(s.party_id) ?? null;
    return null;
  };
}

function reviewsFor(db: DbOrTx, ids: number[]) {
  const out = new Map<number, ChangeRow['review']>();
  if (!ids.length) return out;
  const rows = db
    .select({ audit_id: audit_reviews.audit_id, reviewed_at: audit_reviews.reviewed_at, note: audit_reviews.note, name: users.display_name })
    .from(audit_reviews)
    .leftJoin(users, eq(users.id, audit_reviews.reviewed_by))
    .where(inArray(audit_reviews.audit_id, ids))
    .orderBy(audit_reviews.id)
    .all();
  for (const r of rows) out.set(r.audit_id, { reviewed_by_name: r.name, reviewed_at: r.reviewed_at, note: r.note });
  return out;
}

function toRows(db: DbOrTx, raw: { a: AuditRow; user_name: string | null }[]): ChangeRow[] {
  const parsed = raw.map((r) => ({ ...r, before: parse(r.a.before_json), after: parse(r.a.after_json) }));
  const party = partyNames(db, parsed);
  const reviews = reviewsFor(
    db,
    raw.map((r) => r.a.id),
  );
  return parsed.map(({ a, user_name, before, after }) => {
    const docEntity = HAS_TOTAL.has(a.entity) && (before || after);
    return {
      id: a.id,
      at: a.at,
      user_id: a.user_id,
      user_name,
      user_role: a.user_role,
      action: a.action,
      entity: a.entity,
      entity_id: a.entity_id,
      doc_no: a.doc_no,
      party_name: party(after ?? before),
      version_before: a.version_before,
      version_after: a.version_after,
      total_before_paisa: docEntity ? totalOf(a.entity, before) : null,
      total_after_paisa: docEntity ? totalOf(a.entity, after) : null,
      balance_impact_paisa: docEntity ? balanceEffect(a.entity, after) - balanceEffect(a.entity, before) : null,
      reason: a.reason,
      flags: JSON.parse(a.flags) as string[],
      review: reviews.get(a.id) ?? null,
    };
  });
}

export function listChanges(db: DB, q: Query): { rows: ChangeRow[]; total: number } {
  const where = conditions(q);
  const total = db.select({ n: sql<number>`count(*)` }).from(audit_log).where(where).get()?.n ?? 0;
  const raw = db
    .select({ a: audit_log, user_name: users.display_name })
    .from(audit_log)
    .leftJoin(users, eq(users.id, audit_log.user_id))
    .where(where)
    .orderBy(desc(audit_log.id))
    .limit(q.limit)
    .offset(q.offset)
    .all();
  return { rows: toRows(db, raw), total };
}

/** How the lines of each kind of document are matched up between versions. */
const LINE_KEYS: Record<string, (l: Snap) => string> = {
  sale: (l) => String(l.variant_id),
  purchase: (l) => String(l.variant_id),
  sales_return: (l) => String(l.sale_item_id),
  purchase_return: (l) => String(l.purchase_item_id),
};
const lineLabel = (l: Snap) => [l.item_code, l.color, l.size].filter(Boolean).join(' ') || String(l.id ?? '');

export function getChange(db: DB, id: number): ChangeDetail {
  const r = db.select({ a: audit_log, user_name: users.display_name }).from(audit_log).leftJoin(users, eq(users.id, audit_log.user_id)).where(eq(audit_log.id, id)).get();
  if (!r) throw notFound('Change not found.');
  const [row] = toRows(db, [r]);
  const before = parse(r.a.before_json);
  const after = parse(r.a.after_json);
  return {
    ...(row as ChangeRow),
    before,
    after,
    summary: parse(r.a.summary_json),
    diff: diffSnapshots(before, after, LINE_KEYS[r.a.entity] ?? ((l) => String(l.id)), lineLabel),
    can_pdf: r.a.entity === 'sale' && !!(before ?? after),
  };
}

/** Every change to one document, oldest first: its versions from creation to now. */
export function documentTimeline(db: DB, entity: string, entityId: number): ChangeRow[] {
  const raw = db
    .select({ a: audit_log, user_name: users.display_name })
    .from(audit_log)
    .leftJoin(users, eq(users.id, audit_log.user_id))
    .where(and(eq(audit_log.entity, entity), eq(audit_log.entity_id, entityId)))
    .orderBy(audit_log.id)
    .all();
  return toRows(db, raw);
}

/** Superuser review mark, kept apart from the log. */
export function reviewChange(db: DB, user: SessionUser, id: number, note: string | null): ChangeRow {
  return writeTx(db, (tx) => {
    const a = tx.select({ id: audit_log.id }).from(audit_log).where(eq(audit_log.id, id)).get();
    if (!a) throw notFound('Change not found.');
    tx.insert(audit_reviews).values({ audit_id: id, reviewed_by: user.id, reviewed_at: nowIso(), note: note || null }).run();
    const r = tx.select({ a: audit_log, user_name: users.display_name }).from(audit_log).leftJoin(users, eq(users.id, audit_log.user_id)).where(eq(audit_log.id, id)).get();
    return toRows(tx, r ? [r] : [])[0] as ChangeRow;
  });
}

/** Flagged changes not yet reviewed (the superuser's dashboard card). */
export function unreviewedFlaggedCount(db: DbOrTx): number {
  return db
    .select({ n: sql<number>`count(*)` })
    .from(audit_log)
    .where(and(flaggedSql, sql`NOT ${reviewedSql}`))
    .get()?.n ?? 0;
}

// --- Discount overrides sub-view ---------------------------------------------------------

/**
 * Sale lines (posted invoices) where the discount was changed by hand, the
 * profit was below the minimum, or the item was sold below cost.
 */
export function discountOverrides(db: DB, range: { from?: string; to?: string }): DiscountOverrideRow[] {
  const minBp = getSettings(db).min_profit_bp;
  const belowMin = sql`(${sale_items.profit_paisa} * 10000 < ${minBp} * ${sale_items.line_gross_paisa})`;
  const conds: (SQL | undefined)[] = [
    eq(sales.status, 'posted'),
    sql`(${sale_items.discount_overridden} = 1 OR ${sale_items.profit_paisa} < 0 OR ${belowMin})`,
  ];
  if (range.from) conds.push(gte(sales.date, range.from));
  if (range.to) conds.push(lte(sales.date, range.to));
  return db
    .select({ i: sale_items, s: sales, c: customers, v: product_variants, p: products, user_name: users.display_name })
    .from(sale_items)
    .innerJoin(sales, eq(sales.id, sale_items.sale_id))
    .innerJoin(customers, eq(customers.id, sales.customer_id))
    .innerJoin(product_variants, eq(product_variants.id, sale_items.variant_id))
    .innerJoin(products, eq(products.id, product_variants.product_id))
    .leftJoin(users, eq(users.id, sales.created_by))
    .where(and(...conds))
    .orderBy(desc(sales.date), desc(sales.id), sale_items.line_no)
    .all()
    .map(({ i, s, c, v, p, user_name }) => ({
      sale_id: s.id,
      doc_no: s.doc_no,
      date: s.date,
      user_id: s.created_by,
      user_name,
      customer_name: c.name,
      product_id: p.id,
      item_code: p.item_code,
      name: p.name,
      color: v.color,
      size: v.size,
      qty: i.qty,
      default_discount_bp: i.default_discount_bp,
      discount_bp: i.discount_bp,
      line_net_paisa: i.line_net_paisa,
      profit_paisa: i.profit_paisa,
      reasons: [
        ...(i.discount_overridden ? ['discount_changed'] : []),
        ...(i.profit_paisa < 0 ? ['below_cost'] : i.profit_paisa * 10_000 < minBp * i.line_gross_paisa ? ['below_min_profit'] : []),
      ],
    }));
}

// --- Re-creating an old version of an invoice ------------------------------------------------

/**
 * A Sale (for the invoice PDF) from an audit snapshot, so any version of an
 * invoice can be printed again exactly as it was. Customer contact details
 * are today's.
 */
export function saleFromSnapshot(db: DbOrTx, snap: Snap): Sale {
  const c = db.select().from(customers).where(eq(customers.id, num(snap.customer_id))).get();
  const lines = (Array.isArray(snap.lines) ? (snap.lines as Snap[]) : []).map((l, i) => ({
    id: num(l.id) || i + 1,
    line_no: num(l.line_no) || i + 1,
    returned_qty: 0,
    variant_id: num(l.variant_id),
    product_id: 0,
    item_code: String(l.item_code ?? ''),
    name: String(l.name ?? ''),
    color: String(l.color ?? ''),
    size: String(l.size ?? ''),
    unit: String(l.unit ?? 'pcs'),
    qty: num(l.qty),
    list_price_paisa: num(l.list_price_paisa),
    default_discount_bp: num(l.default_discount_bp),
    discount_bp: num(l.discount_bp),
    discount_overridden: Boolean(l.discount_overridden),
    line_gross_paisa: num(l.line_gross_paisa),
    line_discount_paisa: num(l.line_discount_paisa),
    line_amount_paisa: num(l.line_gross_paisa) - num(l.line_discount_paisa),
    line_net_paisa: num(l.line_net_paisa),
  }));
  return {
    id: num(snap.id),
    doc_no: String(snap.doc_no ?? ''),
    customer_id: num(snap.customer_id),
    customer_code: c?.code ?? String(snap.customer_code ?? ''),
    customer_name: c?.name ?? String(snap.customer_name ?? ''),
    customer_business_name: c?.business_name ?? null,
    customer_type: c?.type ?? 'wholesaler',
    customer_status: c?.status ?? 'active',
    customer_phone: c?.phone ?? null,
    customer_city: c?.city ?? null,
    customer_address: c?.address ?? null,
    date: String(snap.date ?? ''),
    payment_terms_days: num(snap.payment_terms_days),
    due_date: String(snap.due_date ?? ''),
    gross_paisa: num(snap.gross_paisa),
    line_discount_paisa: num(snap.line_discount_paisa),
    extra_discount_paisa: num(snap.extra_discount_paisa),
    tax_paisa: num(snap.tax_paisa),
    total_paisa: num(snap.total_paisa),
    paid_paisa: 0,
    outstanding_paisa: 0,
    days_overdue: null,
    status: snap.status === 'void' ? 'void' : 'posted',
    version: num(snap.version) || 1,
    notes: (snap.notes as string | null) ?? null,
    approved_by_name: null,
    created_at: String(snap.created_at ?? ''),
    created_by_id: null,
    created_by_name: null,
    item_count: lines.length,
    total_qty: lines.reduce((a, l) => a + l.qty, 0),
    lines,
  };
}

/** The snapshot to print for a change: before or after. */
export function snapshotOf(db: DB, id: number, which: 'before' | 'after'): { entity: string; snap: Snap } {
  const a = db.select().from(audit_log).where(eq(audit_log.id, id)).get();
  if (!a) throw notFound('Change not found.');
  const snap = parse(which === 'before' ? a.before_json : a.after_json);
  if (!snap) throw notFound(`This change has no "${which}" version.`);
  return { entity: a.entity, snap };
}
