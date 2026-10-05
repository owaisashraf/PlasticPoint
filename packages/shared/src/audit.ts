import { z } from 'zod';

export const auditVerifyResultSchema = z.object({
  ok: z.boolean(),
  rows_checked: z.number().int(),
  last_id: z.number().int().nullable(),
  last_hash: z.string().nullable(),
  problems: z.array(z.string()),
});
export type AuditVerifyResult = z.infer<typeof auditVerifyResultSchema>;
