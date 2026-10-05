import { z } from 'zod';
import { businessDateSchema, listQuerySchema, reasonSchema } from './common';

/** A sales return (credit note), started from the original invoice (CLAUDE.md 8.7). */
export const createSalesReturnSchema = z
  .object({
    date: businessDateSchema,
    reason: reasonSchema,
    lines: z
      .array(z.object({ sale_item_id: z.number().int().positive(), qty: z.number().int().min(1).max(1_000_000) }).strict())
      .min(1, 'Pick at least one item to return')
      .max(500),
    /** Optional money paid back now; at most the credit of this return. */
    refund: z
      .object({ amount_paisa: z.number().int().min(1, 'Enter the refund amount'), method: z.enum(['cash', 'bank', 'online']) })
      .strict()
      .optional(),
  })
  .strict();
export type CreateSalesReturnInput = z.input<typeof createSalesReturnSchema>;

export const returnListQuerySchema = listQuerySchema.extend({
  from: businessDateSchema.optional(),
  to: businessDateSchema.optional(),
  customer_id: z.coerce.number().int().positive().optional(),
});
export type ReturnListQuery = z.input<typeof returnListQuerySchema>;

export const salesReturnSchema = z.object({
  id: z.number().int(),
  doc_no: z.string(),
  sale_id: z.number().int(),
  sale_doc_no: z.string(),
  customer_id: z.number().int(),
  customer_name: z.string(),
  customer_code: z.string(),
  date: z.string(),
  reason: z.string(),
  total_paisa: z.number().int(),
  /** Owner+ only. */
  profit_reversed_paisa: z.number().int().optional(),
  refunded_paisa: z.number().int(),
  status: z.enum(['posted', 'void']),
  created_at: z.string(),
  created_by_name: z.string().nullable(),
  total_qty: z.number().int(),
  lines: z
    .array(
      z.object({
        id: z.number().int(),
        sale_item_id: z.number().int(),
        item_code: z.string(),
        name: z.string(),
        color: z.string(),
        size: z.string(),
        qty: z.number().int(),
        line_net_paisa: z.number().int(),
        unit_cost_paisa: z.number().int().optional(),
        line_cost_paisa: z.number().int().optional(),
        profit_reversed_paisa: z.number().int().optional(),
      }),
    )
    .optional(),
});
export type SalesReturn = z.infer<typeof salesReturnSchema>;

/** Purchase returns in the Returns list (cost is shown to purchase recorders only). */
export const purchaseReturnRowSchema = z.object({
  id: z.number().int(),
  doc_no: z.string(),
  purchase_id: z.number().int(),
  purchase_doc_no: z.string(),
  supplier_name: z.string(),
  date: z.string(),
  reason: z.string(),
  total_qty: z.number().int(),
  total_cost_paisa: z.number().int().optional(),
  status: z.enum(['posted', 'void']),
  created_by_name: z.string().nullable(),
});
export type PurchaseReturnRow = z.infer<typeof purchaseReturnRowSchema>;
