import { desc, eq } from 'drizzle-orm';
import { assetListQuerySchema, createAssetSchema, disposeAssetSchema, updateAssetSchema, type Asset } from '@shopledger/shared';
import type { z } from 'zod';
import { writeTx, type DB, type DbOrTx } from '../../db/client';
import { assets, users } from '../../db/schema';
import { writeAudit } from '../../lib/audit';
import { businessToday, nowIso } from '../../lib/dates';
import { accumulatedDepreciation, depreciationSchedule, disposalGainLoss } from '../../lib/depreciation';
import { assertCanEdit, assertCanVoid, changeFlags, diffSnapshots, diffSummary, totalFlags, uniqueFlags } from '../../lib/documents';
import { badRequest, notFound } from '../../lib/errors';
import { nextDocNo } from '../../lib/numbering';
import type { SessionUser } from '../../lib/permissions';
import { auditActor } from '../auth/service';

type CreateInput = z.output<typeof createAssetSchema>;
type UpdateInput = z.output<typeof updateAssetSchema>;
type DisposeInput = z.output<typeof disposeAssetSchema>;
type ListQuery = z.output<typeof assetListQuerySchema>;
type AssetRow = typeof assets.$inferSelect;

/**
 * Assets (CLAUDE.md 8.13), owner and superuser only: things the business
 * owns and uses for more than a year. Not an expense. Depreciation, book
 * value and disposal gain/loss are worked out by lib/depreciation.ts.
 */

// --- Reading -----------------------------------------------------------------------

/**
 * The asset with its depreciation as of `asOf` (or its disposal date, if
 * earlier). Void assets carry no depreciation.
 */
function toAsset(row: AssetRow, createdByName: string | null, asOf: string, withSchedule = false): Asset {
  const at = row.disposal_date && row.disposal_date < asOf ? row.disposal_date : asOf;
  const accumulated = row.status === 'void' ? 0 : accumulatedDepreciation(row, at);
  const { created_by, updated_by: _u, updated_at: _ua, ...rest } = row;
  return {
    ...rest,
    monthly_depreciation_paisa: depreciationSchedule({ ...row, disposal_date: null })[0]?.charge_paisa ?? 0,
    disposal_gain_paisa: row.status === 'disposed' ? disposalGainLoss(row) : null,
    as_of: at,
    accumulated_depreciation_paisa: accumulated,
    book_value_paisa: row.cost_paisa - accumulated,
    created_by_id: created_by,
    created_by_name: createdByName,
    ...(withSchedule ? { schedule: row.status === 'void' ? [] : depreciationSchedule(row) } : {}),
  };
}

export function getAsset(db: DbOrTx, id: number, asOf = businessToday()): Asset {
  const r = db.select({ a: assets, created_by_name: users.display_name }).from(assets).leftJoin(users, eq(users.id, assets.created_by)).where(eq(assets.id, id)).get();
  if (!r) throw notFound('Asset not found.');
  return toAsset(r.a, r.created_by_name, asOf, true);
}

/** The asset register, with book values as of a date (default today). */
export function listAssets(db: DB, q: ListQuery): { assets: Asset[]; totals: { cost_paisa: number; accumulated_depreciation_paisa: number; book_value_paisa: number } } {
  const asOf = q.as_of ?? businessToday();
  const rows = db
    .select({ a: assets, created_by_name: users.display_name })
    .from(assets)
    .leftJoin(users, eq(users.id, assets.created_by))
    .where(q.status === 'all' ? undefined : eq(assets.status, q.status))
    .orderBy(desc(assets.purchase_date), desc(assets.id))
    .all()
    // An asset bought after the as-of date was not owned yet.
    .filter((r) => r.a.purchase_date <= asOf)
    .map((r) => toAsset(r.a, r.created_by_name, asOf));
  const held = rows.filter((a) => a.status === 'active' || (a.status === 'disposed' && (a.disposal_date ?? '') > asOf));
  return {
    assets: rows,
    totals: {
      cost_paisa: held.reduce((s, a) => s + a.cost_paisa, 0),
      accumulated_depreciation_paisa: held.reduce((s, a) => s + a.accumulated_depreciation_paisa, 0),
      book_value_paisa: held.reduce((s, a) => s + a.book_value_paisa, 0),
    },
  };
}

// --- Writing ------------------------------------------------------------------------

function loadRow(tx: DbOrTx, id: number): AssetRow {
  const row = tx.select().from(assets).where(eq(assets.id, id)).get();
  if (!row) throw notFound('Asset not found.');
  return row;
}

/** Edits and voids treat an asset that is still on the books as "posted". */
const asDoc = (r: AssetRow) => ({ ...r, status: r.status === 'void' ? 'void' : 'posted' });

function snapshot(db: DbOrTx, id: number) {
  const { schedule: _s, ...a } = getAsset(db, id);
  return a;
}

