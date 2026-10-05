import { z } from 'zod';
import { bpSchema, listQuerySchema, optionalText, reasonSchema } from './common';

export const PRODUCT_UNITS = ['pcs', 'dozen', 'set', 'carton'] as const;
export type ProductUnit = (typeof PRODUCT_UNITS)[number];

/** Fields only owner+ (pricing.manage) may set or change, except the initial price. */
export const PRICING_FIELDS = ['list_price_paisa', 'supplier_margin_bp', 'default_customer_discount_bp', 'max_customer_discount_bp'] as const;

/** A list of sizes or colors: trimmed, unique (ignoring case). No default here, so edits can leave it out. */
const optionList = (what: string) =>
  z
    .array(z.string().trim().min(1).max(20, `Each ${what} must be at most 20 characters`))
    .max(40, `At most 40 ${what}s`)
    .transform((list, ctx) => {
      const seen = new Set<string>();
      for (const v of list) {
        const k = v.toLowerCase();
        if (seen.has(k)) {
          ctx.addIssue({ code: 'custom', message: `"${v}" is listed twice` });
          return z.NEVER;
        }
        seen.add(k);
      }
      return list;
    });

const itemCode = z
  .string()
  .trim()
  .toUpperCase()
  .min(1, 'Enter the item code')
  .max(30)
  .regex(/^[A-Z0-9][A-Z0-9._/-]*$/, 'Use letters, numbers, dot, dash or slash');

const pricePaisa = z.number().int('Price must be whole paisa').min(1, 'Enter a price above zero');

export const createProductSchema = z
  .object({
    item_code: itemCode,
    name: z.string().trim().min(1, 'Enter the product name').max(120),
    category: optionalText(60),
    unit: z.enum(PRODUCT_UNITS).default('pcs'),
    sizes: optionList('size').default([]),
    colors: optionList('color').default([]),
    list_price_paisa: pricePaisa,
    supplier_margin_bp: bpSchema.optional(),
    default_customer_discount_bp: bpSchema.optional(),
    max_customer_discount_bp: bpSchema.nullish(),
    low_stock_threshold: z.number().int().min(0).default(0),
  })
  .strict();
export type CreateProductInput = z.input<typeof createProductSchema>;

export const updateProductSchema = z
  .object({
    item_code: itemCode.optional(),
    name: z.string().trim().min(1).max(120).optional(),
    category: optionalText(60).optional(),
    unit: z.enum(PRODUCT_UNITS).optional(),
    sizes: optionList('size').optional(),
    colors: optionList('color').optional(),
    list_price_paisa: pricePaisa.optional(),
    supplier_margin_bp: bpSchema.optional(),
    default_customer_discount_bp: bpSchema.optional(),
    max_customer_discount_bp: bpSchema.nullish(),
    active: z.boolean().optional(),
    reason: optionalText(300),
  })
  .strict();
export type UpdateProductInput = z.input<typeof updateProductSchema>;

export const productListQuerySchema = listQuerySchema.extend({
  category: z.string().trim().max(60).optional(),
  status: z.enum(['active', 'inactive', 'all']).default('active'),
});

export const variantSchema = z.object({
  id: z.number().int(),
  product_id: z.number().int(),
  color: z.string(),
  size: z.string(),
  sku: z.string(),
  active: z.boolean(),
  low_stock_threshold: z.number().int(),
  /** Weighted average actual cost; null until first purchase. Owner+ only. */
  avg_cost_paisa: z.number().int().nullable().optional(),
  stock_qty: z.number().int(),
});
export type Variant = z.infer<typeof variantSchema>;

export const productSchema = z.object({
  id: z.number().int(),
  item_code: z.string(),
  name: z.string(),
  category: z.string().nullable(),
  unit: z.enum(PRODUCT_UNITS),
  sizes: z.array(z.string()),
  colors: z.array(z.string()),
  list_price_paisa: z.number().int(),
  /** Owner+ only (removed for operators). */
  supplier_margin_bp: z.number().int().optional(),
  default_customer_discount_bp: z.number().int(),
  max_customer_discount_bp: z.number().int().nullable(),
  active: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
  stock_qty: z.number().int(),
  variants: z.array(variantSchema).optional(),
});
export type Product = z.infer<typeof productSchema>;

export const priceHistorySchema = z.object({
  id: z.number().int(),
  effective_date: z.string(),
  list_price_paisa: z.number().int(),
  supplier_margin_bp: z.number().int(),
  default_customer_discount_bp: z.number().int(),
  changed_by: z.number().int().nullable(),
  changed_by_name: z.string().nullable(),
  created_at: z.string(),
});
export type PriceHistoryEntry = z.infer<typeof priceHistorySchema>;

// --- Bulk update (owner+) ----------------------------------------------------

export const bulkUpdateSchema = z.object({
  target: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('category'), category: z.string().trim().min(1) }),
    z.object({ kind: z.literal('products'), product_ids: z.array(z.number().int().positive()).min(1).max(5000) }),
  ]),
  change: z.discriminatedUnion('kind', [
    /** Price up or down by a percentage (negative bp lowers it). */
    z.object({ kind: z.literal('price_percent'), bp: z.number().int().min(-9_900).max(100_000) }),
    /** Price up or down by an amount in paisa. */
    z.object({ kind: z.literal('price_amount'), paisa: z.number().int() }),
    z.object({ kind: z.literal('supplier_margin'), bp: bpSchema }),
    z.object({ kind: z.literal('default_discount'), bp: bpSchema }),
  ]),
  reason: reasonSchema,
  /** Only preview the result; change nothing. */
  dry_run: z.boolean().default(false),
});
export type BulkUpdateInput = z.input<typeof bulkUpdateSchema>;

export const bulkUpdateRowSchema = z.object({
  product_id: z.number().int(),
  item_code: z.string(),
  name: z.string(),
  before: z.object({ list_price_paisa: z.number().int(), supplier_margin_bp: z.number().int(), default_customer_discount_bp: z.number().int() }),
  after: z.object({ list_price_paisa: z.number().int(), supplier_margin_bp: z.number().int(), default_customer_discount_bp: z.number().int() }),
});
export type BulkUpdateRow = z.infer<typeof bulkUpdateRowSchema>;
