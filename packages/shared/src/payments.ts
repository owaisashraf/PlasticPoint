import { z } from 'zod';
import { businessDateSchema, listQuerySchema, optionalText, reasonSchema } from './common';

export const PAYMENT_METHODS = ['cash', 'bank', 'cheque', 'online'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_STATUSES = ['posted', 'void', 'bounced'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** receipt: from a customer · supplier_payment: to the supplier · refund: back to a customer for returned goods. */
export const PAYMENT_KINDS = ['receipt', 'supplier_payment', 'refund'] as const;
export type PaymentKind = (typeof PAYMENT_KINDS)[number];

/** What reduces an invoice's (or the opening balance's) outstanding amount (CLAUDE.md 8.5). */
export const ALLOCATION_SOURCES = ['payment', 'sales_return', 'write_off', 'opening_balance'] as const;
export type AllocationSource = (typeof ALLOCATION_SOURCES)[number];

const amountSchema = z.number().int('Amounts must be whole paisa').min(1, 'Enter an amount above zero');

/** Method, reference and cheque details, shared by receipts and supplier payments. */
const moneyFields = {
  date: businessDateSchema,
  amount_paisa: amountSchema,
  method: z.enum(PAYMENT_METHODS),
  reference: optionalText(80),
  cheque_no: optionalText(40),
  cheque_bank: optionalText(80),
  cheque_date: businessDateSchema.nullish().transform((v) => v ?? null),
  notes: optionalText(500),
};

function chequeNeedsNumber(v: { method: PaymentMethod; cheque_no: string | null }, ctx: z.RefinementCtx) {
  if (v.method === 'cheque' && !v.cheque_no) ctx.addIssue({ code: 'custom', path: ['cheque_no'], message: 'Enter the cheque number' });
}

/**
 * A manual allocation picked on the receipt screen. `sale_id: null` pays the
 * customer's opening balance.
 */
export const manualAllocationSchema = z.object({
  sale_id: z.number().int().positive().nullable(),
  amount_paisa: amountSchema,
});

export const createReceiptSchema = z
  .object({
    customer_id: z.number().int().positive(),
    ...moneyFields,
    /** Empty: allocate FIFO (oldest first). Otherwise exactly these; anything left is an advance. */
    allocations: z.array(manualAllocationSchema).max(500).default([]),
  })
  .strict()
  .superRefine(chequeNeedsNumber);
export type CreateReceiptInput = z.input<typeof createReceiptSchema>;

export const createSupplierPaymentSchema = z
  .object({
    supplier_id: z.number().int().positive(),
    ...moneyFields,
  })
  .strict()
  .superRefine(chequeNeedsNumber);
export type CreateSupplierPaymentInput = z.input<typeof createSupplierPaymentSchema>;

export const bounceChequeSchema = z.object({ reason: reasonSchema, date: businessDateSchema.optional() }).strict();

export const paymentListQuerySchema = listQuerySchema.extend({
  kind: z.enum(PAYMENT_KINDS).optional(),
  customer_id: z.coerce.number().int().positive().optional(),
  supplier_id: z.coerce.number().int().positive().optional(),
  from: businessDateSchema.optional(),
  to: businessDateSchema.optional(),
});
export type PaymentListQuery = z.input<typeof paymentListQuerySchema>;

export const paymentAllocationSchema = z.object({
  source_type: z.enum(ALLOCATION_SOURCES),
  source_id: z.number().int(),
  /** Null: the opening balance. */
  sale_id: z.number().int().nullable(),
  sale_doc_no: z.string().nullable(),
  amount_paisa: z.number().int(),
  is_manual: z.boolean(),
});
export type PaymentAllocation = z.infer<typeof paymentAllocationSchema>;

export const paymentSchema = z.object({
  id: z.number().int(),
  doc_no: z.string(),
  kind: z.enum(PAYMENT_KINDS),
  party_type: z.enum(['customer', 'supplier']),
  party_id: z.number().int(),
  party_name: z.string(),
  party_code: z.string().nullable(),
  date: z.string(),
  amount_paisa: z.number().int(),
  method: z.enum(PAYMENT_METHODS),
  reference: z.string().nullable(),
  cheque_no: z.string().nullable(),
  cheque_bank: z.string().nullable(),
  cheque_date: z.string().nullable(),
  status: z.enum(PAYMENT_STATUSES),
  bounced_at: z.string().nullable(),
  bounce_reason: z.string().nullable(),
  sale_id: z.number().int().nullable(),
  sales_return_id: z.number().int().nullable(),
  notes: z.string().nullable(),
  version: z.number().int(),
  created_at: z.string(),
  created_by_name: z.string().nullable(),
  /** Receipts: how much is linked to invoices; the rest is an advance. */
  allocated_paisa: z.number().int(),
  allocations: z.array(paymentAllocationSchema).optional(),
});
export type Payment = z.infer<typeof paymentSchema>;

/** Something a customer still owes: an invoice, or the opening balance (sale_id null). */
export const openItemSchema = z.object({
  sale_id: z.number().int().nullable(),
  doc_no: z.string().nullable(),
  date: z.string(),
  due_date: z.string().nullable(),
  total_paisa: z.number().int(),
  paid_paisa: z.number().int(),
  outstanding_paisa: z.number().int(),
});
export type OpenItem = z.infer<typeof openItemSchema>;

export const openItemsSchema = z.object({
  items: z.array(openItemSchema),
  /** Credit not linked to anything yet (shown as "Advance"). */
  advance_paisa: z.number().int(),
});
export type OpenItems = z.infer<typeof openItemsSchema>;

// --- Write-offs (CLAUDE.md 8.8) ---------------------------------------------------------

export const createWriteOffSchema = z.object({ date: businessDateSchema, amount_paisa: amountSchema, reason: reasonSchema }).strict();
export type CreateWriteOffInput = z.input<typeof createWriteOffSchema>;

export const reverseWriteOffSchema = createWriteOffSchema;
export type ReverseWriteOffInput = z.input<typeof reverseWriteOffSchema>;

export const writeOffSchema = z.object({
  id: z.number().int(),
  doc_no: z.string(),
  customer_id: z.number().int(),
  date: z.string(),
  amount_paisa: z.number().int(),
  reversed_paisa: z.number().int(),
  reason: z.string(),
  status: z.enum(['posted', 'void']),
  created_at: z.string(),
  created_by_name: z.string().nullable(),
  reversals: z.array(z.object({ id: z.number().int(), date: z.string(), amount_paisa: z.number().int(), reason: z.string(), created_at: z.string() })),
});
export type WriteOff = z.infer<typeof writeOffSchema>;
