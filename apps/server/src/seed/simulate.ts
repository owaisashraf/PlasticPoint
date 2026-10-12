import type { LightMyRequestResponse } from 'fastify';
import type { Product, Role, Sale, SaleCheckResult } from '@shopledger/shared';
import type { AppInstance } from '../app';
import type { DbHolder } from '../db/client';
import { effectivePermissions, type SessionUser } from '../lib/permissions';
import { setupOwner, setupSuperuser } from '../modules/auth/service';
import { createSession, deleteAllSessions, SESSION_COOKIE } from '../modules/auth/sessions';
import { createUser, findUserByUsername, toPublicUser } from '../modules/users/service';
import { BANKS, DEMO_CUSTOMERS, DEMO_PRODUCTS, RETURN_REASONS, type DemoCustomer } from './catalog';
import { addDays, addMonths, dayOfWeek, daysBetween, karachiMs, realNow, type SimClock } from './clock';

/**
 * Builds a realistic demo shop by playing out every working day from
 * `months` ago until today through the real API — the same validation,
 * pricing, profit, allocation, stock and audit code the screens use. The
 * clock is simulated, so every document, payment and audit row carries its
 * own day. A fixed random seed makes every run the same (relative to today).
 */

export interface SeedOptions {
  months: number;
  businessName: string;
  password: string;
  log: (line: string) => void;
}

export interface SeedSummary {
  from: string;
  to: string;
  counts: Record<string, number>;
  skipped: string[];
}

type UserKey = 'admin' | 'owner' | 'ali' | 'sana';

const USERS: Record<UserKey, { display_name: string; role: Role }> = {
  admin: { display_name: 'Shop Admin', role: 'superuser' },
  owner: { display_name: 'Imran Sheikh', role: 'owner' },
  ali: { display_name: 'Ali Raza', role: 'operator' },
  sana: { display_name: 'Sana Tariq', role: 'operator' },
};

/** Deterministic random numbers (mulberry32). */
function makeRng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  return {
    next,
    chance: (p: number) => next() < p,
    int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)),
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)] as T,
    weighted: <T>(xs: readonly T[], weight: (x: T) => number): T => {
      const total = xs.reduce((s, x) => s + weight(x), 0);
      let r = next() * total;
      for (const x of xs) {
        r -= weight(x);
        if (r <= 0) return x;
      }
      return xs[xs.length - 1] as T;
    },
  };
}

/** Seasonal demand: Ramadan/Eid and wedding season are busy, monsoon is slow. */
const SEASON: Record<number, number> = { 1: 0.9, 2: 1.15, 3: 1.3, 4: 0.95, 5: 1.2, 6: 1.05, 7: 0.85, 8: 0.9, 9: 1.0, 10: 1.05, 11: 1.15, 12: 1.2 };

interface ProductState {
  id: number;
  code: string;
  category: string;
  unit: string;
  price: number;
  margin: number;
  discount: number;
  maxDiscount: number | null;
  popularity: number;
  variants: number[];
  sellable: boolean;
}

interface CustomerState {
  id: number;
  def: DemoCustomer;
  phone: string;
  status: 'active' | 'bad_debt';
}

interface SaleRecord {
  id: number;
  customer: CustomerState;
  date: string;
  terms: number;
  by: UserKey;
  extra: number;
  lines: { id: number; variant_id: number; qty: number; discount_bp: number; product: ProductState }[];
  hasReturn: boolean;
  voided: boolean;
  /** Cash taken at the counter: such invoices are not edited down (the app would refuse). */
  cash: boolean;
}

