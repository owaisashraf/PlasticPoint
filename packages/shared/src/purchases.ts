import { z } from 'zod';
import { bpSchema, businessDateSchema, changeReasonSchema, listQuerySchema, optionalText, reasonSchema } from './common';

export const purchaseLineInputSchema = z.object({
  variant_id: z.number().int().positive(),
  qty: z.number().int().min(1, 'Quantity must be at least 1').max(1_000_000),
  /** Price on the manufacturer's bill (may differ from the product price). */
  list_price_paisa: z.number().int().min(1, 'Enter a price'),
  supplier_margin_bp: bpSchema,
});
export type PurchaseLineInput = z.infer<typeof purchaseLineInputSchema>;

/** Owner+ only: update products whose bill price or margin differed. */
export const productPriceUpdateSchema = z.object({
  product_id: z.number().int().positive(),
  list_price_paisa: z.number().int().min(1).optional(),
  supplier_margin_bp: bpSchema.optional(),
});

export const createPurchaseSchema = z.object({
  supplier_id: z.number().int().positive(),
  date: businessDateSchema,
  supplier_ref: optionalText(60),
  notes: optionalText(1000),
  lines: z.array(purchaseLineInputSchema).min(1, 'Add at least one item').max(500),
  update_products: z.array(productPriceUpdateSchema).max(500).default([]),
});
export type CreatePurchaseInput = z.input<typeof createPurchaseSchema>;

export const purchaseListQuerySchema = listQuerySchema.extend({
  from: businessDateSchema.optional(),
  to: businessDateSchema.optional(),
});

export const purchaseLineSchema = z.object({
  id: z.number().int(),
  line_no: z.number().int(),
  variant_id: z.number().int(),
  product_id: z.number().int(),
  item_code: z.string(),
  name: z.string(),
  color: z.string(),
  size: z.string(),
  unit: z.string(),
  qty: z.number().int(),
  returned_qty: z.number().int(),
  list_price_paisa: z.number().int(),
  supplier_margin_bp: z.number().int().optional(),
  line_gross_paisa: z.number().int(),
  line_margin_paisa: z.number().int().optional(),
  line_cost_paisa: z.number().int().optional(),
  unit_cost_paisa: z.number().int().optional(),
});
export type PurchaseLine = z.infer<typeof purchaseLineSchema>;

export const purchaseReturnSummarySchema = z.object({
  id: z.number().int(),
  doc_no: z.string(),
  date: z.string(),
  reason: z.string(),
  total_cost_paisa: z.number().int().optional(),
  status: z.enum(['posted', 'void']),
});

export const purchaseSchema = z.object({
  id: z.number().int(),
  doc_no: z.string(),
  supplier_id: z.number().int(),
  supplier_name: z.string(),
  date: z.string(),
  supplier_ref: z.string().nullable(),
  notes: z.string().nullable(),
  gross_paisa: z.number().int(),
  margin_paisa: z.number().int().optional(),
  total_cost_paisa: z.number().int().optional(),
  status: z.enum(['posted', 'void']),
  version: z.number().int(),
  created_at: z.string(),
  created_by_id: z.number().int().nullable(),
  created_by_name: z.string().nullable(),
  item_count: z.number().int(),
  total_qty: z.number().int(),
  lines: z.array(purchaseLineSchema).optional(),
  returns: z.array(purchaseReturnSummarySchema).optional(),
});
export type Purchase = z.infer<typeof purchaseSchema>;

// --- Purchase returns -------------------------------------------------------------

export const createPurchaseReturnSchema = z.object({
  date: businessDateSchema,
  reason: reasonSchema,
  lines: z
    .array(z.object({ purchase_item_id: z.number().int().positive(), qty: z.number().int().min(1).max(1_000_000) }))
    .min(1, 'Pick at least one item to return')
    .max(500),
});
export type CreatePurchaseReturnInput = z.input<typeof createPurchaseReturnSchema>;

export const purchaseReturnSchema = z.object({
  id: z.number().int(),
  doc_no: z.string(),
  purchase_id: z.number().int(),
  purchase_doc_no: z.string(),
  supplier_name: z.string(),
  date: z.string(),
  reason: z.string(),
  total_cost_paisa: z.number().int().optional(),
  status: z.enum(['posted', 'void']),
  version: z.number().int(),
  created_at: z.string(),
  created_by_id: z.number().int().nullable(),
  created_by_name: z.string().nullable(),
  lines: z.array(
    z.object({
      id: z.number().int(),
      purchase_item_id: z.number().int(),
      item_code: z.string(),
      name: z.string(),
      color: z.string(),
      size: z.string(),
      qty: z.number().int(),
      unit_cost_paisa: z.number().int().optional(),
      line_cost_paisa: z.number().int().optional(),
    }),
  ),
});
export type PurchaseReturn = z.infer<typeof purchaseReturnSchema>;

// --- Stock ------------------------------------------------------------------------

export const stockMovementSchema = z.object({
  id: z.number().int(),
  date: z.string(),
  qty_change: z.number().int(),
  balance_qty: z.number().int(),
  source_type: z.string(),
  source_id: z.number().int(),
  doc_no: z.string().nullable(),
  unit_cost_paisa: z.number().int().nullable().optional(),
});
export type StockMovement = z.infer<typeof stockMovementSchema>;

export const lowStockRowSchema = z.object({
  variant_id: z.number().int(),
  product_id: z.number().int(),
  item_code: z.string(),
  name: z.string(),
  category: z.string().nullable(),
  color: z.string(),
  size: z.string(),
  sku: z.string(),
  unit: z.string(),
  stock_qty: z.number().int(),
  low_stock_threshold: z.number().int(),
});
export type LowStockRow = z.infer<typeof lowStockRowSchema>;

export const stockValuationRowSchema = z.object({
  product_id: z.number().int(),
  item_code: z.string(),
  name: z.string(),
  category: z.string().nullable(),
  stock_qty: z.number().int(),
  stock_value_paisa: z.number().int(),
});
export type StockValuationRow = z.infer<typeof stockValuationRowSchema>;

export const updatePurchaseSchema = z
  .object({
    supplier_id: z.number().int().positive(),
    date: businessDateSchema,
    supplier_ref: optionalText(60),
    notes: optionalText(1000),
    lines: createPurchaseSchema.shape.lines,
    change_reason: changeReasonSchema,
  })
  .strict();
export type UpdatePurchaseInput = z.input<typeof updatePurchaseSchema>;

export const updatePurchaseReturnSchema = createPurchaseReturnSchema.extend({ change_reason: changeReasonSchema }).strict();
export type UpdatePurchaseReturnInput = z.input<typeof updatePurchaseReturnSchema>;
