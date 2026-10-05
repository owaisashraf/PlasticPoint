// npm run reset-superuser — local-only recovery of the superuser password.
// Runs on the shop laptop itself; there is no way to do this over the network.
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { eq } from 'drizzle-orm';
import { passwordSchema } from '@shopledger/shared';
import { writeTx } from '../db/client';
import { users } from '../db/schema';
import { writeAudit } from '../lib/audit';
import { nowIso } from '../lib/dates';
import { deleteUserSessions } from '../modules/auth/sessions';
import { hashPassword } from '../modules/users/service';
import { openForCli, runCli } from './common';

/** Asks a question without echoing what is typed. */
function askHidden(question: string): Promise<string> {
  let muted = false;
  const output = new Writable({
    write(chunk, _enc, cb) {
      if (!muted) process.stdout.write(chunk);
      cb();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
    muted = true;
  });
}

runCli(async () => {
  const { config, dbh } = openForCli();
  try {
    const su = dbh.db.select().from(users).where(eq(users.role, 'superuser')).get();
    if (!su) {
      console.error('There is no superuser yet. Start ShopLedger and complete the first-run setup.');
      return 1;
    }
    console.log(`Resetting the password for the superuser "${su.username}".`);
    const pw = await askHidden('New password: ');
    const parsed = passwordSchema.safeParse(pw);
    if (!parsed.success) {
      console.error(parsed.error.issues[0]?.message ?? 'Invalid password.');
      return 1;
    }
    if ((await askHidden('Type it again: ')) !== pw) {
      console.error('The passwords do not match. Nothing was changed.');
      return 1;
    }
    const password_hash = await hashPassword(pw, config.bcryptRounds);
    writeTx(dbh.db, (tx) => {
      tx.update(users).set({ password_hash, active: true, updated_at: nowIso() }).where(eq(users.id, su.id)).run();
      deleteUserSessions(tx, su.id);
      writeAudit(tx, { id: null, role: 'cli' }, {
        action: 'password_reset',
        entity: 'user',
        entity_id: su.id,
        summary: { username: su.username, via: 'npm run reset-superuser' },
        reason: 'Local superuser password reset on this laptop',
      });
    });
    console.log('Superuser password changed. Log in with the new password.');
    return 0;
  } finally {
    dbh.close();
  }
});
