# CLAUDE.md — ShopLedger

This file is the source of truth for how this project is built. Read it fully at the start of every session. If a request conflicts with a rule here, point out the conflict before writing code.

## 1. What we are building

ShopLedger is a sales, purchase and accounts app for a trading business in Pakistan.

- It buys stock from **one manufacturer** (the supplier).
- It sells to **wholesalers and retailers** (customers), mostly on credit with payment terms.
- It tracks:
  - customer and supplier balances, payments, returns, overdue accounts and bad debts
  - one price per product, the manufacturer's margin to the shop (which sets cost), the discount the shop gives each customer, and the profit on every sale
  - business expenses and assets, so the owner can see **actual net profit**
- It generates invoices (PDF, print) and sends them on WhatsApp.

It runs **locally on one Windows laptop**. The UI opens in the browser at `http://localhost:3000`. Access from other devices on the shop's Wi-Fi can be switched on in settings.

**Users** (roles are defined in section 9):
- **Superuser**: exactly one. Has every owner privilege, plus oversight features such as the change history, and any future special features.
- **Owner**: the shop owner. The only role besides the superuser that sees profit, expenses and assets.
- **Operators**: a few staff who do day-to-day data entry.

Users are not technical. **Fast keyboard-driven data entry, correct balances, and trustworthy records matter more than anything else.**

## 2. Hard constraints (do not break these)

1. **Low-power target machine.** Assume a Windows 10/11 laptop with 4 GB RAM, a dual-core CPU, and possibly a hard disk rather than an SSD.
   - At runtime the app is one Node.js process plus one SQLite file.
   - Target: under 200 MB RAM when idle, startup under 5 seconds.
2. **Offline first.** Every feature works without internet. Internet is only used by optional features: the WhatsApp Cloud API, and copying backups to a cloud-synced folder.
3. **Open source only.**
   - Dependencies must be MIT, Apache-2.0, BSD or ISC licensed.
   - No paid services may be required.
   - Do not use: Docker, Postgres/MySQL, Redis, Electron, or Puppeteer/Playwright/Chromium **at runtime**.
4. **Minimal native modules.** `better-sqlite3` is the only native module allowed, because it ships prebuilt Windows binaries. Otherwise prefer pure-JS packages or Node built-ins (`node:crypto` for hashing; `bcryptjs`, not `bcrypt`/`argon2`).
5. **Portable.** Moving to another laptop must take only these steps:
   1. Install Node.js LTS.
   2. Copy the app folder.
   3. Copy the `data` folder, or restore a backup.

   So: no absolute paths in code. Every file path is derived from `DATA_DIR` (default `./data`).
6. **Ask before adding any dependency** that is not in section 3. When asking, state its license, install size, and why it is needed.
7. **Permissions are enforced on the server**, never only by hiding UI. Financial data is never sent to roles that are not allowed to see it.

## 3. Tech stack

All runtime dependencies are open source and lightweight. Pin exact versions in `package.json`.

| Area | Choice | Notes |
|---|---|---|
| Runtime | Node.js 24 LTS | Only runtime requirement on the laptop |
| Language | TypeScript (strict) | Both server and web |
| Monorepo | npm workspaces | No pnpm, yarn or turbo needed |
| Server | Fastify, `@fastify/static`, `@fastify/cookie` | Serves the API and the built UI from one process |
| Validation | Zod + `fastify-type-provider-zod` | Schemas shared with the frontend via `packages/shared` |
| Database | SQLite via `better-sqlite3`, WAL mode, `foreign_keys=ON` | A single file: `DATA_DIR/shopledger.db` |
| ORM / migrations | `drizzle-orm` + `drizzle-kit` | Schema in TypeScript, SQL migrations committed to git |
| Auth | `bcryptjs` + sessions table + signed httpOnly cookie | No JWT, no external auth service |
| Audit hash chain | `node:crypto` (SHA-256) | Built into Node; no dependency |
| PDF | `pdfmake` (server-side) | Pure JS; A4 and 80 mm thermal templates |
| Scheduling | `croner` | Runs the daily backup |
| Phone numbers | `libphonenumber-js` (min metadata) | Stores numbers in E.164 format (+92...) |
| Logging | pino (built into Fastify) + `pino-roll` | Writes to `DATA_DIR/logs`, keeps 14 days |
| Frontend | React + Vite + React Router | Built to static files and served by Fastify |
| UI | Tailwind CSS + shadcn/ui + `lucide-react` + `cmdk` | `cmdk` powers the quick customer and product search |
| Data fetching | TanStack Query | |
| Tables / grids | TanStack Table | |
| Forms | React Hook Form + Zod resolver | |
| Dates | `date-fns` | Business timezone is Asia/Karachi |
| Charts | `chart.js` + `react-chartjs-2`, lazy-loaded | Used on the dashboard and profit reports only |
| Build | Vite (web), esbuild (server bundle to `dist/server.js`), `tsx` (dev) | |
| Tests | Vitest; Playwright only as a **dev** dependency for e2e | Playwright is never needed on the shop laptop |

## 4. Repository layout

```
shopledger/
  CLAUDE.md
  package.json                  # npm workspaces root
  .env.example                  # PORT, HOST, DATA_DIR, SESSION_SECRET
  apps/
    server/
      src/
        index.ts                # Fastify bootstrap, static UI, single-instance check
        config.ts               # reads env, resolves all paths from DATA_DIR
        db/
          client.ts             # better-sqlite3 + drizzle, pragmas
          schema.ts             # all tables
          migrations/           # generated by drizzle-kit, committed (incl. audit triggers)
        lib/
          money.ts              # paisa helpers, formatting, amount-in-words
          percent.ts            # basis-point helpers
          dates.ts              # business date, due dates, fiscal year, day differences
          numbering.ts          # document number sequences
          permissions.ts        # role -> permission sets, can(), requirePermission()
          redact.ts             # strips financial fields for roles without access
          pricing.ts            # price, supplier margin -> cost, customer discount -> amount, safety rules
          profit.ts             # line cost & profit, extra-discount spreading, return reversal
          ledger.ts             # posting/reversing ledger entries
          stock.ts              # stock movements, weighted average cost
          allocation.ts         # payment-to-invoice allocation (FIFO + manual)
          depreciation.ts       # straight-line depreciation (derived)
          audit.ts              # append-only audit writer + hash chain + verify
        modules/<feature>/      # customers, products, purchases, sales, returns, payments,
          routes.ts             #   overdue, expenses, assets, reports, changelog, settings,
          service.ts            #   users, backups, whatsapp
          service.test.ts
        pdf/                    # invoice, statement and report templates
        jobs/backup.ts
        cli/                    # reset-superuser.ts, verify-audit.ts
      test/helpers.ts           # creates an in-memory DB with migrations; users for each role
    web/
      src/
        routes/                 # one folder per screen
        components/             # shared UI (shadcn components live in components/ui)
        features/
        lib/api.ts              # typed fetch wrapper
        lib/permissions.ts      # re-exports shared permission keys for UI visibility
  packages/
    shared/                     # Zod schemas, types, enums, PERMISSIONS map
  scripts/
    seed.ts                     # realistic demo data
    install.bat                 # npm ci --omit=dev, migrate, create desktop shortcut
    start.bat                   # starts server and opens browser
  data/                         # gitignored: db, backups, invoices, logs
```

