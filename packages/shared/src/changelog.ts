import { z } from 'zod';
import { boolQueryParamSchema, businessDateSchema } from './common';
import { ROLES } from './permissions';

/**
 * Change History (CLAUDE.md 10.6), superuser only. Built from the audit log;
 * review marks live apart in audit_reviews so the log itself never changes.
 */

export const CHANGELOG_TABS = ['invoices', 'documents', 'other'] as const;
export type ChangelogTab = (typeof CHANGELOG_TABS)[number];

/** Entities on the "All documents" tab (sales have their own tab). */
export const DOCUMENT_ENTITIES = ['purchase', 'purchase_return', 'sales_return', 'payment', 'write_off', 'expense', 'asset'] as const;

/** Every automatic flag (CLAUDE.md 8.14). `by_operator` alone does not make a change "flagged". */
export const AUDIT_FLAGS = [
  'edited_after_shared',
  'edited_after_printed',
  'edited_later_day',
  'total_reduced',
  'total_increased',
  'customer_changed',
  'discount_above_default',
  'profit_below_minimum',
  'sold_below_cost',
  'extra_discount_added',
  'price_changed',
  'voided',
  'by_operator',
] as const;
export type AuditFlag = (typeof AUDIT_FLAGS)[number];

export const changelogQuerySchema = z.object({
  tab: z.enum(CHANGELOG_TABS).default('invoices'),
  from: businessDateSchema.optional(),
  to: businessDateSchema.optional(),
  user_id: z.coerce.number().int().positive().optional(),
  role: z.enum(ROLES).optional(),
  action: z.string().trim().max(40).optional(),
  entity: z.string().trim().max(40).optional(),
  customer_id: z.coerce.number().int().positive().optional(),
  flag: z.enum(AUDIT_FLAGS).optional(),
  flagged_only: boolQueryParamSchema,
  unreviewed: boolQueryParamSchema,
  q: z.string().trim().max(60).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ChangelogQuery = z.input<typeof changelogQuerySchema>;

export const changeReviewSchema = z.object({
  reviewed_by_name: z.string().nullable(),
  reviewed_at: z.string(),
  note: z.string().nullable(),
});

export const changeRowSchema = z.object({
  id: z.number().int(),
  at: z.string(),
  user_id: z.number().int().nullable(),
  user_name: z.string().nullable(),
  user_role: z.string().nullable(),
  action: z.string(),
  entity: z.string(),
  entity_id: z.number().int().nullable(),
  doc_no: z.string().nullable(),
  /** Customer or supplier of a document. */
  party_name: z.string().nullable(),
  version_before: z.number().int().nullable(),
  version_after: z.number().int().nullable(),
  total_before_paisa: z.number().int().nullable(),
  total_after_paisa: z.number().int().nullable(),
  /** Change to what the customer owes us (or we owe the supplier). */
  balance_impact_paisa: z.number().int().nullable(),
  reason: z.string().nullable(),
  flags: z.array(z.string()),
  review: changeReviewSchema.nullable(),
});
export type ChangeRow = z.infer<typeof changeRowSchema>;

export const lineDiffSchema = z.object({
  added: z.array(z.record(z.string(), z.unknown())),
  removed: z.array(z.record(z.string(), z.unknown())),
  changed: z.array(z.object({ key: z.string(), label: z.string(), fields: z.record(z.string(), z.tuple([z.unknown(), z.unknown()])) })),
});

export const changeDetailSchema = changeRowSchema.extend({
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()).nullable(),
  summary: z.record(z.string(), z.unknown()).nullable(),
  diff: z.object({ fields: z.record(z.string(), z.tuple([z.unknown(), z.unknown()])), lines: lineDiffSchema }),
  /** Whether a PDF of the before/after version can be re-created (sales). */
  can_pdf: z.boolean(),
});
export type ChangeDetail = z.infer<typeof changeDetailSchema>;

export const changeReviewInputSchema = z.object({ note: z.string().trim().max(500).nullish() }).strict();

export const timelineQuerySchema = z.object({ entity: z.string().trim().min(1).max(40), entity_id: z.coerce.number().int().positive() });

export const discountOverrideQuerySchema = z.object({ from: businessDateSchema.optional(), to: businessDateSchema.optional() });

export const discountOverrideRowSchema = z.object({
  sale_id: z.number().int(),
  doc_no: z.string(),
  date: z.string(),
  user_id: z.number().int().nullable(),
  user_name: z.string().nullable(),
  customer_name: z.string(),
  product_id: z.number().int(),
  item_code: z.string(),
  name: z.string(),
  color: z.string(),
  size: z.string(),
  qty: z.number().int(),
  default_discount_bp: z.number().int(),
  discount_bp: z.number().int(),
  line_net_paisa: z.number().int(),
  profit_paisa: z.number().int(),
  /** discount_changed / below_min_profit / below_cost */
  reasons: z.array(z.string()),
});
export type DiscountOverrideRow = z.infer<typeof discountOverrideRowSchema>;
