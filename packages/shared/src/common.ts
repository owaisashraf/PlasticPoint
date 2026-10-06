import { z } from 'zod';
import { normalizePhone } from './phone';

/** Business date 'YYYY-MM-DD'. */
export const businessDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-10-05')
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s), 'Not a real date');

export const paisaSchema = z.number().int('Amounts must be whole paisa');
export const nonNegativePaisaSchema = paisaSchema.min(0, 'Cannot be negative');
export const bpSchema = z.number().int().min(0).max(10_000);

/** Optional text: trims, and turns "" into null. */
export const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));

/** Optional phone: accepts any common Pakistani format, stores E.164, "" -> null. */
export const optionalPhoneSchema = z
  .string()
  .trim()
  .nullish()
  .transform((v, ctx) => {
    if (!v) return null;
    const e164 = normalizePhone(v);
    if (!e164) {
      ctx.addIssue({ code: 'custom', message: 'Not a valid phone number, e.g. 0300 1234567' });
      return z.NEVER;
    }
    return e164;
  });

export const listQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export const reasonSchema = z.string().trim().min(3, 'Enter a reason').max(300);

/** Why a document was edited (recorded in the change history). */
export const changeReasonSchema = z.string().trim().min(3, 'Enter the reason for the change').max(300);

/** Voiding any document: a reason is required. */
export const voidSchema = z.object({ reason: reasonSchema }).strict();
export type VoidInput = z.input<typeof voidSchema>;
