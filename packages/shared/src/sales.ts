import { z } from 'zod';
import { CUSTOMER_STATUSES, CUSTOMER_TYPES } from './customers';
import { ALLOCATION_SOURCES } from './payments';
import { bpSchema, businessDateSchema, changeReasonSchema, listQuerySchema, nonNegativePaisaSchema, optionalText } from './common';

// --- Input -----------------------------------------------------------------------

/**
 * A sale line. There is no price field on purpose: the price is always the
 * product's current price (CLAUDE.md 8.10); only the discount % changes.
 */
export const saleLineInputSchema = z
  .object({
    variant_id: z.number().int().positive(),
    qty: z.number().int().min(1, 'Quantity must be at least 1').max(1_000_000),
    discount_bp: bpSchema,
  })
  .strict();
export type SaleLineInput = z.infer<typeof saleLineInputSchema>;

/**
 * Owner approval for a discount above the maximum, below minimum profit,
 * below cost, short stock or credit to a bad-debt customer. An owner or the
 * superuser approves their own sale with `{ confirmed: true }`; an operator
 * needs an owner's (or the superuser's) username and password.
 */
export const approvalSchema = z
  .object({
    confirmed: z.boolean().optional(),
    username: z.string().trim().max(60).optional(),
    password: z.string().max(200).optional(),
  })
  .strict();
export type ApprovalInput = z.infer<typeof approvalSchema>;

const saleFields = {
  customer_id: z.number().int().positive(),
  date: businessDateSchema,
  /** Copied from the customer when left out. */
  payment_terms_days: z.number().int().min(0).max(365).optional(),
  notes: optionalText(1000),
  lines: z.array(saleLineInputSchema).min(1, 'Add at least one item').max(500),
  /** Optional extra discount on the whole invoice, in paisa. */
  extra_discount_paisa: nonNegativePaisaSchema.default(0),
  /** Cash taken at the counter now; posted as a receipt against this invoice. */
  cash_received_paisa: nonNegativePaisaSchema.default(0),
  /**
   * The total the screen showed. If a product price changed meanwhile, the
   * server refuses instead of saving a different total.
   */
  expected_total_paisa: z.number().int().optional(),
};

export const createSaleSchema = z
  .object({
    ...saleFields,
    approval: approvalSchema.optional(),
  })
  .strict();
export type CreateSaleInput = z.input<typeof createSaleSchema>;

/** Live check of a draft sale (amounts, warnings and, for owner+, profit). */
export const saleCheckSchema = z
  .object({
    ...saleFields,
    customer_id: saleFields.customer_id.optional(),
    lines: z.array(saleLineInputSchema).max(500),
  })
  .strict();
export type SaleCheckInput = z.input<typeof saleCheckSchema>;

export const saleListQuerySchema = listQuerySchema.extend({
  from: businessDateSchema.optional(),
  to: businessDateSchema.optional(),
  customer_id: z.coerce.number().int().positive().optional(),
  status: z.enum(['posted', 'void', 'all']).default('all'),
});
export type SaleListQuery = z.input<typeof saleListQuerySchema>;

export const PAPER_SIZES = ['A4', '80mm'] as const;
export const salePdfQuerySchema = z.object({ size: z.enum(PAPER_SIZES).optional() });

// --- Warnings and approvals -----------------------------------------------------------

/**
 * What the safety rules found. Operators only ever get the generic
 * `discount_needs_approval` / `discount_warning` kinds for pricing problems,
 * so nothing hints at cost or supplier margin.
 */
export const SALE_ISSUE_KINDS = [
  // owner+ only (detailed)
  'discount_above_max',
  'below_min_profit',
  'below_cost',
  // everyone (operators get these instead of the three above)
  'discount_needs_approval',
  'discount_warning',
  // everyone
  'overdue',
  'stock_short',
  'bad_debt_credit',
  'credit_limit',
] as const;
export type SaleIssueKind = (typeof SALE_ISSUE_KINDS)[number];

export const saleIssueSchema = z.object({
  kind: z.enum(SALE_ISSUE_KINDS),
  /** 'approval' blocks saving until an owner approves; 'warning' does not. */
  severity: z.enum(['warning', 'approval']),
  /** Index into the request's lines, or null for the whole sale. */
  line_index: z.number().int().nullable(),
  message: z.string(),
});
export type SaleIssue = z.infer<typeof saleIssueSchema>;

/** Body of a 409 APPROVAL_REQUIRED response. */
export interface ApprovalRequiredDetails {
  issues: SaleIssue[];
}

// --- Output ----------------------------------------------------------------------------

/** Per-line figures computed for a draft or saved sale. Cost and profit are owner+ only. */
const lineFigures = {
  list_price_paisa: z.number().int(),
  default_discount_bp: z.number().int(),
  discount_bp: z.number().int(),
  discount_overridden: z.boolean(),
  line_gross_paisa: z.number().int(),
  line_discount_paisa: z.number().int(),
  line_amount_paisa: z.number().int(),
  line_net_paisa: z.number().int(),
  unit_cost_paisa: z.number().int().optional(),
  cost_source: z.enum(['purchase_avg', 'estimated']).optional(),
  line_cost_paisa: z.number().int().optional(),
  profit_paisa: z.number().int().optional(),
};