export function createAsset(db: DB, user: SessionUser, input: CreateInput): Asset {
  if (input.purchase_date > businessToday()) throw badRequest('The purchase date cannot be in the future.');
  return writeTx(db, (tx) => {
    const now = nowIso();
    const row = tx
      .insert(assets)
      .values({
        doc_no: nextDocNo(tx, 'asset'),
        name: input.name,
        category: input.category,
        purchase_date: input.purchase_date,
        cost_paisa: input.cost_paisa,
        method: input.method,
        vendor: input.vendor,
        depreciation_method: input.depreciation_method,
        useful_life_months: input.depreciation_method === 'straight_line' ? input.useful_life_months : null,
        salvage_value_paisa: input.salvage_value_paisa,
        notes: input.notes,
        status: 'active',
        version: 1,
        created_by: user.id,
        updated_by: user.id,
        created_at: now,
        updated_at: now,
      })
      .returning()
      .get();
    const after = snapshot(tx, row.id);
    writeAudit(tx, auditActor(user), {
      action: 'create',
      entity: 'asset',
      entity_id: row.id,
      doc_no: row.doc_no,
      version_after: 1,
      after,
      summary: { name: row.name, cost_paisa: row.cost_paisa, method: row.method, depreciation: row.depreciation_method, useful_life_months: row.useful_life_months },
    });
    return getAsset(tx, row.id);
  });
}

export function updateAsset(db: DB, user: SessionUser, id: number, input: UpdateInput): Asset {
  if (input.purchase_date > businessToday()) throw badRequest('The purchase date cannot be in the future.');
  return writeTx(db, (tx) => {
    const row = loadRow(tx, id);
    assertCanEdit(user, asDoc(row), 'assets.manage');
    if (row.disposal_date && input.purchase_date > row.disposal_date) throw badRequest('The purchase date cannot be after the disposal date.');
    const before = snapshot(tx, id);
    tx.update(assets)
      .set({
        name: input.name,
        category: input.category,
        purchase_date: input.purchase_date,
        cost_paisa: input.cost_paisa,
        method: input.method,
        vendor: input.vendor,
        depreciation_method: input.depreciation_method,
        useful_life_months: input.depreciation_method === 'straight_line' ? input.useful_life_months : null,
        salvage_value_paisa: input.salvage_value_paisa,
        notes: input.notes,
        version: row.version + 1,
        updated_by: user.id,
        updated_at: nowIso(),
      })
      .where(eq(assets.id, id))
      .run();
    const after = snapshot(tx, id);
    const diff = diffSnapshots(before, after, (l) => String(l.id), (l) => String(l.id));
    writeAudit(tx, auditActor(user), {
      action: 'edit',
      entity: 'asset',
      entity_id: id,
      doc_no: row.doc_no,
      version_before: row.version,
      version_after: row.version + 1,
      before,
      after,
      summary: { ...diffSummary(diff), cost_before_paisa: row.cost_paisa, cost_after_paisa: input.cost_paisa },
      flags: uniqueFlags(changeFlags(tx, user, 'asset', id, row.created_at), totalFlags(row.cost_paisa, input.cost_paisa)),
      reason: input.change_reason,
    });
    return getAsset(tx, id);
  });
}

/** Sold or scrapped: the gain or loss (amount received − book value then) goes into net profit. */
export function disposeAsset(db: DB, user: SessionUser, id: number, input: DisposeInput): Asset {
  if (input.date > businessToday()) throw badRequest('The disposal date cannot be in the future.');
  return writeTx(db, (tx) => {
    const row = loadRow(tx, id);
    if (row.status !== 'active') throw badRequest(row.status === 'disposed' ? 'This asset was already disposed of.' : 'This asset is void.');
    if (input.date < row.purchase_date) throw badRequest('The disposal date cannot be before the purchase date.');
    const before = snapshot(tx, id);
    tx.update(assets)
      .set({
        status: 'disposed',
        disposal_date: input.date,
        disposal_amount_paisa: input.amount_paisa,
        disposal_method: input.method,
        disposal_reason: input.reason,
        version: row.version + 1,
        updated_by: user.id,
        updated_at: nowIso(),
      })
      .where(eq(assets.id, id))
      .run();
    const after = snapshot(tx, id);
    writeAudit(tx, auditActor(user), {
      action: 'dispose',
      entity: 'asset',
      entity_id: id,
      doc_no: row.doc_no,
      version_before: row.version,
      version_after: row.version + 1,
      before,
      after,
      summary: { book_value_paisa: after.book_value_paisa, disposal_amount_paisa: input.amount_paisa, gain_paisa: after.disposal_gain_paisa },
      reason: input.reason,
    });
    return getAsset(tx, id);
  });
}

export function voidAsset(db: DB, user: SessionUser, id: number, reason: string): Asset {
  return writeTx(db, (tx) => {
    const row = loadRow(tx, id);
    assertCanVoid(user, asDoc(row));
    const before = snapshot(tx, id);
    tx.update(assets).set({ status: 'void', version: row.version + 1, updated_by: user.id, updated_at: nowIso() }).where(eq(assets.id, id)).run();
    writeAudit(tx, auditActor(user), {
      action: 'void',
      entity: 'asset',
      entity_id: id,
      doc_no: row.doc_no,
      version_before: row.version,
      version_after: row.version + 1,
      before,
      after: snapshot(tx, id),
      summary: { cost_before_paisa: row.cost_paisa, cost_after_paisa: 0 },
      flags: uniqueFlags(changeFlags(tx, user, 'asset', id, row.created_at), ['voided']),
      reason,
    });
    return getAsset(tx, id);
  });
}
