import { z } from 'zod';

export const PARTY_TYPES = ['customer', 'supplier'] as const;
export type PartyType = (typeof PARTY_TYPES)[number];

/** What created a ledger entry. More types are added as document phases are built. */
export const LEDGER_ENTRY_TYPES = [
  'opening_balance',
  'sale',
  'receipt',
  'sales_return',
  'write_off',
  'write_off_reversal',
  'bounced_cheque',
  'purchase',
  'supplier_payment',
  'purchase_return',
] as const;
export type LedgerEntryType = (typeof LEDGER_ENTRY_TYPES)[number];

export const ledgerLineSchema = z.object({
  id: z.number().int(),
  date: z.string(),
  entry_type: z.enum(LEDGER_ENTRY_TYPES),
  source_type: z.string(),
  source_id: z.number().int(),
  narration: z.string().nullable(),
  debit_paisa: z.number().int(),
  credit_paisa: z.number().int(),
  /** Running balance after this line (customer: owed to us; supplier: owed by us). */
  balance_paisa: z.number().int(),
});
export type LedgerLine = z.infer<typeof ledgerLineSchema>;

export const statementSchema = z.object({
  opening_balance_paisa: z.number().int(),
  lines: z.array(ledgerLineSchema),
  closing_balance_paisa: z.number().int(),
});
export type Statement = z.infer<typeof statementSchema>;

export const statementQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