## 5. Commands

```
npm run dev              # server (tsx watch) + web (vite) together
npm run build            # vite build + esbuild server bundle
npm start                # node apps/server/dist/server.js (production)
npm test                 # vitest, all workspaces
npm run test:e2e         # playwright (dev machine only)
npm run db:generate      # drizzle-kit generate after any schema change
npm run db:migrate       # apply migrations to DATA_DIR db
npm run seed             # fill a NEW db with demo data (refuses if db has data)
npm run backup:now       # manual backup
npm run verify-audit     # check the audit log hash chain
npm run reset-superuser  # local-only recovery: reset superuser password
npm run typecheck && npm run lint
```

Before saying a task is done, always run `npm run typecheck` and `npm test`. Both must pass.

## 6. Architecture rules

- **Thin routes, fat services.** Routes only validate input with Zod, call `requirePermission()`, call a service, then pass the result through `redact()`. All business logic lives in `service.ts` and `lib/`.
- **Every write is one transaction.** A sale, purchase, payment, return, expense, asset, edit, void or write-off posts all of these together, or not at all:
  - the document
  - its ledger entries, stock movements and allocations
  - its **audit-log row**
- **better-sqlite3 transactions are synchronous.** Never put `await` inside `db.transaction()`. Do any async work (such as PDF generation) after the transaction commits.
- **Derived values are calculated, never stored.** Balances, outstanding amounts, overdue status, stock on hand, depreciation and period profit totals all come from the underlying tables.
  - Exception: per-line values captured when a document is posted (`list_price_paisa`, `discount_bp`, `line_net_paisa`, `unit_cost_paisa`, `line_cost_paisa`, `profit_paisa`). These are part of the document and are recalculated when it is edited.
- **Redaction.** Financial fields must be removed from API responses for roles without `finance.view`:
  - supplier margin %, cost and profit (everywhere: reports, product screens, sale screens)
  - stock valuation, expenses, assets
  - Exception: the purchase entry screen shows supplier margin and cost to anyone allowed to record purchases (section 9), because they are copying the manufacturer's bill.
- **Shared types.** Zod schemas in `packages/shared` are the single definition of API input and output.
- **Server binding.** By default the server listens on `127.0.0.1`. The setting `allow_lan_access` switches it to `0.0.0.0`.
- **Single instance.** On startup, if the port is already in use by ShopLedger, just open the browser instead of starting a second server.

## 7. Money, percentages, dates and numbering

- **Money is an integer number of paisa** (Rs 1 = 100 paisa). Never use floats for money. Column names end in `_paisa`. Only format at the edges: the UI and PDFs.
- **Percentages are integer basis points** (1% = 100 bp; 22.5% = 2250). Column names end in `_bp`. Show them as `22.5%`.
- **Display format:** `Rs 1,234,567` (en-PK grouping; paisa shown only if non-zero). Amount in words follows the Pakistani style: "Rupees Two Lakh Thirty Four Thousand Only".
- **Quantities are integers.** Each product has a unit (pcs, dozen, set, carton) and quantities are whole numbers of that unit.
- **Rounding:** all rounding is half-up to the nearest paisa, using integer math. Spread amounts across lines with the largest-remainder method so the totals match exactly.
- **Percentages are applied to line totals**, not per unit: discount = round(qty × price × bp ÷ 10000). This avoids per-unit rounding errors.
- **Dates:**
  - Business dates are stored as `TEXT 'YYYY-MM-DD'` in Asia/Karachi time.
  - Timestamps are stored as ISO-8601 UTC.
  - "Today" always comes from `lib/dates.ts` (`businessToday()`), which tests can mock.
- **Fiscal year:** controlled by `settings.fiscal_year_start_month`. The default is 7 (July–June, as in Pakistan). Yearly reports use the fiscal year, with a calendar-year option.
- **Document numbers:**
  - Each document type has its own sequence: `INV` sale, `PUR` purchase, `SRN` sales return, `PRN` purchase return, `RCV` receipt, `PAY` supplier payment, `WOF` write-off, `EXP` expense, `AST` asset.
  - The format is prefix + zero-padded number (for example `INV-000123`).
  - Numbers are assigned inside the posting transaction and are **never reused**. A voided document keeps its number.

## 8. Domain model

### 8.1 Glossary
- **Supplier**: the manufacturer we buy from. Stored as a table, because more suppliers may be added later.
- **Customer**: a wholesaler or retailer we sell to.
- **Product**: an item code with a name, category, unit, lists of available sizes and colors, and **one price** that applies to all its sizes and colors. It also has a supplier margin % and a default customer discount %.
- **Variant**: one product + color + size combination. Stock and line items always point to a variant.
- **Price**: the single price of a product (the list price). It appears on purchases and invoices. Every percentage is taken off this price.
- **Supplier margin %**: the margin the manufacturer gives the shop off the price. Cost = price − supplier margin (Rs 1,000 at 12% → cost Rs 880).
- **Customer discount %**: the margin or discount the shop gives a customer off the price (Rs 1,000 at 10% → the customer pays Rs 900). The shop may also call this the customer margin. The default comes from the product, and the operator can change it on each sale line.
- **Cost**: what the shop actually paid per unit (see 8.9 and 8.11).
- **Sale / Invoice**: goods sold to a customer.
- **Purchase**: goods bought from the supplier.
- **Sales return (credit note)**: goods coming back from a customer.
- **Purchase return (debit note)**: goods sent back to the supplier.
- **Payment**: money received from a customer (receipt) or paid to the supplier.
- **Allocation**: links a payment, credit note or write-off to a specific invoice, reducing that invoice's outstanding amount.
- **Payment terms**: the number of days a customer has to fully pay an invoice.
- **Due date**: invoice date + payment terms days.
- **Overdue**: an invoice that still has an outstanding amount after its due date (plus grace days).
- **Bad debt**: a customer flagged as unlikely to pay. Their balance may be written off.
- **Expense**: money spent running the business (rent, salaries, electricity...). It reduces net profit.
- **Asset**: something the business owns and uses for more than a year (furniture, laptop, vehicle...). It is not an expense; its depreciation reduces net profit.
- **Gross profit**: what customers paid minus what the goods cost the shop, minus the profit on returned goods. In the example above: Rs 900 − Rs 880 = **Rs 20**.
- **Net profit**: gross profit − expenses − depreciation − net bad debts ± gains or losses on sold assets.
- **Change history**: the superuser's view of every create, edit and void made to documents, built from the audit log.

