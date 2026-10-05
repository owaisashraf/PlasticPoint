import { sql } from 'drizzle-orm';
import type { Settings } from '@shopledger/shared';
import type { DbOrTx } from '../db/client';
import { sequences } from '../db/schema';
import { getSetting } from '../modules/settings/service';

/**
 * Number sequences (CLAUDE.md 7). Call these inside the posting transaction:
 * if the transaction rolls back, the number is not used up, and a number that
 * was committed is never handed out again (voided documents keep theirs).
 */

/** Document types and the setting that holds each prefix. */
export const DOC_TYPES = {
  sale: 'prefix_sale',
  purchase: 'prefix_purchase',
  sales_return: 'prefix_sales_return',
  purchase_return: 'prefix_purchase_return',
  receipt: 'prefix_receipt',
  refund: 'prefix_refund',
  supplier_payment: 'prefix_supplier_payment',
  write_off: 'prefix_write_off',
  expense: 'prefix_expense',
  asset: 'prefix_asset',
} as const satisfies Record<string, keyof Settings>;
export type DocType = keyof typeof DOC_TYPES;

/** Increments and returns the next value of a named sequence (1, 2, 3, ...). */
export function nextSequence(tx: DbOrTx, name: string): number {
  const row = tx
    .insert(sequences)
    .values({ name, last_value: 1 })
    .onConflictDoUpdate({ target: sequences.name, set: { last_value: sql`${sequences.last_value} + 1` } })
    .returning({ value: sequences.last_value })
    .get();
  return row.value;
}

export function formatNumber(prefix: string, n: number, width: number): string {
  return `${prefix}-${String(n).padStart(width, '0')}`;
}

/**
 * Next document number, e.g. INV-000123. The sequence is keyed by document
 * type, so changing a prefix in settings continues the same numbering.
 */
export function nextDocNo(tx: DbOrTx, type: DocType): string {
  const prefix = getSetting(tx, DOC_TYPES[type]);
  return formatNumber(prefix, nextSequence(tx, `doc:${type}`), 6);
}

/** Next customer code, e.g. C-0001. */
export function nextCustomerCode(tx: DbOrTx): string {
  return formatNumber('C', nextSequence(tx, 'customer'), 4);
}