export const saleCheckLineSchema = z.object({ variant_id: z.number().int(), qty: z.number().int(), ...lineFigures });
export type SaleCheckLine = z.infer<typeof saleCheckLineSchema>;

export const saleTotalsSchema = z.object({
  gross_paisa: z.number().int(),
  line_discount_paisa: z.number().int(),
  extra_discount_paisa: z.number().int(),
  tax_paisa: z.number().int(),
  total_paisa: z.number().int(),
  /** Owner+ only. */
  profit_paisa: z.number().int().optional(),
  profit_bp: z.number().int().optional(),
});
export type SaleTotals = z.infer<typeof saleTotalsSchema>;

export const saleCheckResultSchema = z.object({
  lines: z.array(saleCheckLineSchema),
  totals: saleTotalsSchema,
  due_date: z.string().nullable(),
  issues: z.array(saleIssueSchema),
  needs_approval: z.boolean(),
});
export type SaleCheckResult = z.infer<typeof saleCheckResultSchema>;

export const saleLineSchema = z.object({
  id: z.number().int(),
  line_no: z.number().int(),
  /** Already returned on posted sales returns. */
  returned_qty: z.number().int(),
  variant_id: z.number().int(),
  product_id: z.number().int(),
  item_code: z.string(),
  name: z.string(),
  color: z.string(),
  size: z.string(),
  unit: z.string(),
  qty: z.number().int(),
  ...lineFigures,
});
export type SaleLine = z.infer<typeof saleLineSchema>;

/** What has reduced this invoice: receipts, credit notes and write-offs. */
export const saleAllocationSchema = z.object({
  source_type: z.enum(ALLOCATION_SOURCES),
  source_id: z.number().int(),
  doc_no: z.string().nullable(),
  date: z.string().nullable(),
  method: z.string().nullable(),
  amount_paisa: z.number().int(),
  is_manual: z.boolean(),
});
export type SaleAllocation = z.infer<typeof saleAllocationSchema>;

export const saleSchema = z.object({
  id: z.number().int(),
  doc_no: z.string(),
  customer_id: z.number().int(),
  customer_code: z.string(),
  customer_name: z.string(),
  customer_business_name: z.string().nullable(),
  customer_type: z.enum(CUSTOMER_TYPES),
  customer_status: z.enum(CUSTOMER_STATUSES),
  customer_phone: z.string().nullable(),
  customer_city: z.string().nullable(),
  customer_address: z.string().nullable(),
  date: z.string(),
  payment_terms_days: z.number().int(),
  due_date: z.string(),
  gross_paisa: z.number().int(),
  line_discount_paisa: z.number().int(),
  extra_discount_paisa: z.number().int(),
  tax_paisa: z.number().int(),
  total_paisa: z.number().int(),
  /** Σ allocations to this invoice (receipts, credit notes, write-offs). */
  paid_paisa: z.number().int(),
  outstanding_paisa: z.number().int(),
  /** Days past the due date when overdue (after grace days); null otherwise. */
  days_overdue: z.number().int().nullable(),
  /** Σ line profit. Owner+ only. */
  profit_paisa: z.number().int().optional(),
  /** Profit taken back by posted returns of this invoice. Owner+ only. */
  returned_profit_paisa: z.number().int().optional(),
  status: z.enum(['posted', 'void']),
  version: z.number().int(),
  notes: z.string().nullable(),
  approved_by_name: z.string().nullable(),
  created_at: z.string(),
  created_by_id: z.number().int().nullable(),
  created_by_name: z.string().nullable(),
  item_count: z.number().int(),
  total_qty: z.number().int(),
  lines: z.array(saleLineSchema).optional(),
  allocations: z.array(saleAllocationSchema).optional(),
  returns: z
    .array(z.object({ id: z.number().int(), doc_no: z.string(), date: z.string(), reason: z.string(), total_paisa: z.number().int(), status: z.enum(['posted', 'void']) }))
    .optional(),
});
export type Sale = z.infer<typeof saleSchema>;

/**
 * Editing a posted invoice (CLAUDE.md 8.6). Cash taken at the counter is its
 * own receipt and is edited there, so it is not part of this.
 */
export const updateSaleSchema = z
  .object({
    customer_id: saleFields.customer_id,
    date: saleFields.date,
    payment_terms_days: saleFields.payment_terms_days,
    notes: saleFields.notes,
    lines: saleFields.lines,
    extra_discount_paisa: saleFields.extra_discount_paisa,
    expected_total_paisa: saleFields.expected_total_paisa,
    change_reason: changeReasonSchema,
    approval: approvalSchema.optional(),
  })
  .strict();
export type UpdateSaleInput = z.input<typeof updateSaleSchema>;

/** Live check while editing: like saleCheckSchema, against the invoice being edited. */
export const saleEditCheckSchema = saleCheckSchema;