### 8.2 Main tables (summary — `db/schema.ts` is the authority)

- **settings**: key/value store. Includes:
  - business details (name, address, phone, NTN/STRN)
  - payment terms: `default_payment_terms_days` (default 30), `grace_days` (default 0)
  - document prefixes; backup time, folders and retention
  - stock: `allow_negative_stock` (default false)
  - `allow_lan_access`
  - WhatsApp settings
  - invoice paper size (A4 or 80 mm)
  - fiscal year: `fiscal_year_start_month` (default 7)
  - **price and discount settings:**
    - `default_supplier_margin_bp` (default 1200 = 12%), used when creating products
    - `default_customer_discount_bp` (default 1000 = 10%), used when creating products
    - `retail_discount_reduction_bp` (default 0): optionally gives retailers a smaller discount than wholesalers
    - `min_profit_bp` (default 0): the lowest allowed profit, as a % of price
    - `below_min_profit_action` (`warn` default, or `require_owner`)
    - `operators_can_record_purchases` (default true)
  - `include_depreciation_in_profit` (default true)
- **users**: username, password_hash, role (`superuser|owner|operator`), active, created_by. **sessions**.
- **suppliers**: name, phone, address, opening balance.
- **customers**:
  - `code` (C-0001), name, business_name, `type` (`wholesaler|retailer`)
  - phone (E.164), alt_phone, city, area, address, ntn
  - `credit_limit_paisa` (0 means no limit)
  - `payment_terms_days` (filled from the settings default, editable)
  - `status` (`active|inactive|bad_debt`), bad_debt_marked_at, bad_debt_reason
  - notes, timestamps
- **products**:
  - item_code (unique), name, category, unit
  - sizes (JSON), colors (JSON)
  - `list_price_paisa`: **the one price** for the product, shared by all its sizes and colors
  - `supplier_margin_bp` (filled from the settings default; owner+ can edit)
  - `default_customer_discount_bp` (filled from the settings default; owner+ can edit)
  - `max_customer_discount_bp` (optional; a bigger discount needs owner approval)
  - active
