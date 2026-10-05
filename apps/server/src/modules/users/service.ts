import bcrypt from 'bcryptjs';
import { asc, eq, ne } from 'drizzle-orm';
import {
  can,
  type CreateUserInput,
  type PublicUser,
  type ResetPasswordInput,
  type Role,
  type UpdateUserInput,
} from '@shopledger/shared';
import { writeTx, type DB, type DbOrTx } from '../../db/client';
import { users } from '../../db/schema';
import { writeAudit, type AuditActor } from '../../lib/audit';
import { nowIso } from '../../lib/dates';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import type { SessionUser } from '../../lib/permissions';
import { deleteUserSessions } from '../auth/sessions';

type UserRow = typeof users.$inferSelect;

export function toPublicUser(u: UserRow): PublicUser {
  return {
    id: u.id,
    username: u.username,
    display_name: u.display_name,
    role: u.role,
    active: u.active,
    created_at: u.created_at,
    updated_at: u.updated_at,
  };
}

/** What goes into audit snapshots: never the password hash. */
export function userSnapshot(u: UserRow) {
  return toPublicUser(u);
}

export function findUserByUsername(db: DbOrTx, username: string): UserRow | undefined {
  return db.select().from(users).where(eq(users.username, username.trim().toLowerCase())).get();
}

export function hasUsers(db: DbOrTx): boolean {
  return db.select({ id: users.id }).from(users).limit(1).get() !== undefined;
}

export function findUserById(db: DbOrTx, id: number): UserRow | undefined {
  return db.select().from(users).where(eq(users.id, id)).get();
}

export function hashPassword(password: string, rounds: number): Promise<string> {
  return bcrypt.hash(password, rounds);
}

/** Whether `actor` may manage a user with `targetRole`. The superuser account is never managed here. */
function canManageRole(actor: SessionUser, targetRole: Role): boolean {
  if (targetRole === 'superuser') return false;
  if (targetRole === 'owner') return can(actor, 'users.manage_owners');
  return can(actor, 'users.manage_operators');
}

/**
 * Loads a user that `actor` is allowed to see. Owners and operators get
 * "not found" for the superuser account, as if it did not exist.
 */
function loadVisibleUser(db: DbOrTx, actor: SessionUser, id: number): UserRow {
  const u = findUserById(db, id);
  if (!u || (u.role === 'superuser' && actor.role !== 'superuser')) throw notFound('User not found.');
  return u;
}

export function listUsers(db: DB, actor: SessionUser): PublicUser[] {
  const q = db.select().from(users);
  const rows = actor.role === 'superuser' ? q.orderBy(asc(users.id)).all() : q.where(ne(users.role, 'superuser')).orderBy(asc(users.id)).all();
  return rows.map(toPublicUser);
}

export async function createUser(db: DB, actor: SessionUser, input: CreateUserInput, rounds: number): Promise<PublicUser> {
  if (!canManageRole(actor, input.role)) throw forbidden(`You cannot create ${input.role} accounts.`);
  const password_hash = await hashPassword(input.password, rounds);
  return writeTx(db, (tx) => {
    if (findUserByUsername(tx, input.username)) throw conflict('That username is already taken.');
    const now = nowIso();
    const row = tx
      .insert(users)
      .values({
        username: input.username,
        display_name: input.display_name,
        password_hash,
        role: input.role,
        active: true,
        created_by: actor.id,
        created_at: now,
        updated_at: now,
      })
      .returning()
      .get();
    writeAudit(tx, actorOf(actor), {
      action: 'create',
      entity: 'user',
      entity_id: row.id,
      after: userSnapshot(row),
      summary: { username: row.username, role: row.role },
    });
    return toPublicUser(row);
  });
}

export function updateUser(db: DB, actor: SessionUser, id: number, input: UpdateUserInput): PublicUser {
  return writeTx(db, (tx) => {
    const before = loadVisibleUser(tx, actor, id);
    const isSelf = before.id === actor.id;

    if (before.role === 'superuser') {
      // Only the superuser reaches this point; it may rename itself, nothing else.
      if (input.role !== undefined || input.active !== undefined) {
        throw forbidden('The superuser account cannot be deactivated or have its role changed.');
      }
    } else {
      if (isSelf && (input.active === false || (input.role !== undefined && input.role !== before.role))) {
        throw badRequest('You cannot deactivate yourself or change your own role.');
      }
      if (!canManageRole(actor, before.role)) throw forbidden(`You cannot change ${before.role} accounts.`);
      if (input.role !== undefined && input.role !== before.role && !canManageRole(actor, input.role)) {
        throw forbidden(`You cannot make someone ${input.role === 'owner' ? 'an owner' : 'an operator'}.`);
      }
    }

    const set: Partial<UserRow> = {};
    if (input.display_name !== undefined && input.display_name !== before.display_name) set.display_name = input.display_name;
    if (input.role !== undefined && input.role !== before.role) set.role = input.role;
    if (input.active !== undefined && input.active !== before.active) set.active = input.active;
    if (Object.keys(set).length === 0) return toPublicUser(before);
    set.updated_at = nowIso();

    const after = tx.update(users).set(set).where(eq(users.id, id)).returning().get();
    // A deactivated user or a changed role must log in again.
    if (set.active === false || set.role !== undefined) deleteUserSessions(tx, id);

    const changed = Object.keys(set).filter((k) => k !== 'updated_at');
    writeAudit(tx, actorOf(actor), {
      action: set.active === false ? 'deactivate' : set.active === true ? 'activate' : 'update',
      entity: 'user',
      entity_id: id,
      before: userSnapshot(before),
      after: userSnapshot(after),
      summary: { changed_fields: changed },
      reason: input.reason ?? null,
    });
    return toPublicUser(after);
  });
}

export async function resetPassword(
  db: DB,
  actor: SessionUser,
  id: number,
  input: ResetPasswordInput,
  rounds: number,
): Promise<void> {
  const target = loadVisibleUser(db, actor, id);
  if (target.role === 'superuser') {
    throw forbidden('Change the superuser password from "My account", or with npm run reset-superuser on this laptop.');
  }
  if (!canManageRole(actor, target.role)) throw forbidden(`You cannot change ${target.role} accounts.`);
  const password_hash = await hashPassword(input.password, rounds);
  writeTx(db, (tx) => {
    tx.update(users).set({ password_hash, updated_at: nowIso() }).where(eq(users.id, id)).run();
    deleteUserSessions(tx, id);
    writeAudit(tx, actorOf(actor), {
      action: 'password_reset',
      entity: 'user',
      entity_id: id,
      summary: { username: target.username },
    });
  });
}

function actorOf(u: SessionUser): AuditActor {
  return { id: u.id, role: u.role };
}