export async function seedDemo(app: AppInstance, dbh: DbHolder, clock: SimClock, opts: SeedOptions): Promise<SeedSummary> {
  const rng = makeRng(20_261_013);
  const db = dbh.db;
  const sqlite = dbh.sqlite;
  const log = opts.log;
  const counts: Record<string, number> = {};
  const count = (k: string, n = 1) => (counts[k] = (counts[k] ?? 0) + n);
  const skipped: string[] = [];

  const today = toKarachiDate(realNow());
  const start = addMonths(today, -opts.months);
  let day = addDays(start, -3);
  let minute = 9 * 60;
  const setTime = (date: string, minuteOfDay: number) => {
    day = date;
    minute = minuteOfDay;
    clock.set(karachiMs(date, Math.floor(minuteOfDay / 60), minuteOfDay % 60));
  };
  /** Moves the clock forward a few minutes within the day. */
  const tick = (min = 3, max = 25) => {
    const cap = day === today ? karachiMinuteNow() - 1 : 20 * 60 + 30;
    setTime(day, Math.min(minute + rng.int(min, max), Math.max(cap, minute)));
  };
  setTime(day, 10 * 60);

  // --- Users and sessions ---------------------------------------------------------
  const rounds = 10; // real strength: these accounts are used to log in to the demo
  const account = (u: UserKey) => ({ username: u, display_name: USERS[u].display_name, password: opts.password });
  const session = (u: UserKey): SessionUser => {
    const row = findUserByUsername(db, u);
    if (!row) throw new Error(`missing user ${u}`);
    return { ...toPublicUser(row), permissions: effectivePermissions(row.role, true) };
  };
  await setupSuperuser(db, account('admin'), rounds, {});
  await setupOwner(db, session('admin'), account('owner'), rounds);
  for (const u of ['ali', 'sana'] as const) await createUser(db, session('owner'), { ...account(u), role: 'operator' }, rounds);
  const userIds = Object.fromEntries((Object.keys(USERS) as UserKey[]).map((u) => [u, session(u).id])) as Record<UserKey, number>;

  // A fresh session per user per simulated day (sessions expire after 12 idle hours).
  let cookieDay = '';
  let cookies: Partial<Record<UserKey, string>> = {};
  const cookie = (u: UserKey) => {
    if (cookieDay !== day) {
      cookieDay = day;
      cookies = {};
    }
    cookies[u] ??= `${SESSION_COOKIE}=${app.signCookie(createSession(db, userIds[u]))}`;
    return cookies[u];
  };

  type Method = 'GET' | 'POST' | 'PATCH' | 'PUT';
  const call = async (u: UserKey, method: Method, url: string, body?: unknown): Promise<LightMyRequestResponse> =>
    app.inject({ method, url, headers: { cookie: cookie(u) }, ...(body === undefined ? {} : { payload: body as object }) });
  const ok = async <T = Record<string, unknown>>(u: UserKey, method: Method, url: string, body?: unknown): Promise<T> => {
    const res = await call(u, method, url, body);
    if (res.statusCode !== 200) throw new Error(`${day} ${u} ${method} ${url} → ${res.statusCode}: ${res.body}`);
    return res.json() as T;
  };
  /** For optional extras (edits, returns…): a refusal is noted, not fatal. */
  const tryOk = async <T = Record<string, unknown>>(what: string, u: UserKey, method: Method, url: string, body?: unknown): Promise<T | null> => {
    const res = await call(u, method, url, body);
    if (res.statusCode === 200) return res.json() as T;
    skipped.push(`${day} ${what}: ${res.json<{ error?: string }>().error ?? res.statusCode}`);
    return null;
  };

  // --- Read-only helpers (the seed only reads the database directly) -----------------
  const stockStmt = sqlite.prepare('SELECT coalesce(sum(qty_change), 0) AS q FROM stock_movements WHERE variant_id = ?');
  const stockOf = (variantId: number) => (stockStmt.get(variantId) as { q: number }).q;
  const outstandingStmt = sqlite.prepare(
    "SELECT s.total_paisa - coalesce((SELECT sum(amount_paisa) FROM payment_allocations WHERE sale_id = s.id), 0) AS o FROM sales s WHERE s.id = ? AND s.status = 'posted'",
  );
  const outstanding = (saleId: number) => (outstandingStmt.get(saleId) as { o: number } | undefined)?.o ?? 0;
  // Everything owed up to and including an invoice (receipts pay the oldest debt first, opening balance included).
  const owedUpToStmt = sqlite.prepare(`
    SELECT coalesce((SELECT sum(s.total_paisa - coalesce((SELECT sum(a.amount_paisa) FROM payment_allocations a WHERE a.sale_id = s.id), 0))
                     FROM sales s WHERE s.customer_id = @c AND s.status = 'posted' AND (s.date < @d OR (s.date = @d AND s.id <= @id))), 0)
         + max(0, coalesce((SELECT sum(debit_paisa) FROM ledger_entries WHERE party_type = 'customer' AND party_id = @c AND entry_type = 'opening_balance'), 0)
                  - coalesce((SELECT sum(amount_paisa) FROM payment_allocations WHERE customer_id = @c AND sale_id IS NULL), 0)) AS o`);
  const owedUpTo = (customerId: number, saleId: number, date: string) => (owedUpToStmt.get({ c: customerId, d: date, id: saleId }) as { o: number }).o;
  const balanceStmt = sqlite.prepare("SELECT coalesce(sum(debit_paisa - credit_paisa), 0) AS b FROM ledger_entries WHERE party_type = ? AND party_id = ?");
  const customerBalance = (id: number) => (balanceStmt.get('customer', id) as { b: number }).b;
  const supplierPayable = (id: number) => -(balanceStmt.get('supplier', id) as { b: number }).b;
  const lastId = (table: string) => (sqlite.prepare(`SELECT max(id) AS id FROM ${table}`).get() as { id: number }).id;

  // --- Scheduled actions ---------------------------------------------------------------
  const agenda = new Map<string, (() => Promise<void>)[]>();
  const later = (date: string, fn: () => Promise<void>) => {
    const list = agenda.get(date) ?? [];
    list.push(fn);
    agenda.set(date, list);
  };
  const runDue = async () => {
    for (const key of [...agenda.keys()].sort()) {
      if (key > day) break;
      const list = agenda.get(key) ?? [];
      agenda.delete(key);
      for (const fn of list) {
        tick(2, 12);
        await fn();
      }
    }
  };

  // --- Setup: business, supplier, products, customers ------------------------------------
  log(`Building ${opts.months} months of demo data: ${start} to ${today}`);
  await ok('owner', 'PATCH', '/api/settings', {
    changes: {
      business_name: opts.businessName,
      business_address: 'Shop # 12, Plastic Market, Jodia Bazaar, Karachi',
      business_phone: '021-32400000',
      business_ntn: '1234567-8',
    },
  });
  const supplier = (
    await ok<{ supplier: { id: number } }>('owner', 'POST', '/api/suppliers', {
      name: 'Sunrise Plastic Industries',
      phone: '0300-2223344',
      address: 'Plot 45, SITE Area, Karachi',
      opening_balance_paisa: 1_850_000_00,
      opening_balance_date: addDays(start, -30),
    })
  ).supplier;

  const products: ProductState[] = [];
  const marginChoices = [1100, 1200, 1250, 1300, 1400, 1500];
  for (const p of DEMO_PRODUCTS) {
    const margin = rng.pick(marginChoices);
    const discount = Math.min(1200, Math.max(500, margin - rng.pick([350, 400, 500, 600, 700])));
    const maxDiscount = rng.chance(0.5) ? Math.min(margin - 150, discount + 300) : null;
    const created = (
      await ok<{ product: Product }>('owner', 'POST', '/api/products', {
        item_code: p.item_code,
        name: p.name,
        category: p.category,
        unit: p.unit,
        sizes: p.sizes,
        colors: p.colors,
        list_price_paisa: p.price * 100,
        supplier_margin_bp: margin,
        default_customer_discount_bp: discount,
        max_customer_discount_bp: maxDiscount,
        low_stock_threshold: p.unit === 'dozen' ? 4 : 10,
      })
    ).product;
    products.push({
      id: created.id,
      code: p.item_code,
      category: p.category,
      unit: p.unit,
      price: p.price * 100,
      margin,
      discount,
      maxDiscount,
      popularity: p.popularity,
      variants: (created.variants ?? []).map((v) => v.id),
      sellable: true,
    });
    count('products');
  }
  const refreshProducts = async () => {
    const list = await ok<{ products: Product[] }>('owner', 'GET', '/api/products?limit=500&status=all');
    for (const p of list.products) {
      const s = products.find((x) => x.id === p.id);
      if (!s) continue;
      s.price = p.list_price_paisa;
      s.margin = p.supplier_margin_bp ?? s.margin;
      s.discount = p.default_customer_discount_bp;
      s.maxDiscount = p.max_customer_discount_bp;
      s.sellable = p.active && s.discount < s.margin;
    }
  };

  const customers: CustomerState[] = [];
  let phoneSeq = 0;
  const addCustomer = async (def: DemoCustomer, by: UserKey) => {
    phoneSeq += 1;
    const phone = `03${rng.pick(['00', '01', '02', '11', '12', '21', '22', '33', '45'])}-${String(1_234_567 + phoneSeq * 7919).slice(-7)}`;
    const body: Record<string, unknown> = {
      name: def.name,
      business_name: def.business_name,
      type: def.type,
      phone,
      city: def.city,
      area: def.area,
      payment_terms_days: def.terms,
      credit_limit_paisa: def.credit_limit * 100,
    };
    if (def.opening) {
      body.opening_balance_paisa = def.opening * 100;
      body.opening_balance_date = addDays(start, -rng.int(45, 110));
    }
    const c = (await ok<{ customer: { id: number } }>(by, 'POST', '/api/customers', body)).customer;
    const state: CustomerState = { id: c.id, def, phone, status: 'active' };
    customers.push(state);
    count('customers');
    // Opening debt is paid off over the first months.
    if (def.opening && def.habit !== 'chronic' && def.habit !== 'bad') {
      for (let i = 1; i <= 3; i++) later(addDays(start, 20 * i + rng.int(0, 10)), () => receipt(state, Math.round((def.opening * 100) / 3 / 100_000) * 100_000));
    }
    return state;
  };

  const cats = await ok<{ categories: { id: number; name: string }[] }>('owner', 'GET', '/api/expense-categories');
  const catId = (name: string) => {
    const c = cats.categories.find((x) => x.name === name);
    if (!c) throw new Error(`no expense category ${name}`);
    return c.id;
  };

  // --- Actions ---------------------------------------------------------------------------
  const methodFor = (c: CustomerState): 'cash' | 'bank' | 'cheque' | 'online' =>
    c.def.type === 'retailer' ? rng.weighted(['cash', 'online', 'bank'] as const, (m) => (m === 'cash' ? 6 : 2)) : rng.weighted(['bank', 'cheque', 'cash', 'online'] as const, (m) => (m === 'bank' ? 4 : m === 'cheque' ? 3 : 2));

  let bouncePlan = 0;
  async function receipt(c: CustomerState, amount: number, by: UserKey = rng.pick(['ali', 'sana', 'ali', 'owner'] as const)) {
    if (amount < 100) return;
    const method = methodFor(c);
    const body: Record<string, unknown> = { customer_id: c.id, date: day, amount_paisa: amount, method };
    if (method === 'cheque') {
      body.cheque_no = String(rng.int(1_000_000, 9_999_999));
      body.cheque_bank = rng.pick(BANKS);
      body.cheque_date = day;
    } else if (method !== 'cash') body.reference = `TRX-${rng.int(100_000, 999_999)}`;
    await ok(by, 'POST', '/api/payments/receipts', body);
    count('receipts');
    // A cheque bounces now and then (late payers, later in the period); the owner marks it and they pay again in cash.
    if (method === 'cheque' && c.def.habit === 'late' && bouncePlan > 0) {
      bouncePlan -= 1;
      const paymentId = lastId('payments');
      later(addDays(day, 4), async () => {
        if (await tryOk('bounce cheque', 'owner', 'POST', `/api/payments/${paymentId}/bounce`, { reason: 'Cheque returned by the bank: insufficient funds', date: day })) {
          count('bounced cheques');
          later(addDays(day, rng.int(12, 25)), () => receipt(c, amount, 'owner'));
        }
      });
    }
  }

  /** Plans how this invoice gets paid, from the customer's habit. */
  function planPayment(c: CustomerState, sale: SaleRecord) {
    const h = c.def.habit;
    if (h === 'prompt') later(addDays(sale.date, Math.max(1, Math.round(sale.terms * (0.4 + rng.next() * 0.6)))), () => payInvoice(c, sale, rng.chance(0.15)));
    else if (h === 'late') later(addDays(sale.date, sale.terms + rng.int(5, 45)), () => payInvoice(c, sale, false));
    else if (h === 'stopped') later(addDays(sale.date, sale.terms + rng.int(0, 20)), () => payInvoice(c, sale, false));
    else if (h === 'bad' && monthIndex() < 8) later(addDays(sale.date, sale.terms + rng.int(10, 40)), () => payInvoice(c, sale, false));
  }
  async function payInvoice(c: CustomerState, sale: SaleRecord, roundUp: boolean) {
    if (outstanding(sale.id) <= 0) return;
    // Pays this invoice and anything older still open, but never more than the balance.
    const due = Math.min(owedUpTo(c.id, sale.id, sale.date), customerBalance(c.id));
    if (due <= 0) return;
    // Some pay a round figure, leaving a small advance.
    await receipt(c, roundUp ? Math.ceil(due / 100_000) * 100_000 : due);
  }

  /** Partial and chronic payers pay a share of their balance now and then. */
  const nextLumpPay = new Map<number, string>();
  async function lumpPayments() {
    for (const c of customers) {
      const h = c.def.habit;
      if (h !== 'partial' && h !== 'chronic') continue;
      const next = nextLumpPay.get(c.id) ?? addDays(day, rng.int(5, 20));
      if (!nextLumpPay.has(c.id)) nextLumpPay.set(c.id, next);
      if (next > day) continue;
      const bal = customerBalance(c.id);
      const share = h === 'partial' ? 0.35 + rng.next() * 0.3 : 0.12 + rng.next() * 0.15;
      const amount = Math.floor((bal * share) / 500_000) * 500_000;
      if (amount > 0) await receipt(c, amount);
      nextLumpPay.set(c.id, addDays(day, h === 'partial' ? rng.int(12, 22) : rng.int(30, 50)));
    }
  }

  const sales: SaleRecord[] = [];

  function monthIndex(): number {
    return (Number(day.slice(0, 4)) - Number(start.slice(0, 4))) * 12 + (Number(day.slice(5, 7)) - Number(start.slice(5, 7)));
  }

  /** One invoice: picks items in stock, sometimes a changed discount, cash at the counter for many retailers. */
  async function makeSale(c: CustomerState, by: UserKey, special?: 'above_max' | 'below_cost') {
    const wholesale = c.def.type === 'wholesaler';
    const lineCount = wholesale ? rng.int(2, 6) : rng.int(1, 4);
    const lines: SaleRecord['lines'] = [];
    const used = new Set<number>();
    for (let i = 0; i < lineCount * 2 && lines.length < lineCount; i++) {
      const p = rng.weighted(
        products.filter((x) => x.sellable),
        (x) => x.popularity,
      );
      const variant = rng.pick(p.variants);
      if (used.has(variant)) continue;
      const dozen = p.unit === 'dozen';
      const want = wholesale ? Math.max(1, Math.round((dozen ? rng.int(1, 5) : rng.pick([6, 6, 12, 12, 18, 24])) * c.def.size)) : dozen ? rng.int(1, 3) : rng.int(2, 12);
      const qty = Math.min(want, stockOf(variant));
      if (qty <= 0) continue;
      used.add(variant);
      let discount = p.discount;
      if (rng.chance(0.08)) {
        const changed = discount + rng.pick([-150, -100, -50, 50, 100, 150]);
        if (changed >= 0 && changed < p.margin - 100 && (p.maxDiscount === null || changed <= p.maxDiscount)) discount = changed;
      }
      lines.push({ id: 0, variant_id: variant, qty, discount_bp: discount, product: p });
    }
    if (lines.length === 0) return null;
    let approval: Record<string, unknown> | undefined;
    const first = lines[0];
    if (special === 'above_max' && first?.product.maxDiscount !== null && first) {
      first.discount_bp = Math.min((first.product.maxDiscount ?? first.discount_bp) + 100, first.product.margin - 50);
      approval = by === 'owner' ? { confirmed: true } : { username: 'owner', password: opts.password };
    }
    if (special === 'below_cost' && first) {
      first.discount_bp = first.product.margin + 300; // clearance below cost, approved by the owner
      approval = by === 'owner' ? { confirmed: true } : { username: 'owner', password: opts.password };
    }
    let extra = wholesale && rng.chance(0.05) ? rng.pick([500, 1000, 1500, 2000, 3000]) * 100 : 0;
    const body: Record<string, unknown> = {
      customer_id: c.id,
      date: day,
      lines: lines.map((l) => ({ variant_id: l.variant_id, qty: l.qty, discount_bp: l.discount_bp })),
      extra_discount_paisa: extra,
      ...(approval ? { approval } : {}),
    };
    const check = async () => {
      const { approval: _a, ...draft } = body;
      return ok<SaleCheckResult>(by, 'POST', '/api/sales/check', draft);
    };
    // An extra discount that would take a line below cost is left out (it would need the owner).
    if (extra && !approval && (await check()).needs_approval) {
      extra = 0;
      body.extra_discount_paisa = 0;
    }
    // Cash at the counter: most retailers pay in full, some wholesalers pay part.
    const paysCash = c.status === 'active' && (wholesale ? rng.chance(0.08) : rng.chance(0.55));
    if (paysCash) {
      const total = (await check()).totals.total_paisa;
      body.cash_received_paisa = wholesale ? Math.floor((total * (0.3 + rng.next() * 0.4)) / 100_000) * 100_000 : total;
    }
    const res = await call(by, 'POST', '/api/sales', body);
    if (res.statusCode !== 200) {
      const err = res.json<{ error?: string; details?: { issues?: { kind: string }[] } }>();
      skipped.push(`${day} sale by ${by}: ${err.error} ${(err.details?.issues ?? []).map((i) => i.kind).join(', ')}`);
      return null;
    }
    const sale = res.json<{ sale: Sale }>().sale;
    const rec: SaleRecord = {
      id: sale.id,
      customer: c,
      date: day,
      terms: sale.payment_terms_days,
      by,
      extra,
      lines: (sale.lines ?? []).map((l) => ({ id: l.id, variant_id: l.variant_id, qty: l.qty, discount_bp: l.discount_bp, product: products.find((p) => p.variants.includes(l.variant_id)) as ProductState })),
      hasReturn: false,
      voided: false,
      cash: Boolean(body.cash_received_paisa),
    };
    sales.push(rec);
    count('sales');
    if (approval) count('approved sales');
    planPayment(c, rec);
    await afterSale(rec);
    return rec;
  }

  const saleEditBody = (s: SaleRecord, reason: string) => ({
    customer_id: s.customer.id,
    date: s.date,
    payment_terms_days: s.terms,
    lines: s.lines.map((l) => ({ variant_id: l.variant_id, qty: l.qty, discount_bp: l.discount_bp })),
    extra_discount_paisa: s.extra,
    change_reason: reason,
  });

  /** Printing, WhatsApp, edits, voids and returns that follow some invoices. */
  async function afterSale(s: SaleRecord) {
    if (rng.chance(0.03)) {
      tick(1, 3);
      if (await tryOk('print', s.by, 'POST', `/api/sales/${s.id}/print`)) count('prints');
    }
    if (rng.chance(0.02)) {
      tick(1, 3);
      if (await tryOk('whatsapp invoice', s.by, 'POST', `/api/whatsapp/invoice/${s.id}`)) count('whatsapp shares');
    }
    // Operators fix their own invoice the same day.
    if (s.by !== 'owner' && !s.cash && rng.chance(0.012)) {
      const l = s.lines[0];
      if (l && l.qty > 2) {
        tick(5, 30);
        l.qty -= rng.int(1, Math.min(4, l.qty - 1));
        if (await tryOk('operator edit', s.by, 'PUT', `/api/sales/${s.id}`, saleEditBody(s, 'Customer changed the quantity'))) count('edits by operators');
      }
    }
    // The owner edits or voids some invoices a few days later.
    if (rng.chance(0.006)) {
      later(addDays(s.date, rng.int(1, 6)), async () => {
        if (s.hasReturn || s.voided || s.cash) return;
        const l = rng.pick(s.lines);
        if (rng.chance(0.5) && l.qty > 1) l.qty -= 1;
        else if (l.discount_bp + 100 < l.product.margin - 100 && (l.product.maxDiscount === null || l.discount_bp + 100 <= l.product.maxDiscount)) l.discount_bp += 100;
        else return;
        if (await tryOk('owner edit', 'owner', 'PUT', `/api/sales/${s.id}`, saleEditBody(s, rng.pick(['Agreed a better rate with the customer', 'One piece was short in delivery', 'Corrected after customer call'])))) count('edits by owner');
      });
    } else if (rng.chance(0.003)) {
      later(addDays(s.date, rng.int(0, 3)), async () => {
        if (s.hasReturn || s.voided) return;
        if (await tryOk('void', 'owner', 'POST', `/api/sales/${s.id}/void`, { reason: 'Entered twice by mistake' })) {
          s.voided = true;
          count('voided invoices');
        }
      });
    }
    // Some goods come back.
    if (rng.chance(0.025)) {
      later(addDays(s.date, rng.int(2, 15)), async () => {
        if (s.voided) return;
        const l = rng.pick(s.lines);
        const qty = Math.max(1, Math.ceil(l.qty * (0.1 + rng.next() * 0.4)));
        const body: Record<string, unknown> = { date: day, reason: rng.pick(RETURN_REASONS), lines: [{ sale_item_id: l.id, qty }] };
        if (s.customer.def.type === 'retailer' && rng.chance(0.4)) {
          const estimate = Math.floor((qty * l.product.price * (10_000 - l.discount_bp - 200)) / 10_000 / 2 / 100) * 100;
          if (estimate >= 100) body.refund = { amount_paisa: estimate, method: 'cash' };
        }
        if (await tryOk('sales return', rng.pick(['ali', 'sana'] as const), 'POST', `/api/sales/${s.id}/returns`, body)) {
          s.hasReturn = true;
          count('sales returns');
        }
      });
    }
  }

  const purchaseLines: { id: number; qty: number }[][] = [];
  /** Buys what is running low; the first bill fills the shop. */
  async function restock(first = false, by: UserKey = 'owner') {
    const lines: Record<string, unknown>[] = [];
    for (const p of products) {
      const target = (p.unit === 'dozen' ? 8 : 25) + p.popularity * (p.unit === 'dozen' ? 6 : 16);
      for (const v of p.variants) {
        const have = stockOf(v);
        if (!first && have > target * 0.45) continue;
        const qty = Math.ceil(((first ? target * 1.6 : target * 1.4) - have) / 6) * 6;
        if (qty > 0) lines.push({ variant_id: v, qty, list_price_paisa: p.price, supplier_margin_bp: p.margin });
      }
    }
    if (lines.length === 0) return;
    const purchase = (
      await ok<{ purchase: { id: number; lines?: { id: number; qty: number }[] } }>(by, 'POST', '/api/purchases', {
        supplier_id: supplier.id,
        date: day,
        supplier_ref: `SPI-${rng.int(10_000, 99_999)}`,
        lines,
      })
    ).purchase;
    purchaseLines.push((purchase.lines ?? []).map((l) => ({ id: l.id, qty: l.qty })));
    count('purchases');
    return purchase.id;
  }

  async function expense(category: string, amountRupees: number, method: 'cash' | 'bank', paid_to: string, notes?: string) {
    const r = await ok<{ expense: { id: number } }>('owner', 'POST', '/api/expenses', {
      date: day,
      category_id: catId(category),
      amount_paisa: Math.round(amountRupees) * 100,
      method,
      paid_to,
      ...(notes ? { notes } : {}),
    });
    count('expenses');
    return r.expense.id;
  }

  // --- Opening day -----------------------------------------------------------------------
  for (const def of DEMO_CUSTOMERS.filter((d) => d.joins === 0)) {
    tick(1, 4);
    await addCustomer(def, rng.pick(['ali', 'sana'] as const));
  }
  setTime(addDays(start, -1), 11 * 60);
  await restock(true);
  const assets: Record<string, number> = {};
  const addAsset = async (key: string, body: Record<string, unknown>) => {
    assets[key] = (await ok<{ asset: { id: number } }>('owner', 'POST', '/api/assets', { purchase_date: day, ...body })).asset.id;
    count('assets');
  };
  for (const [key, body] of [
    ['racks', { name: 'Shop racks and counter', category: 'furniture', cost_paisa: 420_000_00, method: 'bank', vendor: 'Karachi Steel Furniture', depreciation_method: 'straight_line', useful_life_months: 60, salvage_value_paisa: 20_000_00 }],
    ['laptop', { name: 'Billing laptop and printer', category: 'computer', cost_paisa: 165_000_00, method: 'bank', vendor: 'Saddar Computer Market', depreciation_method: 'straight_line', useful_life_months: 36, salvage_value_paisa: 15_000_00 }],
    ['cabinet', { name: 'Old glass display cabinet', category: 'furniture', cost_paisa: 60_000_00, method: 'cash', vendor: 'Local carpenter', depreciation_method: 'straight_line', useful_life_months: 48, salvage_value_paisa: 0 }],
  ] as const) {
    await addAsset(key, body);
  }

  // --- Every day until today -----------------------------------------------------------------
  let salaryRaise = 1;
  let lastLoginWeek = -1;
  let lastMonth = -1;
  for (let d = start; d <= today; d = addDays(d, 1)) {
    const dow = dayOfWeek(d);
    if (dow === 0) continue; // markets are closed on Sunday
    // Today counts only once the shop has opened (a build at night stops at yesterday).
    if (d === today && karachiMinuteNow() < 10 * 60) break;
    setTime(d, 9 * 60 + rng.int(0, 40));
    const m = monthIndex();
    const dom = Number(d.slice(8, 10));
    if (m !== lastMonth) {
      lastMonth = m;
      log(`  ${d.slice(0, 7)} …`);
      for (const def of DEMO_CUSTOMERS.filter((x) => x.joins === m && m > 0)) await addCustomer(def, rng.pick(['ali', 'sana'] as const));
      if (m === 12) salaryRaise = 1.1;
    }

    // Logins (for the change history), about weekly.
    const week = Math.floor(daysBetween(start, d) / 7);
    if (week !== lastLoginWeek) {
      lastLoginWeek = week;
      for (const u of ['owner', 'ali', 'sana'] as const) {
        if (u !== 'owner' && week % 2) continue;
        if (week % 9 === 3 && u === 'sana') await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: u, password: 'wrong-password' } });
        await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: u, password: opts.password } });
        tick(1, 3);
      }
    }

    // Monthly and weekly running costs.
    if (dom <= 2 && !counts[`rent-${d.slice(0, 7)}`]) {
      count(`rent-${d.slice(0, 7)}`);
      await expense('Rent', 85_000, 'bank', 'Landlord — Haji Yaqoob', `Shop rent ${d.slice(0, 7)}`);
      await expense('Salaries & wages', 45_000 * salaryRaise, 'cash', 'Ali Raza');
      await expense('Salaries & wages', 38_000 * salaryRaise, 'cash', 'Sana Tariq');
      await expense('Salaries & wages', 30_000 * salaryRaise, 'cash', 'Akbar (loader)');
      await expense('Phone & internet', 4_500, 'bank', 'PTCL / Jazz');
      await expense('Bank charges', rng.int(800, 2_500), 'bank', 'HBL');
    }
    if (dom >= 9 && dom <= 11 && !counts[`power-${d.slice(0, 7)}`]) {
      count(`power-${d.slice(0, 7)}`);
      const month = Number(d.slice(5, 7));
      const summer = month >= 5 && month <= 9;
      await expense('Electricity & gas', summer ? rng.int(38_000, 52_000) : rng.int(16_000, 24_000), 'bank', 'K-Electric');
    }
    if (dow === 3) await expense('Transport & freight', rng.int(3_000, 9_000), 'cash', rng.pick(['Suzuki loader', 'Goods transport', 'Rickshaw']));
    if (dom === 15 || dom === 28) await expense('Packing material', rng.int(2_000, 6_000), 'cash', 'Jodia packing store');
    if (rng.chance(0.015)) await expense('Repairs & maintenance', rng.int(5_000, 25_000), 'cash', rng.pick(['Electrician', 'Plumber', 'Shutter repair', 'AC service']));
    if (dom === 20 && rng.chance(0.7)) await expense('Miscellaneous', rng.int(3_000, 8_000), 'cash', 'Tea and refreshments');

    // Restocking on Mondays and Thursdays.
    if (dow === 1 || dow === 4) {
      tick();
      await restock(false, rng.chance(0.7) ? 'owner' : 'ali');
    }

    // Scripted events that make every report worth showing.
    await scripted(m, dom, d);

    // The day's sales.
    const progress = daysBetween(start, d) / Math.max(1, daysBetween(start, today));
    const busy = (SEASON[Number(d.slice(5, 7))] ?? 1) * (1 + 0.25 * progress) * (dow === 6 ? 1.2 : 1);
    const n = Math.max(2, Math.round(7 * busy + rng.int(-2, 3)));
    for (let i = 0; i < n; i++) {
      tick(8, 35);
      const pool = customers.filter((c) => c.status === 'active' && buys(c, m));
      if (pool.length === 0) break;
      const c = rng.weighted(pool, (x) => x.def.size * (x.def.habit === 'chronic' ? 0.5 : 1));
      const by = rng.weighted(['ali', 'sana', 'owner'] as const, (u) => (u === 'ali' ? 5 : u === 'sana' ? 4 : 1));
      const special = rng.chance(0.004) ? 'above_max' : undefined;
      await makeSale(c, by, special);
    }

    await runDue();
    await lumpPayments();

    // Paying the manufacturer on Saturdays.
    if (dow === 6) {
      const payable = supplierPayable(supplier.id);
      const amount = Math.floor((payable * (0.25 + rng.next() * 0.2)) / 10_000_00) * 10_000_00;
      if (amount > 0) {
        tick();
        const method = rng.chance(0.6) ? 'bank' : 'cheque';
        await ok('owner', 'POST', '/api/payments/supplier', {
          supplier_id: supplier.id,
          date: d,
          amount_paisa: amount,
          method,
          ...(method === 'cheque' ? { cheque_no: String(rng.int(1_000_000, 9_999_999)), cheque_bank: 'HBL', cheque_date: d } : { reference: `IBFT-${rng.int(100_000, 999_999)}` }),
        });
        count('supplier payments');
      }
    }

    // Friday: payment reminders on WhatsApp to the longest-overdue customers.
    if (dow === 5 && rng.chance(0.6)) {
      const list = await ok<{ rows: { customer_id: number }[] }>('ali', 'GET', '/api/overdue');
      for (const r of list.rows.slice(0, 2)) {
        tick(2, 6);
        if (await tryOk('reminder', 'ali', 'POST', `/api/whatsapp/reminder/${r.customer_id}`)) count('whatsapp reminders');
      }
    }

    // First of the month: the superuser reviews older flagged changes.
    if (dom <= 2 && m > 1 && !counts[`review-${d.slice(0, 7)}`]) {
      count(`review-${d.slice(0, 7)}`);
      const ids = sqlite
        .prepare("SELECT id FROM audit_log WHERE EXISTS (SELECT 1 FROM json_each(flags) WHERE value <> 'by_operator') AND id NOT IN (SELECT audit_id FROM audit_reviews) AND at < ? ORDER BY id")
        .all(new Date(karachiMs(addDays(d, -30), 0)).toISOString()) as { id: number }[];
      for (const { id } of ids) {
        if (!rng.chance(0.8)) continue;
        await ok('admin', 'POST', `/api/changelog/${id}/review`, { note: rng.chance(0.3) ? 'Checked with the owner' : null });
        count('reviews');
      }
    }
  }

  /** Who still buys: stopped customers stop after month 9, bad-debt ones after month 10. */
  function buys(c: CustomerState, m: number): boolean {
    if (c.def.habit === 'stopped') return m < 9;
    if (c.def.habit === 'bad') return m < 10;
    return true;
  }

  async function scripted(m: number, dom: number, d: string) {
    const once = async (key: string, cond: boolean, fn: () => Promise<void>) => {
      if (!cond || counts[`once-${key}`]) return;
      count(`once-${key}`);
      tick();
      await fn();
    };
    await once('bounce-1', m >= 6, async () => {
      bouncePlan += 1;
    });
    await once('bounce-2', m >= 13, async () => {
      bouncePlan += 1;
    });
    await once('purchase-return-1', m === 3 && dom >= 10, async () => {
      const lines = purchaseLines.at(-1);
      const l = lines?.[0];
      if (l && (await tryOk('purchase return', 'owner', 'POST', `/api/purchases/${lastId('purchases')}/returns`, { date: d, reason: 'Cracked pieces in the bill', lines: [{ purchase_item_id: l.id, qty: Math.min(6, l.qty) }] }))) count('purchase returns');
    });
    await once('purchase-return-2', m === 11 && dom >= 5, async () => {
      const l = purchaseLines.at(-1)?.[1];
      if (l && (await tryOk('purchase return', 'ali', 'POST', `/api/purchases/${lastId('purchases')}/returns`, { date: d, reason: 'Wrong colour supplied', lines: [{ purchase_item_id: l.id, qty: Math.min(12, l.qty) }] }))) count('purchase returns');
    });
    await once('vehicle', m === 5 && dom >= 3, async () => {
      await addAsset('vehicle', { name: 'Loader rickshaw', category: 'vehicle', cost_paisa: 780_000_00, method: 'bank', vendor: 'Sazgar dealer', depreciation_method: 'straight_line', useful_life_months: 60, salvage_value_paisa: 150_000_00 });
    });
    await once('dispose-cabinet', m === 12 && dom >= 6, async () => {
      if (await tryOk('dispose asset', 'owner', 'POST', `/api/assets/${assets.cabinet}/dispose`, { date: d, amount_paisa: 25_000_00, method: 'cash', reason: 'Replaced by the new racks; sold to a scrap dealer' })) count('asset disposals');
    });
    await once('price-buckets', m === 6 && dom >= 15, async () => {
      await ok('owner', 'POST', '/api/products/bulk-update', { target: { kind: 'category', category: 'Buckets' }, change: { kind: 'price_percent', bp: 800 }, reason: 'Manufacturer price increase on buckets' });
      await refreshProducts();
      count('price changes');
    });
    await once('price-chairs', m === 15 && dom >= 10, async () => {
      await ok('owner', 'POST', '/api/products/bulk-update', { target: { kind: 'category', category: 'Chairs' }, change: { kind: 'price_percent', bp: 500 }, reason: 'New rate list from the manufacturer' });
      await refreshProducts();
      count('price changes');
    });
    await once('margin-jug', m === 11 && dom >= 12, async () => {
      const p = products.find((x) => x.code === 'JG-101');
      if (p) await ok('owner', 'PATCH', `/api/products/${p.id}`, { supplier_margin_bp: p.margin - 100, reason: 'Manufacturer reduced the margin on jugs' });
      await refreshProducts();
      count('price changes');
    });
    await once('loss-maker', m === 16, async () => {
      // A mistake the Profit check report catches: the discount is above the margin.
      const p = products.find((x) => x.code === 'BS-104');
      if (p) await ok('owner', 'PATCH', `/api/products/${p.id}`, { default_customer_discount_bp: p.margin + 100, reason: 'Matching a competitor offer' });
      await refreshProducts();
    });
    await once('below-cost', m === 8 && dom >= 20, async () => {
      const c = customers.find((x) => x.def.habit === 'prompt' && x.def.type === 'wholesaler');
      if (c && (await makeSale(c, 'owner', 'below_cost'))) count('below-cost clearance sales');
    });
    await once('below-cost-2', m === 14 && dom >= 5, async () => {
      const c = customers.find((x) => x.def.habit === 'late' && x.def.type === 'wholesaler');
      if (c && (await makeSale(c, 'ali', 'below_cost'))) count('below-cost clearance sales');
    });
    await once('bad-debt', m === 13 && dom >= 8, async () => {
      for (const c of customers.filter((x) => x.def.habit === 'bad')) {
        await ok('owner', 'POST', `/api/customers/${c.id}/bad-debt`, { reason: 'No payment for five months; shop closed, phone off' });
        c.status = 'bad_debt';
        count('bad-debt customers');
      }
    });
    await once('write-off', m === 14 && dom >= 12, async () => {
      for (const c of customers.filter((x) => x.def.habit === 'bad')) {
        const amount = Math.floor((customerBalance(c.id) * 0.6) / 100_000) * 100_000;
        if (amount > 0) {
          await ok('owner', 'POST', `/api/customers/${c.id}/write-offs`, { date: d, amount_paisa: amount, reason: 'Unrecoverable after legal notice' });
          count('write-offs');
        }
      }
    });
    await once('recovery', m === 16 && dom >= 18, async () => {
      const c = customers.find((x) => x.def.habit === 'bad');
      const wo = c && (sqlite.prepare("SELECT id, amount_paisa FROM write_offs WHERE customer_id = ? AND status = 'posted'").get(c.id) as { id: number; amount_paisa: number } | undefined);
      if (c && wo) {
        const amount = Math.floor(wo.amount_paisa / 4 / 100_000) * 100_000;
        await ok('owner', 'POST', `/api/write-offs/${wo.id}/reverse`, { date: d, amount_paisa: amount, reason: 'Customer paid part after settlement' });
        await receipt(c, amount, 'owner');
        count('write-off recoveries');
      }
    });
    await once('expense-fix', m === 4 && dom >= 3, async () => {
      const id = await expense('Rent', 85_000, 'bank', 'Landlord — Haji Yaqoob', 'Entered again by mistake');
      tick();
      await ok('owner', 'POST', `/api/expenses/${id}/void`, { reason: 'Rent was already entered this month' });
      count('voided expenses');
    });
    await once('expense-edit', m === 7 && dom >= 12, async () => {
      const id = await expense('Electricity & gas', 41_000, 'bank', 'K-Electric');
      tick();
      await ok('owner', 'PUT', `/api/expenses/${id}`, { date: d, category_id: catId('Electricity & gas'), amount_paisa: 44_350_00, method: 'bank', paid_to: 'K-Electric', change_reason: 'Corrected to the amount on the bill' });
      count('edited expenses');
    });
    await once('new-product', m === 17 && dom >= 3, async () => {
      // Sold before the first bill arrives: the line uses an estimated cost, and the owner confirms the short stock.
      const created = (
        await ok<{ product: Product }>('owner', 'POST', '/api/products', {
          item_code: 'CH-106',
          name: 'Rocking chair',
          category: 'Chairs',
          unit: 'pcs',
          sizes: ['Standard'],
          colors: ['White', 'Brown'],
          list_price_paisa: 4_650_00,
          supplier_margin_bp: 1300,
          default_customer_discount_bp: 800,
          low_stock_threshold: 6,
        })
      ).product;
      const variants = (created.variants ?? []).map((v) => v.id);
      const c = customers.find((x) => x.def.habit === 'prompt' && x.def.type === 'wholesaler');
      if (!c || !variants[0]) return;
      const r = await tryOk<{ sale: Sale }>('pre-sale', 'owner', 'POST', '/api/sales', {
        customer_id: c.id,
        date: d,
        lines: [{ variant_id: variants[0], qty: 6, discount_bp: 800 }],
        notes: 'Booked before stock arrived',
        approval: { confirmed: true },
      });
      if (r) count('sales');
      const p: ProductState = { id: created.id, code: 'CH-106', category: 'Chairs', unit: 'pcs', price: 4_650_00, margin: 1300, discount: 800, maxDiscount: null, popularity: 3, variants, sellable: true };
      later(addDays(d, 3), async () => {
        products.push(p);
        await restock(false, 'owner');
      });
    });
    await once('statements', m === 10 && dom >= 5, async () => {
      for (const c of customers.slice(0, 3)) if (await tryOk('statement', 'owner', 'POST', `/api/whatsapp/statement/${c.id}`, {})) count('whatsapp statements');
    });
  }

  // --- Finish --------------------------------------------------------------------------------
  deleteAllSessions(db);
  const pending = [...agenda.keys()].length;
  log(`Done. ${pending} planned payments and follow-ups fall after today and stay open (overdue and not yet due).`);
  return { from: start, to: today, counts: Object.fromEntries(Object.entries(counts).filter(([k]) => !/^(rent|power|review|once)-/.test(k))), skipped };
}

function toKarachiDate(ms: number): string {
  return new Date(ms + 5 * 3_600_000).toISOString().slice(0, 10);
}

/** Minutes since midnight in Karachi, now (real time). */
function karachiMinuteNow(): number {
  const d = new Date(realNow() + 5 * 3_600_000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}
