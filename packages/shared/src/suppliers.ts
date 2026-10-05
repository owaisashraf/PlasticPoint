import { z } from 'zod';
import { businessDateSchema, optionalPhoneSchema, optionalText, paisaSchema } from './common';

const supplierFields = {
  name: z.string().trim().min(1, 'Enter the supplier name').max(120),
  phone: optionalPhoneSchema,
  address: optionalText(300),
  ntn: optionalText(40),
  notes: optionalText(2000),
  /** Positive: we owe the supplier. Negative: an advance paid to them. */
  opening_balance_paisa: paisaSchema.default(0),
  opening_balance_date: businessDateSchema.optional(),
};

export const createSupplierSchema = z.object(supplierFields);
export type CreateSupplierInput = z.input<typeof createSupplierSchema>;

export const updateSupplierSchema = z
  .object({
    name: supplierFields.name.optional(),
    phone: supplierFields.phone.optional(),
    address: supplierFields.address.optional(),
    ntn: supplierFields.ntn.optional(),
    notes: supplierFields.notes.optional(),
    opening_balance_paisa: paisaSchema.optional(),
    opening_balance_date: businessDateSchema.optional(),
    active: z.boolean().optional(),
    reason: optionalText(300),
  })
  .strict();
export type UpdateSupplierInput = z.input<typeof updateSupplierSchema>;

export const supplierSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  phone: z.string().nullable(),
  address: z.string().nullable(),
  ntn: z.string().nullable(),
  notes: z.string().nullable(),
  active: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
  /** Σ credit − Σ debit. Positive: we owe them. */
  balance_paisa: z.number().int(),
  opening_balance_paisa: z.number().int(),
  opening_balance_date: z.string().nullable(),
});
export type Supplier = z.infer<typeof supplierSchema>;
