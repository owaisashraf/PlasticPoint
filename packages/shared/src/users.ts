import { z } from 'zod';
import { ROLES } from './permissions';

export const MIN_PASSWORD_LENGTH = 8;

export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, 'Username must be at least 3 characters')
  .max(32, 'Username must be at most 32 characters')
  .regex(/^[a-z0-9._-]+$/, 'Use only letters, numbers, dot, dash or underscore');

export const passwordSchema = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`)
  .max(128, 'Password is too long');

export const displayNameSchema = z.string().trim().min(1, 'Enter a name').max(80);

export const roleSchema = z.enum(ROLES);

export const publicUserSchema = z.object({
  id: z.number().int(),
  username: z.string(),
  display_name: z.string(),
  role: roleSchema,
  active: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type PublicUser = z.infer<typeof publicUserSchema>;

// --- Setup -----------------------------------------------------------------

export const setupStatusSchema = z.object({
  needs: z.enum(['superuser', 'owner']).nullable(),
});
export type SetupStatus = z.infer<typeof setupStatusSchema>;

export const setupAccountSchema = z.object({
  username: usernameSchema,
  display_name: displayNameSchema,
  password: passwordSchema,
});
export type SetupAccountInput = z.infer<typeof setupAccountSchema>;

// --- Auth ------------------------------------------------------------------

export const loginSchema = z.object({
  username: z.string().trim().toLowerCase().min(1, 'Enter your username'),
  password: z.string().min(1, 'Enter your password'),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const meSchema = z.object({
  user: publicUserSchema,
  permissions: z.array(z.string()),
});
export type Me = z.infer<typeof meSchema>;

export const changeOwnPasswordSchema = z.object({
  current_password: z.string().min(1, 'Enter your current password'),
  new_password: passwordSchema,
});
export type ChangeOwnPasswordInput = z.infer<typeof changeOwnPasswordSchema>;

// --- User management -------------------------------------------------------

/** Roles that can be given through user management. Never 'superuser'. */
export const assignableRoleSchema = z.enum(['owner', 'operator']);

export const createUserSchema = z.object({
  username: usernameSchema,
  display_name: displayNameSchema,
  role: assignableRoleSchema,
  password: passwordSchema,
});
export type CreateUserInput = z.infer<typeof createUserSchema>;

export const updateUserSchema = z
  .object({
    display_name: displayNameSchema.optional(),
    role: assignableRoleSchema.optional(),
    active: z.boolean().optional(),
    reason: z.string().trim().max(300).optional(),
  })
  .refine((v) => v.display_name !== undefined || v.role !== undefined || v.active !== undefined, {
    message: 'Nothing to change',
  });
export type UpdateUserInput = z.infer<typeof updateUserSchema>;

export const resetPasswordSchema = z.object({
  password: passwordSchema,
});
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

export const idParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});
