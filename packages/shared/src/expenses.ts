import { z } from 'zod';
import { businessDateSchema, changeReasonSchema, listQuerySchema, nonNegativePaisaSchema, optionalText, reasonSchema } from './common';

// --- Expense categories (managed in Settings) -------------------------------------

export const expenseCategorySchema = z.object({
  id: z.number().int(),
  name: z.string(),
  active: z.boolean(),
  /** Posted expenses in this category (a used category can only be deactivated). */
  expense_count: z.number().int(),
});
export type ExpenseCategory = z.infer<typeof expenseCategorySchema>;

export const createExpenseCategorySchema = z.object({ name: z.string().trim().min(2, 'Enter a name').max(60) }).strict();
export const updateExpenseCategorySchema = z
  .object({ name: z.string().trim().min(2, 'Enter a name').max(60).optional(), active: z.boolean().optional() })
  .strict();

// --- Expenses (CLAUDE.md 8.12) ------------------------------------------------------

export const EXPENSE_METHODS = ['cash', 'bank'] as const;

const expenseFields = {
  date: businessDateSchema,
  category_id: z.number().int().positive({ message: 'Pick a category' }),
  amount_paisa: z.number().int('Amounts must be whole paisa').min(1, 'Enter an amount above zero'),
  method: z.enum(EXPENSE_METHODS),
  paid_to: optionalText(120),
  reference: optionalText(80),
  notes: optionalText(500),
};

export const createExpenseSchema = z.object(expenseFields).strict();
export type CreateExpenseInput = z.input<typeof createExpenseSchema>;

export const updateExpenseSchema = z.object({ ...expenseFields, change_reason: changeReasonSchema }).strict();
export type UpdateExpenseInput = z.input<typeof updateExpenseSchema>;

export const expenseListQuerySchema = listQuerySchema.extend({
  from: businessDateSchema.optional(),
  to: businessDateSchema.optional(),
  category_id: z.coerce.number().int().positive().optional(),
  method: z.enum(EXPENSE_METHODS).optional(),
  status: z.enum(['posted', 'void', 'all']).default('all'),
});
export type ExpenseListQuery = z.input<typeof expenseListQuerySchema>;

export const expenseSchema = z.object({
  id: z.number().int(),
  doc_no: z.string(),
  date: z.string(),
  category_id: z.number().int(),
  category_name: z.string(),
  amount_paisa: z.number().int(),
  method: z.enum(EXPENSE_METHODS),
  paid_to: z.string().nullable(),
  reference: z.string().nullable(),
  notes: z.string().nullable(),
  status: z.enum(['posted', 'void']),
  version: z.number().int(),
  created_at: z.string(),
  created_by_id: z.number().int().nullable(),
  created_by_name: z.string().nullable(),
});
export type Expense = z.infer<typeof expenseSchema>;

/** The list with totals of the posted expenses that match the filters. */
export const expenseListSchema = z.object({
  expenses: z.array(expenseSchema),
  total: z.number().int(),
  total_paisa: z.number().int(),
  by_category: z.array(z.object({ category_id: z.number().int(), name: z.string(), total_paisa: z.number().int(), count: z.number().int() })),
  /** 'YYYY-MM' */
  by_month: z.array(z.object({ month: z.string(), total_paisa: z.number().int(), count: z.number().int() })),
});
export type ExpenseList = z.infer<typeof expenseListSchema>;

// --- Assets (CLAUDE.md 8.13) ----------------------------------------------------------

export const ASSET_CATEGORIES = ['furniture', 'equipment', 'computer', 'vehicle', 'other'] as const;
export type AssetCategory = (typeof ASSET_CATEGORIES)[number];

const assetFields = {
  name: z.string().trim().min(1, 'Enter a name').max(120),
  category: z.enum(ASSET_CATEGORIES),
  purchase_date: businessDateSchema,
  cost_paisa: z.number().int('Amounts must be whole paisa').min(1, 'Enter the cost'),
  method: z.enum(EXPENSE_METHODS),
  vendor: optionalText(120),
  depreciation_method: z.enum(['none', 'straight_line']),
  useful_life_months: z.number().int().min(1, 'At least 1 month').max(600).nullish().transform((v) => v ?? null),
  salvage_value_paisa: nonNegativePaisaSchema.default(0),
  notes: optionalText(500),
};

function assetRules(v: { depreciation_method: string; useful_life_months: number | null; salvage_value_paisa: number; cost_paisa: number }, ctx: z.RefinementCtx) {
  if (v.depreciation_method === 'straight_line' && !v.useful_life_months) ctx.addIssue({ code: 'custom', path: ['useful_life_months'], message: 'Enter the useful life in months' });
  if (v.salvage_value_paisa > v.cost_paisa) ctx.addIssue({ code: 'custom', path: ['salvage_value_paisa'], message: 'Salvage value cannot be more than the cost' });
}

export const createAssetSchema = z.object(assetFields).strict().superRefine(assetRules);
export type CreateAssetInput = z.input<typeof createAssetSchema>;

export const updateAssetSchema = z
  .object({ ...assetFields, change_reason: changeReasonSchema })
  .strict()
  .superRefine(assetRules);
export type UpdateAssetInput = z.input<typeof updateAssetSchema>;

export const disposeAssetSchema = z
  .object({
    date: businessDateSchema,
    amount_paisa: nonNegativePaisaSchema,
    method: z.enum(EXPENSE_METHODS),
    reason: reasonSchema,
  })
  .strict();
export type DisposeAssetInput = z.input<typeof disposeAssetSchema>;

export const assetListQuerySchema = z.object({
  status: z.enum(['active', 'disposed', 'void', 'all']).default('all'),
  /** Book values as of this date (default today). */
  as_of: businessDateSchema.optional(),
});

export const depreciationRowSchema = z.object({
  month: z.string(),
  charge_date: z.string(),
  charge_paisa: z.number().int(),
  accumulated_paisa: z.number().int(),
  book_value_paisa: z.number().int(),
});

export const assetSchema = z.object({
  id: z.number().int(),
  doc_no: z.string(),
  name: z.string(),
  category: z.enum(ASSET_CATEGORIES),
  purchase_date: z.string(),
  cost_paisa: z.number().int(),
  method: z.enum(EXPENSE_METHODS),
  vendor: z.string().nullable(),
  depreciation_method: z.enum(['none', 'straight_line']),
  useful_life_months: z.number().int().nullable(),
  salvage_value_paisa: z.number().int(),
  /** Straight-line monthly charge (first months may be 1 paisa more). */
  monthly_depreciation_paisa: z.number().int(),
  disposal_date: z.string().nullable(),
  disposal_amount_paisa: z.number().int().nullable(),
  disposal_method: z.enum(EXPENSE_METHODS).nullable(),
  disposal_reason: z.string().nullable(),
  /** Gain (+) or loss (−) on disposal. */
  disposal_gain_paisa: z.number().int().nullable(),
  status: z.enum(['active', 'disposed', 'void']),
  version: z.number().int(),
  notes: z.string().nullable(),
  /** As of the list's date (or the disposal date, if earlier). */
  as_of: z.string(),
  accumulated_depreciation_paisa: z.number().int(),
  book_value_paisa: z.number().int(),
  created_at: z.string(),
  created_by_id: z.number().int().nullable(),
  created_by_name: z.string().nullable(),
  schedule: z.array(depreciationRowSchema).optional(),
});
export type Asset = z.infer<typeof assetSchema>;
