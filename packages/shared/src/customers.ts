import { z } from 'zod';
import { businessDateSchema, listQuerySchema, nonNegativePaisaSchema, optionalPhoneSchema, optionalText, paisaSchema, reasonSchema } from './common';

export const CUSTOMER_TYPES = ['wholesaler', 'retailer'] as const;
export type CustomerType = (typeof CUSTOMER_TYPES)[number];

export const CUSTOMER_STATUSES = ['active', 'inactive', 'bad_debt'] as const;
export type CustomerStatus = (typeof CUSTOMER_STATUSES)[number];

const customerFields = {
  name: z.string().trim().min(1, 'Enter the customer name').max(120),
  business_name: optionalText(120),
  type: z.enum(CUSTOMER_TYPES),
  phone: optionalPhoneSchema,
  alt_phone: optionalPhoneSchema,
  city: optionalText(60),
  area: optionalText(80),
  address: optionalText(300),
  ntn: optionalText(40),
  credit_limit_paisa: nonNegativePaisaSchema.default(0),
  payment_terms_days: z.number().int().min(0).max(365).optional(),
  notes: optionalText(2000),
};

export const createCustomerSchema = z.object({
  ...customerFields,
  /** Positive: the customer owes us. Negative: an advance we hold. */
  opening_balance_paisa: paisaSchema.default(0),
  opening_balance_date: businessDateSchema.optional(),
});
export type CreateCustomerInput = z.input<typeof createCustomerSchema>;

export const updateCustomerSchema = z
  .object({
    name: customerFields.name.optional(),
    business_name: customerFields.business_name.optional(),
    type: customerFields.type.optional(),
    phone: customerFields.phone.optional(),
    alt_phone: customerFields.alt_phone.optional(),
    city: customerFields.city.optional(),
    area: customerFields.area.optional(),
    address: customerFields.address.optional(),
    ntn: customerFields.ntn.optional(),
    credit_limit_paisa: nonNegativePaisaSchema.optional(),
    payment_terms_days: customerFields.payment_terms_days,
    notes: customerFields.notes.optional(),
    opening_balance_paisa: paisaSchema.optional(),
    opening_balance_date: businessDateSchema.optional(),
    /** Activate or deactivate (bad debt has its own endpoint). */
    active: z.boolean().optional(),
    reason: optionalText(300),
  })
  .strict();
export type UpdateCustomerInput = z.input<typeof updateCustomerSchema>;

export const badDebtSchema = z.object({ reason: reasonSchema });

export const customerListQuerySchema = listQuerySchema.extend({
  type: z.enum(CUSTOMER_TYPES).optional(),
  city: z.string().trim().max(60).optional(),
  status: z.enum([...CUSTOMER_STATUSES, 'all']).default('all'),
});
export type CustomerListQuery = z.input<typeof customerListQuerySchema>;

export const customerSchema = z.object({
  id: z.number().int(),
  code: z.string(),
  name: z.string(),
  business_name: z.string().nullable(),
  type: z.enum(CUSTOMER_TYPES),
  phone: z.string().nullable(),
  alt_phone: z.string().nullable(),
  city: z.string().nullable(),
  area: z.string().nullable(),
  address: z.string().nullable(),
  ntn: z.string().nullable(),
  credit_limit_paisa: z.number().int(),
  payment_terms_days: z.number().int(),
  status: z.enum(CUSTOMER_STATUSES),
  bad_debt_marked_at: z.string().nullable(),
  bad_debt_reason: z.string().nullable(),
  notes: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  /** Σ debit − Σ credit. Positive: they owe us; negative: advance. */
  balance_paisa: z.number().int(),
  opening_balance_paisa: z.number().int(),
  opening_balance_date: z.string().nullable(),
});
export type Customer = z.infer<typeof customerSchema>;
