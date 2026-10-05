import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { count, eq } from 'drizzle-orm';
import type {
  ApprovalInput,
  ChangeOwnPasswordInput,
  LoginInput,
  PublicUser,
  Role,
  SetupAccountInput,
  SetupStatus,
} from '@shopledger/shared';
import { writeTx, type DB, type DbOrTx } from '../../db/client';
import { users } from '../../db/schema';
import { writeAudit, type AuditActor } from '../../lib/audit';
import { nowIso } from '../../lib/dates';
import { badRequest, conflict, forbidden, unauthorized } from '../../lib/errors';
import { can, effectivePermissions, type SessionUser } from '../../lib/permissions';
import { throttleFor } from '../../lib/throttle';
import { findUserById, findUserByUsername, hashPassword, toPublicUser, userSnapshot } from '../users/service';
import { createSession, deleteSession, deleteUserSessions } from './sessions';

export function auditActor(user: Pick<SessionUser, 'id' | 'role'>): AuditActor {
  return { id: user.id, role: user.role };
}

// A bcrypt hash of a random string, so a login with an unknown username takes
// as long as one with a wrong password. Created on first use.
let dummyHash: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
  dummyHash ??= bcrypt.hash(randomBytes(16).toString('hex'), 10);
  return dummyHash;
}

export interface RequestMeta {
  ip?: string;
  userAgent?: string;
}

// --- First-run setup ---------------------------------------------------------

function countByRole(db: DbOrTx, role: Role): number {
  return db.select({ n: count() }).from(users).where(eq(users.role, role)).get()?.n ?? 0;
}

export function setupStatus(db: DbOrTx): SetupStatus {
  if (countByRole(db, 'superuser') === 0) return { needs: 'superuser' };
  if (countByRole(db, 'owner') === 0) return { needs: 'owner' };
  return { needs: null };
}

/** Step 1: create the single superuser. Only allowed while the database has no users at all. */
export async function setupSuperuser(
  db: DB,
  input: SetupAccountInput,
  rounds: number,
  meta: RequestMeta,
): Promise<{ user: PublicUser; token: string }> {
  const password_hash = await hashPassword(input.password, rounds);
  return writeTx(db, (tx) => {
    const anyUser = tx.select({ n: count() }).from(users).get()?.n ?? 0;
    if (anyUser > 0) throw conflict('Setup is already done. Please log in.');
    const now = nowIso();
    const row = tx
      .insert(users)
      .values({
        username: input.username,
        display_name: input.display_name,
        password_hash,
        role: 'superuser',
        active: true,
        created_by: null,
        created_at: now,
        updated_at: now,
      })
      .returning()
      .get();
    writeAudit(tx, { id: row.id, role: 'superuser' }, {
      action: 'create',
      entity: 'user',
      entity_id: row.id,
      after: userSnapshot(row),
      summary: { username: row.username, role: 'superuser', first_run_setup: true },
    });
    const token = createSession(tx, row.id, meta);
    return { user: toPublicUser(row), token };
  });
}

/** Step 2: the superuser creates the first owner. Only allowed while there is no owner yet. */
export async function setupOwner(db: DB, actor: SessionUser, input: SetupAccountInput, rounds: number): Promise<PublicUser> {
  if (actor.role !== 'superuser') throw forbidden('Only the superuser can finish setup.');
  const password_hash = await hashPassword(input.password, rounds);
  return writeTx(db, (tx) => {
    if (countByRole(tx, 'owner') > 0) throw conflict('An owner account already exists.');
    if (findUserByUsername(tx, input.username)) throw conflict('That username is already taken.');
    const now = nowIso();
    const row = tx
      .insert(users)
      .values({
        username: input.username,
        display_name: input.display_name,
        password_hash,
        role: 'owner',
        active: true,
        created_by: actor.id,
        created_at: now,
        updated_at: now,
      })
      .returning()
      .get();
    writeAudit(tx, auditActor(actor), {
      action: 'create',
      entity: 'user',
      entity_id: row.id,
      after: userSnapshot(row),
      summary: { username: row.username, role: 'owner', first_run_setup: true },
    });
    return toPublicUser(row);
  });
}

// --- Login / logout ----------------------------------------------------------

const LOGIN_FAILED = 'Wrong username or password.';

