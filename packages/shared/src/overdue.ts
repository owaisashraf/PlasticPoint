import { z } from 'zod';
import { CUSTOMER_STATUSES, CUSTOMER_TYPES } from './customers';

/** Filters for the Overdue tab (CLAUDE.md 10.3). Bad-debt customers have their own sub-tab. */
export const overdueQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  type: z.enum(CUSTOMER_TYPES).optional(),
  city: z.string().trim().max(60).optional(),
  min_days: z.coerce.number().int().min(0).max(10_000).optional(),
  bad_debt: z.enum(['exclude', 'include', 'only']).default('exclude'),
});
export type OverdueQuery = z.input<typeof overdueQuerySchema>;

export const overdueInvoiceSchema = z.object({
  /** Null: the opening balance. */
  sale_id: z.number().int().nullable(),
  doc_no: z.string().nullable(),
  date: z.string(),
  due_date: z.string(),
  total_paisa: z.number().int(),
  paid_paisa: z.number().int(),
  outstanding_paisa: z.number().int(),
  days_overdue: z.number().int(),
});
export type OverdueInvoice = z.infer<typeof overdueInvoiceSchema>;

export const overdueRowSchema = z.object({
  customer_id: z.number().int(),
  code: z.string(),
  name: z.string(),
  business_name: z.string().nullable(),
  phone: z.string().nullable(),
  city: z.string().nullable(),
  type: z.enum(CUSTOMER_TYPES),
  status: z.enum(CUSTOMER_STATUSES),
  payment_terms_days: z.number().int(),
  overdue_count: z.number().int(),
  overdue_paisa: z.number().int(),
  /** Customer balance (Σ debit − Σ credit). */
  balance_paisa: z.number().int(),
  oldest_due_date: z.string(),
  max_days_overdue: z.number().int(),
  last_payment_date: z.string().nullable(),
  last_payment_paisa: z.number().int().nullable(),
  invoices: z.array(overdueInvoiceSchema),
});
export type OverdueRow = z.infer<typeof overdueRowSchema>;

export const overdueListSchema = z.object({
  rows: z.array(overdueRowSchema),
  totals: z.object({ customers: z.number().int(), overdue_paisa: z.number().int(), balance_paisa: z.number().int() }),
  /** Business date the list was worked out for. */
  as_of: z.string(),
});
export type OverdueList = z.infer<typeof overdueListSchema>;

/** Overdue colour band from the largest days overdue and the settings thresholds. */
export type OverdueBand = 'amber' | 'orange' | 'red';
export function overdueBand(days: number, s: { overdue_amber_max_days: number; overdue_orange_max_days: number }): OverdueBand {
  if (days <= s.overdue_amber_max_days) return 'amber';
  if (days <= s.overdue_orange_max_days) return 'orange';
  return 'red';
}