- **product_price_history**: product_id, effective_date, list_price_paisa, supplier_margin_bp, default_customer_discount_bp, changed_by. A row is added whenever any of these change.
- **product_variants**: product_id, color, size, sku (unique), `avg_cost_paisa` (weighted average actual cost), low_stock_threshold. Variants have no price of their own.
- **purchases** + **purchase_items**: supplier, date, supplier_ref, totals, status (`posted|void`), `version`. Each line has:
  - variant, qty, `list_price_paisa`
  - `supplier_margin_bp` (prefilled from the product, editable to match the manufacturer's bill)
  - `line_gross_paisa` (qty × price), `line_margin_paisa`, `line_cost_paisa` (gross − margin), `unit_cost_paisa`
- **sales** + **sale_items**:
  - sale: customer, date, `payment_terms_days`, `due_date`, gross total, line discounts, extra discount, tax, total, status (`posted|void`), **`version`**, notes, created_by, updated_by
  - each line:
    - variant, qty, `list_price_paisa` (the product's price at the time of sale)
    - `default_discount_bp` (what the system suggested), `discount_bp` (what was actually given), `discount_overridden` (bool)
    - `line_gross_paisa` (qty × price), `line_discount_paisa`
    - `line_net_paisa` (after the line discount and its share of any extra invoice discount)
    - `unit_cost_paisa`, `cost_source` (`purchase_avg|estimated`), `line_cost_paisa`
    - `profit_paisa` (line net − line cost)
- **sales_returns** / **purchase_returns** + items: always linked to the original document and line, with a reason. Sales-return lines store `profit_reversed_paisa`.
- **payments**:
  - party_type (`customer|supplier`), party_id, date, amount_paisa
  - method (`cash|bank|cheque|online`), reference
  - for cheques: cheque_no, cheque_bank, cheque_date
  - status (`posted|void|bounced`)
- **payment_allocations**: source_type (`payment|sales_return|write_off`), source_id, sale_id, amount_paisa, is_manual.
- **write_offs**: customer_id, date, amount, reason, status.
- **expense_categories**: name, active. Seeded with: Rent, Salaries & wages, Electricity & gas, Transport & freight, Packing material, Repairs & maintenance, Phone & internet, Bank charges, Miscellaneous.
- **expenses**: doc_no, date, category_id, amount_paisa, method (`cash|bank`), paid_to, reference, notes, status (`posted|void`), version, created_by.
- **assets**:
  - doc_no, name, category (`furniture|equipment|computer|vehicle|other`)
  - purchase_date, cost_paisa, method, vendor
  - `depreciation_method` (`none|straight_line`), `useful_life_months`, `salvage_value_paisa`
  - disposal_date, disposal_amount_paisa
  - status (`active|disposed|void`), version, notes
- **ledger_entries**: party_type, party_id, date, debit_paisa, credit_paisa, entry_type, source_type, source_id, narration.
- **stock_movements**: variant_id, date, qty_change (+/−), unit_cost_paisa, source_type, source_id.
- **audit_log** (append-only, see 8.14):
  - id, at, user_id, user_role, action, entity, entity_id, doc_no
  - version_before, version_after
  - before_json, after_json, summary_json, flags (JSON), reason
  - prev_hash, row_hash
- **audit_reviews**: audit_id, reviewed_by, reviewed_at, note. Superuser review marks are kept here so the log itself never changes.
- **backup_log** (includes `audit_last_id` and `audit_last_hash`) and **whatsapp_log**.

**Indexes** at minimum on:
- `ledger_entries(party_type, party_id, date)`
- `sales(customer_id, status, due_date)`
- `sales(date)`
- `payment_allocations(sale_id)`
- `stock_movements(variant_id)`
- `expenses(date)`
- `audit_log(entity, entity_id)`, `audit_log(at)`, `audit_log(user_id)`
- an FTS5 table over customer name, business name, phone, city and code

### 8.3 Ledger conventions
- **Customer ledger:**
  - **Debit** (they owe more): sale, opening balance, bounced cheque, write-off reversal.
  - **Credit** (they owe less): receipt, sales return, write-off.
  - Balance = Σdebit − Σcredit. A positive balance is a receivable.
- **Supplier ledger:**
  - **Credit** (we owe more): purchase, opening balance.
  - **Debit** (we owe less): payment, purchase return.
  - Balance = Σcredit − Σdebit. A positive balance is a payable.
- **Cash at counter:** if a sale is paid in cash immediately, the system posts a separate receipt allocated to that invoice.
- **Expenses and asset purchases** do not touch customer or supplier ledgers. They appear in the cash/bank book and in the profit and asset reports.

### 8.4 Payment terms, due dates and overdue
- Each customer has a default `payment_terms_days`. New customers get `settings.default_payment_terms_days`.
- On a new sale, the terms are copied from the customer and can be changed for that sale. Then `due_date = sale.date + payment_terms_days`. Changing the sale date or the terms recalculates the due date.
- **Outstanding** (invoice) = total − Σ allocations to that invoice.
- **Overdue** (invoice) = `status='posted'` AND outstanding > 0 AND `businessToday() > due_date + grace_days`.
- **Days overdue** = `businessToday() − due_date`.
- **Overdue** (customer) = the customer has at least one overdue invoice.
- Overdue status is **always computed with SQL queries**, never stored.

### 8.5 Allocation
- By default, receipts, credit notes and write-offs are **auto-allocated FIFO**: oldest outstanding invoice first.
- The receipt screen lets the user pick specific invoices instead. Those allocations are saved with `is_manual=1`.
- Any unallocated amount stays as an **advance**. It shows on the customer's account and is auto-applied to the next invoice.
- After any edit, void or return that affects a customer:
  - Recalculate that customer's **auto** allocations inside the same transaction.
  - Keep manual allocations. If a manual allocation would now be more than the invoice total, stop and return a clear error so the user can fix it.

### 8.6 Editing and voiding
- **Documents are never hard-deleted.** Instead they are edited or voided (with a required reason).
- **Editing a posted document** happens in one transaction:
  1. Load the current version.
  2. Delete the ledger entries, stock movements and auto-allocations that this document created.
  3. Save the new version and increment `version`.
  4. Post fresh entries and recalculate line profit.
  5. Recalculate allocations.
  6. Write **one audit row** containing both the before and after snapshots.
- **Voiding** sets `status='void'` and removes the document's effects in the same way, with an audit row. The document stays visible, with a VOID stamp.
- **Who can edit or void:**
  - **Operators** can edit their own documents from the same day, with a reason.
  - **Owner and superuser** can edit or void any document, with a reason.
- **Customers and products** with transactions cannot be deleted, only deactivated.

### 8.7 Returns
- A sales return selects lines from the original invoice. It cannot return more than was sold minus what was already returned.
- It posts stock back in (at the original `unit_cost_paisa`) and credits the customer ledger.
- Its credit is allocated to the original invoice first, then FIFO.
- **Profit reversal:**
  - returned net = returned qty × (line_net ÷ qty)
  - returned cost = returned qty × the line's `unit_cost_paisa`
  - store returned net − returned cost as `profit_reversed_paisa`
- The customer is credited the **discounted** amount they actually paid, not the full price.
- Purchase returns work the same way in reverse (stock and supplier ledger only).

### 8.8 Bad debt
- **Marking a customer as bad debt** (owner/superuser only, reason required):
  - Sets `status='bad_debt'`.
  - Shows a red badge everywhere the customer appears.
  - New credit sales to them need owner confirmation. Cash sales are still allowed.
- **Write-off** (optional, owner/superuser only): posts a `WOF` credit for any amount up to their balance, allocated FIFO. Written-off invoices stop counting as overdue.
- **Recovery:** if a bad-debt customer later pays, the owner can reverse all or part of a write-off. This posts a debit and then records the receipt normally.
- **Un-marking** a customer sets their status back to `active`.
- All of these actions are audited.

### 8.9 Stock
- Stock on hand for a variant = Σ `stock_movements.qty_change`.
- **Cost** of a purchase line = price × (1 − supplier margin %). Example: 10 pcs at Rs 1,000 with 12% margin → cost Rs 8,800 (Rs 880 each).
- Weighted average cost of the variant is updated when each purchase is posted. Each sale line records the cost at the moment of posting.
- If the manufacturer changes the price or margin, stock already bought keeps its old cost; only new purchases bring in the new cost.
- If a sale would make stock negative: by default, warn and require owner confirmation. Setting `allow_negative_stock=true` turns this into a warning only.

### 8.10 Price, supplier margin and customer discount

Each product has **one price**. Every percentage is taken off that price.

| | Example |
|---|---|
| Product price | Rs 1,000 |
| Supplier margin 12% → **shop's cost** | 1,000 − 120 = **Rs 880** |
| Customer discount 10% → **customer pays** | 1,000 − 100 = **Rs 900** |
| **Shop's profit** | 900 − 880 = **Rs 20** (2% of price) |

- **The price on a sale line** is always the product's current `list_price_paisa`. Nobody can edit it on the line. To change a price, the owner updates the product; the change is recorded in price history and the audit log.
- **Default customer discount**, checked in this order:
  1. the product's `default_customer_discount_bp`
  2. `settings.default_customer_discount_bp`

  For **retail** customers, `retail_discount_reduction_bp` is subtracted (never below 0). The result is stored on the line as `default_discount_bp`.
- **On the New Sale screen**, the operator can change the **discount %** on any line, and the amount updates immediately. If it differs from the default, set `discount_overridden=true`.
- **Line amounts:**
  - line gross = qty × price
  - line discount = round(line gross × discount_bp ÷ 10000)
  - line amount = line gross − line discount
- **Safety rules**, checked for each line when saving:
  - Discount above the product's `max_customer_discount_bp` → needs owner approval.
  - Profit as a % of price, (line net − line cost) ÷ line gross, below `min_profit_bp` → follow `below_min_profit_action`.
  - **Selling below cost always needs owner/superuser approval** (password prompt).
  - The operator only sees "This discount needs owner approval". The message must never reveal cost or supplier margin.
- **Who sees what:**
  - Operators see price, discount % and amount.
  - Supplier margin %, cost and profit are owner+ only, with one exception: the purchase entry screen (section 6, redaction).
- **On customer-facing documents** (invoices, statements, WhatsApp): show price, discount % and amount. **Never** show supplier margin, cost or profit.

### 8.11 Profit calculation
- **Line net** = line amount − this line's share of any extra invoice discount. The extra discount is spread in proportion to line amount, using largest remainder. Tax is excluded from profit.
- **Line cost** = qty × `unit_cost_paisa`. The unit cost is either:
  - the variant's weighted average actual purchase cost (`cost_source='purchase_avg'`), or
  - if nothing has been purchased yet, an estimate of price × (1 − supplier margin %) (`cost_source='estimated'`).
- **Line profit** = line net − line cost.
  - When the cost matches the current price and supplier margin, this works out to qty × price × (supplier margin % − customer discount %).
  - In the example in 8.10 that is 1 × 1,000 × (12% − 10%) = **Rs 20**.
- Store line_net, line_cost and profit on each sale line at posting. Recalculate them on edit; void removes them.
- **Sale profit** = Σ line profit.
- **Gross profit** for a period = Σ profit of posted sales − Σ `profit_reversed_paisa` of returns in the period.
- **Net profit** for a period =
    gross profit
  − expenses (posted)
  − depreciation (if `include_depreciation_in_profit`)
  − write-offs + write-off reversals (net bad debt)
  ± gain or loss on disposed assets (disposal amount − book value)
- Purchases of stock and purchases of assets are **not** expenses and do not reduce profit directly.

### 8.12 Expenses (owner and superuser only)
- Create, edit and void with a reason. Every change is audited.
- Expense categories can be managed in settings: add, rename, deactivate. Categories that have expenses cannot be deleted.
- Expenses appear in the cash/bank book, the expense report and the profit & loss report.

### 8.13 Assets and depreciation (owner and superuser only)
- Record an asset with its cost, purchase date, payment method and depreciation settings. Edit, void and dispose with a reason. Every change is audited.
- **Straight-line depreciation:**
  - Monthly amount = (cost − salvage) ÷ useful_life_months.
  - It starts from the month after purchase and stops when fully depreciated or disposed.
  - It is calculated by `lib/depreciation.ts`, never stored.
- **Book value** on any date = cost − accumulated depreciation up to that date.
- **Disposal:** gain or loss = disposal amount − book value on the disposal date. This goes into net profit.
- Asset purchases and disposals appear in the cash/bank book.

### 8.14 Audit log and change history
- **Every create, edit, void, restore, print and WhatsApp-share** of these documents writes one `audit_log` row:
  - sales, purchases, returns, payments, write-offs, expenses, assets
- **Changes to these records** are also logged:
  - customers (including terms, credit limit, bad-debt status)
  - products (including price, supplier margin and default discount)
  - users, settings and backups/restores
- **Each row stores:** who (user and role), when, the action, version before and after, full before and after JSON snapshots, a human-readable `summary_json` (changed fields and changed lines), automatic `flags`, and the reason.
- **Automatic flags:**
  - `edited_after_shared`: edited after the invoice was sent on WhatsApp
  - `edited_after_printed`
  - `edited_later_day`: edited on a later day than it was created
  - `total_reduced` and `total_increased`
  - `customer_changed`
  - `discount_above_default`, `profit_below_minimum`, `sold_below_cost`
  - `extra_discount_added`
  - `price_changed` (product price, supplier margin or default discount changed)
  - `voided`
  - `by_operator`
- **Append-only:**
  - The app code has no update or delete paths for `audit_log`.
  - A migration adds SQLite triggers that `RAISE(ABORT)` on any UPDATE or DELETE of `audit_log`.
  - Logging cannot be switched off by any role.
- **Tamper evidence:**
  - row_hash = SHA-256(prev_hash + canonical JSON of the row's content).
  - The last id and hash are copied into every `backup_log` entry, so rows deleted from the end can be detected.
  - `npm run verify-audit` checks the chain, and so does the "Verify integrity" button on the change history screen.
- **Who can see it:** only the superuser can view the change history (section 10.6). The owner and operators cannot.

## 9. Roles and permissions

Permissions live in `packages/shared/permissions.ts` as named keys (for example `sales.create`, `finance.view`, `changelog.view`). Each role maps to a set of keys:

- The **superuser** gets every key, including all `superuser.*` keys.
- New superuser-only features in the future just add a new `superuser.<feature>` key; no other code needs to change.
- Every route declares the key it needs. The UI uses the same keys to show or hide menus and columns, but **the server is the real check**.

| Capability | Operator | Owner | Superuser |
|---|:-:|:-:|:-:|
| Create sales, receipts, supplier payments, returns | ✓ | ✓ | ✓ |
| Record purchases (shows supplier margin and cost) | ✓ if `operators_can_record_purchases` | ✓ | ✓ |
| Change the customer discount % on a sale line | ✓ | ✓ | ✓ |
| Add/edit customers and products (not price, supplier margin or default discount) | ✓ | ✓ | ✓ |
| Edit own same-day documents (with reason) | ✓ | ✓ | ✓ |
| Edit/void any document; bad debt; write-offs; bounced cheques | | ✓ | ✓ |
| Set prices, supplier margins, default/maximum discounts, minimum profit | | ✓ | ✓ |
| Approve a discount above the maximum, below minimum profit, or below cost (password prompt) | | ✓ | ✓ |
| Operational reports (statements, aging, overdue, stock qty, day book) | ✓ | ✓ | ✓ |
| **Expenses** (add/edit/void/view) | | ✓ | ✓ |
| **Assets** (add/edit/dispose/void/view) | | ✓ | ✓ |
| **Financial reports** (profit, P&L, net profit, supplier margins, cost, stock valuation, cash/bank book) | | ✓ | ✓ |
| Settings, backups, restore | | ✓ | ✓ |
| Manage operators | | ✓ | ✓ |
| Manage owners | | | ✓ |
| **Change history** view, review marks, verify audit integrity | | | ✓ |
| Future `superuser.*` features | | | ✓ |

**User rules:**
- There is **exactly one superuser.** It is created first, during first-run setup, after which the setup asks for the owner account.
- The superuser cannot be deleted, deactivated or demoted. Owners cannot see or edit the superuser account.
- If the superuser forgets their password, the only reset is `npm run reset-superuser`, run on the laptop itself. The reset is audited.
- **Sessions** are stored in SQLite and expire after 12 hours idle.
- **Login events** (success and failure) are recorded in the audit log.

## 10. Screens

**Navigation** (menus are hidden when the user lacks the permission):

- Dashboard
- New Sale
- Sales
- Purchases
- Payments
- Returns
- Customers
- **Overdue** (with a red count badge)
- Products & Stock
- Reports
- **Expenses** (owner+)
- **Assets** (owner+)
- Settings (owner+)
- **Change History** (superuser only)

### 10.1 New Sale (the most important screen — optimise it for speed)
- **Choosing a customer:**
  - Press `F2` (or click the customer field) to open the `cmdk` search. It searches name, business name, phone, city and code as you type, and works with partial words.
  - Each result shows the current balance and terms. An overdue badge ("Overdue Rs 45,000 · 23 days") and a bad-debt badge appear when they apply.
  - The last option is always "**+ Add new customer**". It opens a short dialog (name, phone, type, city, terms prefilled with the default). On save, the new customer is selected and the user is back in the sale.
- **Customer header:** once a customer is selected, the screen shows their outstanding balance, overdue amount, credit limit usage and payment terms.
- **Warnings (not blocks):**
  - The customer has overdue invoices.
  - This sale would take them over their credit limit.
- **Requires owner confirmation:** a credit sale to a bad-debt customer.
- **Adding lines:**
  1. Type an item code; it autocompletes from products.
  2. A **size × color grid** opens with stock on hand shown in each cell. Typing quantities in the grid creates one line per non-zero cell.
  3. **Line columns:** item, color, size, qty, price, **discount %**, amount.
  4. The price is the product's price and cannot be edited. Discount % is prefilled from the default (8.10) and can be edited; the amount updates immediately.
  5. A changed discount is highlighted. A discount that breaks a safety rule shows a warning or the owner prompt.
- **Owner/superuser only:** the sale's profit (in rupees and as a %) in the totals area, with any loss-making line marked red.
- **Saving:** totals (gross, discounts, net) update live. There is a field for an optional extra invoice discount in rupees, and another for cash received now. `Ctrl+S` saves; `Ctrl+Enter` saves and opens the share dialog (Print / PDF / WhatsApp).

### 10.2 Customers
- A list with search and filters (type, city, status). It shows balance, overdue amount, terms, last sale date and last payment date.
- **Customer detail** has tabs: Overview · Ledger · Invoices · Payments · Returns · Items bought · Notes. Owner+ also see a **Profit** tab.
- **Actions:** edit, record payment, mark/unmark bad debt, write-off, send statement on WhatsApp.

### 10.3 Overdue tab
- Lists **every customer who has at least one overdue invoice**, sorted by maximum days overdue (largest first).
- **Columns:** customer, phone, city, type, payment terms, number of overdue invoices, overdue amount, total outstanding, oldest due date, maximum days overdue, last payment date and amount.
- **Row colours** by maximum days overdue: 1–15 amber, 16–45 orange, 46+ red. These thresholds are configurable in settings.
- **Expanding a row** shows that customer's overdue invoices: invoice number, date, due date, total, paid, outstanding, days overdue.
- **Filters:**
  - customer type, city, minimum days overdue
  - "Include bad-debt customers" (off by default; bad-debt customers have their own sub-tab)
- **Actions per row:** record payment, open statement, send WhatsApp payment reminder.
- **Page actions:** print or export the list (PDF/CSV).
- The **nav badge** shows the number of overdue customers. It refreshes whenever a sale or payment is posted, and when the app starts each day.

### 10.4 Expenses (owner+)
- **Quick entry form:** date, category, amount, cash/bank, paid to, reference, notes. `Ctrl+S` saves and clears the form for the next entry.
- **List** with filters (date range, category, method), with totals by category and by month.
- Edit and void require a reason.

### 10.5 Assets (owner+)
- **Asset register:** name, category, purchase date, cost, depreciation method and life, accumulated depreciation, book value, status.
- **Add asset** form; **Dispose** dialog (date, amount received, reason). The asset detail page shows its monthly depreciation schedule.

### 10.6 Change History (superuser only)
- **Default view:** all invoice events (sales). There are tabs for **All documents** (purchases, returns, payments, write-offs, expenses, assets) and **Other changes** (customers, products, prices and discounts, users, settings, backups/restores, logins).
- **Table columns:**
  - date/time, user and role, action (created/edited/voided/printed/shared)
  - document number, customer
  - version (v2 → v3), total before → after, balance impact
  - reason, flag chips, reviewed ✓
- **Filters:**
  - date range, user, role (operator/owner), action, document type, customer
  - specific flags; "Flagged only"; "Not yet reviewed"
- **Clicking a row** opens a side-by-side **diff**:
  - header fields that changed
  - lines added (green), lines removed (red), lines changed (qty, price, discount % — showing old → new)
  - totals and profit impact
- **Per-document timeline:** every version of one invoice from creation to now. Any version can be viewed, and the PDF of any version can be re-created from its snapshot.
- **Discount overrides sub-view:** sale lines where `discount_overridden=true`, profit was below the minimum, or the item was sold below cost, grouped by user and product.
- **Actions:**
  - "Mark reviewed" (with an optional note), stored in `audit_reviews`
  - export CSV/PDF
  - "Verify integrity", which runs the hash-chain check and shows the result
- The superuser's dashboard shows a card with the number of **unreviewed flagged changes**.

### 10.7 Other screens
- **Purchases:** the same layout as New Sale, against the supplier, with the supplier's invoice reference.
  - Line columns: item, color, size, qty, price, **supplier margin %**, cost amount.
  - If the price on the manufacturer's bill differs from the product price, owner+ are asked whether to update the product price (recorded in price history).
- **Payments:**
  - Receive from a customer, with FIFO or manual allocation and a preview of how the money will be applied.
  - Pay the supplier.
  - Cheque details are recorded. "Mark cheque bounced" (owner+) voids the receipt with a reason and debits the customer.
- **Returns:** start from the original invoice or purchase.
- **Products & Stock:**
  - Products with sizes, colors, price, supplier margin % and default customer discount %; variants are generated from them. Operators see only price and default discount.
  - Stock-on-hand grid per product, low-stock list, and stock movement history per variant.
  - **Bulk update** (owner+): change the price (by % or by amount), supplier margin or default discount for a category or a selection of products. It is audited and recorded in price history.
  - **Price history** per product (owner+).
- **Settings** (owner+): business details, defaults, price and discount settings, document prefixes, fiscal year, users, backups and restore, WhatsApp, overdue colour thresholds, expense categories.

## 11. Reports

Every report has a date-range filter where it makes sense, and can be shown on screen, printed or downloaded as PDF, or exported to CSV. Write the CSV export by hand; no extra library.

### 11.1 Customer-level reports (all roles; profit columns owner+ only)
1. **Customer statement:** ledger for a date range with the opening balance, every entry with a running balance, and the closing balance. Can be sent on WhatsApp.
2. **Customer summary:** per customer — sales, returns, net sales, receipts, write-offs, balance, number of invoices, average invoice value. It also shows the average discount % given. Owner+ also see gross profit and profit %. Sortable; filter by type and city.
3. **Customer aging:** per customer, outstanding amounts split into Not due · 1–30 · 31–60 · 61–90 · 90+ days past due, with grand totals.
4. **Payment behaviour:**
   - Per customer: average days to pay, % of invoices paid on time, and longest delay.
   - "Days to pay" is calculated from allocations: the date an invoice became fully paid minus the invoice date.
5. **Items bought by customer:** quantity and value by product, color and size for a period.
6. **Customer activity:**
   - Last sale and last payment date.
   - Inactive customers (no purchase in N days).
   - New customers in the period.
7. **Overdue report:** the printable version of the Overdue tab.

### 11.2 Operational reports (all roles)
- Daily sales and purchases book.
- Receipts and supplier payments list.
- Sales quantity by item, color and size.
- Stock on hand (quantities only) and low stock list.
- Supplier statement.
- Price list with default customer discounts (printable to give to customers).

### 11.3 Financial and profit reports (owner and superuser only — `finance.view`)
1. **Profit & Loss:**
   - The fiscal year, with each month as a column and a year total.
   - Rows: net sales, cost of goods sold, gross profit, expenses by category, depreciation, net bad debts, asset gain/loss, **net profit**, net margin %.
   - Can be compared with the previous year.
2. **Net profit summary:** pick any period (today, this month, this fiscal year, custom) and see a single "how much did I actually make" answer, with a breakdown.
3. **Gross profit** by period, by item/variant, by customer, by customer type and city, and by operator (who made the sale).
4. **Discount report:** average discount % given by item, customer and operator, compared with the default; list of changed discounts.
5. **Profit check:**
   - sales below cost or below minimum profit
   - lines with estimated cost
   - products whose supplier margin is lower than their default customer discount (they lose money on every sale)
6. **Expense report:** by category and month, with the full list.
7. **Asset register and depreciation schedule:** book values as of any date.
8. **Cash/bank book:** receipts, supplier payments, expenses, asset purchases and disposals.
9. **Stock valuation** at average cost.
10. **Dashboard (owner+)** adds: profit today and this month, net profit for the fiscal year to date, expenses this month, and a 12-month profit trend chart.

The **operator dashboard** shows only: today's sales count and value, receipts today, the overdue count, and low stock.

## 12. Invoices and PDFs
- Generated server-side with `pdfmake`, saved to `DATA_DIR/invoices/YYYY/MM/<doc_no>-v<version>.pdf`, and regenerated after an edit. Old versions are kept.
- **Two templates:** A4 and 80 mm thermal.
- **Invoice contents:**
  - business header and invoice number
  - date, due date and payment terms
  - customer details
  - lines: item code, description, color, size, qty, price, discount %, amount
  - totals and amount in words
  - **previous balance, this invoice, total outstanding** (common practice in local wholesale)
  - notes and footer
- **Never include supplier margin, cost or profit** on any customer-facing PDF.
- Voided invoices are printed with a VOID watermark.
- Statements and reports reuse the same header and footer helpers.
- **Fonts:** use pdfmake's bundled Roboto. Urdu text is out of scope for now. If it is added later, note that pdfmake does not support complex script shaping, and ask first.
- **Printing:** open the PDF in a new browser tab; the user prints from there. Each print is logged as an audit event.

## 13. WhatsApp

All sending goes through one interface so the provider can be swapped without touching the rest of the app:

```ts
interface WhatsAppSender {
  sendInvoice(saleId: number): Promise<SendResult>;
  sendStatement(customerId: number, from: string, to: string): Promise<SendResult>;
  sendReminder(customerId: number): Promise<SendResult>;
}
```

- **Mode 1: `click_to_chat`** (default, free, no setup):
  1. Generate the PDF.
  2. Open `https://wa.me/<E164 number without +>?text=<encoded message>` in a new tab.
  3. Show a "PDF saved — Open folder" button. It calls a server endpoint that runs `explorer.exe /select,<path>`, which only works when the browser is on the same machine, so the user can drag the PDF into the chat.
- **Mode 2: `cloud_api`** (optional, official WhatsApp Business Platform):
  1. Upload the PDF as media.
  2. Send an approved **utility template** with a document header.
  3. Use the built-in `fetch`; no SDK.
  4. Store the settings (access token, phone number ID, template names) in the settings table. **Never log the token.**
- **Never** use unofficial libraries (`whatsapp-web.js`, Baileys, etc.). They risk the shop's number being banned.
- **Message templates** are editable in settings, with placeholders `{customer_name} {invoice_no} {invoice_date} {amount} {due_date} {balance} {overdue_amount} {days_overdue} {business_name}`.
- **Logging:**
  - Every attempt is recorded in `whatsapp_log` (customer, document, mode, status, error, timestamp), plus an audit `shared` event.
  - The invoice page shows "Sent on WhatsApp at …" once one has been sent.
- **Missing or invalid phone number:** show a clear prompt to edit the customer's number.

## 14. Backups
- Use better-sqlite3's online `.backup()`, which is safe while the app is running. Files are named `DATA_DIR/backups/shopledger-YYYY-MM-DD_HHmm.db`.
- **When backups run:**
  - daily at the configured time (default 21:00) using `croner`
  - at startup, if the last backup is more than 12 hours old
  - on graceful shutdown
  - manually, from Settings
- **After each backup:**
  - Open the copy and run `PRAGMA integrity_check`. If it fails, mark the backup as failed in `backup_log` and alert the user.
  - Record the audit log's last id and hash in `backup_log`.
  - Copy it to an optional **second folder** (a USB drive, or a Google Drive / OneDrive desktop-sync folder). No cloud APIs.
- **Retention:** keep 30 daily and 12 monthly backups; delete older ones.
- **Restore** (owner+):
  1. Pick a backup.
  2. Validate it.
  3. Take a safety backup of the current database.
  4. Swap the files.
  5. Restart.

  The restore is written to the audit log of the restored database as the first event after startup, together with details of the pre-restore safety backup.
- The app footer always shows "Last backup: …". It turns red if the last good backup is more than 36 hours old.

## 15. UI conventions
- **Keyboard first:**
  - `F2` customer search, `F3` product search, `F4` new sale
  - `Ctrl+S` save, `Esc` close dialog
  - `Enter` moves to the next field in line-item grids
  - A `?` key shows the shortcut list.
- **Clarity:**
  - Large readable text, high contrast.
  - Amounts are right-aligned in monospace digits.
  - Negative balances (advances) are shown clearly as "Advance Rs X".
- **Status badges:** Overdue (amber/orange/red), Bad debt (red), Void (grey), Advance (blue), Discount changed (purple), Estimated cost (grey, owner+), Below cost (red, owner+).
- **Permissions in the UI:** menus, columns and buttons the user lacks permission for are **hidden**, not just disabled. The data is also never fetched.
- **Confirmations:** every destructive or owner-level action has a confirmation dialog with a reason field when one is required. When an owner must approve an action during an operator's session, the dialog asks for the owner's password inline.
- **Layout:** works well at 1366×768, the common laptop resolution. No heavy animations.
- **Errors:** shown in plain language with what to do next. No stack traces in the UI.

## 16. Testing rules
- Vitest runs against an **in-memory SQLite database with the real migrations applied** (`test/helpers.ts` also creates a superuser, an owner and an operator). Tests never touch `DATA_DIR`.
- `businessToday()` is mocked in every test that depends on dates.
- **Every function that changes money, stock, profit or permissions must have tests.** At minimum:
  - ledger posting and balances for every document type
  - FIFO and manual allocation, advances, and recalculation after edit or void
  - due date and overdue calculation, including grace days and boundary days
  - sales and purchase returns with quantity limits and profit reversal
  - write-off and its reversal; bounced cheques
  - weighted average cost and stock on hand
  - **pricing:**
    - the worked example: price 1,000, supplier margin 12%, customer discount 10% → cost 880, customer pays 900, profit 20
    - discount rounding on line totals
    - default discount order and retail reduction
    - maximum discount, minimum profit and below-cost rules (including that the operator's message never reveals cost)
    - price changes: old stock keeps its old cost; price history is recorded
  - **profit:**
    - extra invoice discount spreading (totals exact to the paisa)
    - line profit with average cost and with estimated cost
    - gross profit and net profit over periods
    - fiscal-year boundaries
  - expenses (create, edit, void) and their effect on net profit
  - depreciation schedules, book value, and disposal gain/loss
  - **permissions:** for every protected route, the operator gets 403; owner and superuser rules; financial fields are redacted for operators; only one superuser; the superuser cannot be modified by an owner
  - **audit:**
    - every write creates exactly one audit row
    - flags are computed correctly
    - UPDATE and DELETE on `audit_log` fail because of the triggers
    - the hash chain verifies, and detects a tampered row and a truncated tail
  - document numbering (no gaps from failed transactions, no reuse)
  - money formatting and amount in words (including lakh/crore)
  - aging buckets and the customer summary totals
  - backup creation, integrity check and restore
- **Playwright e2e** (dev only) covers:
  - login → new sale with a new customer and a changed discount → share
  - receive payment → the overdue list updates
  - the owner edits an invoice → the superuser sees the diff in Change History
  - an operator cannot open the Expenses, Assets or profit report URLs
- **Seed script:**
  - 40 customers with Pakistani names and cities, and varied payment terms
  - 60 products with sizes, colors, prices, supplier margins of 10–15% and default discounts of 5–12%
  - 6 months of sales, purchases, payments and returns
  - expenses and three assets
  - edits by both an operator and the owner
  - overdue and bad-debt cases

  This lets every report be checked by eye.

## 17. Never do these
- Never use floats for money or percentages.
- Never store balances, outstanding amounts, overdue flags, stock on hand, depreciation or period profit totals as columns.
- Never hard-delete documents, or customers/products that have transactions.
- Never update or delete `audit_log` rows, add a way to switch logging off, or show the change history to anyone except the superuser.
- Never send supplier margin, cost, profit, expenses, assets or stock valuation to a user without `finance.view` (except the purchase entry rule in section 6).
- Never check permissions only in the UI.
- Never print supplier margin, cost or profit on customer-facing documents or messages.
- Never let a sale line's price differ from the product's price; only the discount % changes.
- Never change the schema without `npm run db:generate` and committing the migration.
- Never run seeds, tests or experiments against a real `DATA_DIR` database.
- Never make network calls in tests.
- Never commit `data/`, `.env`, tokens or customer data.
- Never use unofficial WhatsApp libraries.
- Never add Chromium, Electron, Docker or a database server.
- Never put `await` inside a better-sqlite3 transaction.

## 18. Deployment to the shop laptop
1. Install Node.js 24 LTS (Windows x64 installer).
2. Copy the built app folder: `apps/server/dist`, `apps/web/dist`, `package.json`, `package-lock.json`, `scripts/`.
3. Run `scripts/install.bat`. It runs `npm ci --omit=dev`, applies migrations, creates the `data` folder, and adds a desktop shortcut plus a Startup-folder shortcut to `start.bat`.
4. First run: create the superuser, then the owner, then operators.
5. To move existing data: copy the old `data` folder, or restore the latest backup from Settings. Then run `npm run verify-audit`.
6. Write a one-page `docs/USER_GUIDE.md` (with separate sections for operator, owner and superuser) and `docs/MOVE_TO_NEW_LAPTOP.md`, in plain English.

## 19. Build progress

Update this checklist as phases are completed.

- [ ] Phase 1 — Foundation: repo, config, DB, roles & permissions, superuser/owner setup, append-only audit log, settings, backups
- [ ] Phase 2 — Master data: customers, supplier, products & variants with price, supplier margin and default discount
- [ ] Phase 3 — Purchases (price − supplier margin = cost), purchase returns, stock & average cost
- [ ] Phase 4 — Sales: New Sale screen, customer search/add, size×color grid, customer discount % & profit, invoice PDF
- [ ] Phase 5 — Payments, allocation, sales returns, ledgers/statements, write-offs, bounced cheques
- [ ] Phase 6 — Payment terms & Overdue tab
- [ ] Phase 7 — Editing/voiding + superuser Change History
- [ ] Phase 8 — Expenses & assets (owner+)
- [ ] Phase 9 — Reports: customer, operational, financial/profit & dashboards
- [ ] Phase 10 — WhatsApp (click-to-chat, then Cloud API mode)
- [ ] Phase 11 — Packaging, install scripts, seed data, user guide, move-to-laptop test