export async function login(db: DB, input: LoginInput, meta: RequestMeta): Promise<{ user: PublicUser; token: string }> {
  const throttle = throttleFor(db);
  const key = `login:${input.username.trim().toLowerCase()}`;
  throttle.assertAllowed(key, 'this username');
  const user = findUserByUsername(db, input.username);
  const ok = await bcrypt.compare(input.password, user?.password_hash ?? (await getDummyHash()));

  if (!user || !ok || !user.active) {
    writeTx(db, (tx) =>
      writeAudit(tx, { id: user?.id ?? null, role: user?.role ?? null }, {
        action: 'login_failed',
        entity: 'session',
        entity_id: user?.id ?? null,
        summary: {
          username: input.username,
          reason: !user ? 'unknown_user' : !ok ? 'wrong_password' : 'inactive',
          ip: meta.ip ?? null,
        },
      }),
    );
    if (!ok) throttle.fail(key);
    throw unauthorized(user && ok && !user.active ? 'This account has been deactivated. Ask the owner.' : LOGIN_FAILED);
  }
  throttle.reset(key);

  return writeTx(db, (tx) => {
    const token = createSession(tx, user.id, meta);
    writeAudit(tx, auditActor(user), {
      action: 'login',
      entity: 'session',
      entity_id: user.id,
      summary: { username: user.username, ip: meta.ip ?? null },
    });
    return { user: toPublicUser(user), token };
  });
}

export function logout(db: DB, user: SessionUser, token: string): void {
  writeTx(db, (tx) => {
    deleteSession(tx, token);
    writeAudit(tx, auditActor(user), {
      action: 'logout',
      entity: 'session',
      entity_id: user.id,
      summary: { username: user.username },
    });
  });
}

export async function changeOwnPassword(
  db: DB,
  user: SessionUser,
  input: ChangeOwnPasswordInput,
  rounds: number,
  currentToken: string | null,
): Promise<void> {
  const row = findUserById(db, user.id);
  if (!row) throw unauthorized();
  if (!(await bcrypt.compare(input.current_password, row.password_hash))) {
    throw badRequest('Your current password is not correct.');
  }
  const password_hash = await hashPassword(input.new_password, rounds);
  writeTx(db, (tx) => {
    tx.update(users).set({ password_hash, updated_at: nowIso() }).where(eq(users.id, user.id)).run();
    // Log out everywhere else; keep the session that made the change.
    deleteUserSessions(tx, user.id, currentToken);
    writeAudit(tx, auditActor(user), {
      action: 'password_change',
      entity: 'user',
      entity_id: user.id,
      summary: { username: user.username },
    });
  });
}

// --- Owner approval ----------------------------------------------------------

/**
 * Who approves a safety-rule exception (CLAUDE.md 8.10, section 15). An owner
 * or the superuser approves their own action by confirming. Anyone else needs
 * an active owner's or the superuser's username and password, typed inline.
 * Returns null when no approval was offered. A wrong password is audited.
 */
export async function verifyApproval(db: DB, user: SessionUser, approval: ApprovalInput | undefined, what: string): Promise<AuditActor | null> {
  if (!approval) return null;
  if (can(user, 'approvals.grant')) return approval.confirmed ? auditActor(user) : null;
  if (!approval.username || !approval.password) return null;

  // Counted apart from logins, so failed approvals cannot lock the owner out of logging in.
  const throttle = throttleFor(db);
  const key = `approval:${approval.username.trim().toLowerCase()}`;
  throttle.assertAllowed(key, 'owner approval');
  const approver = findUserByUsername(db, approval.username);
  const ok = await bcrypt.compare(approval.password, approver?.password_hash ?? (await getDummyHash()));
  const allowed = approver && approver.active && can({ role: approver.role, permissions: effectivePermissions(approver.role, true) }, 'approvals.grant');
  if (!approver || !ok || !allowed) {
    writeTx(db, (tx) =>
      writeAudit(tx, auditActor(user), {
        action: 'approval_failed',
        entity: 'session',
        entity_id: approver?.id ?? null,
        summary: { approver_username: approval.username, for: what, reason: !approver ? 'unknown_user' : !ok ? 'wrong_password' : 'not_allowed' },
      }),
    );
    if (!ok) throttle.fail(key);
    throw forbidden(approver && ok ? 'Only the owner can approve this.' : 'Wrong owner username or password.');
  }
  throttle.reset(key);
  return auditActor(approver);
}
