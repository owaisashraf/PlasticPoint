// npm run seed — fills a NEW, empty database with realistic demo data
// (CLAUDE.md 16). Refuses if the database already has users, so it can never
// mix demo data into a real shop. `npm run demo:build` runs it on ./demo-data.
//
//   --months <n>       how far back the history goes (default 18)
//   --business <name>  business name on invoices (default PlasticPointDemo)
//   --password <pw>    password for every demo login (default demo1234)
import { parseArgs } from 'node:util';
import { buildApp } from '../app';
import { BackupService } from '../jobs/backup';
import { verifyAudit } from '../lib/audit';
import { hasUsers } from '../modules/users/service';
import { installSimClock, realNow } from '../seed/clock';
import { seedDemo } from '../seed/simulate';
import { consoleLogger, openForCli, runCli } from './common';

runCli(async () => {
  const { values } = parseArgs({
    options: {
      months: { type: 'string', default: '18' },
      business: { type: 'string', default: 'PlasticPointDemo' },
      password: { type: 'string', default: 'demo1234' },
    },
  });
  const months = Number(values.months);
  if (!Number.isInteger(months) || months < 1 || months > 36) throw new Error('--months must be a whole number from 1 to 36.');
  if (values.password.length < 8) throw new Error('--password must be at least 8 characters.');

  const { config, dbh } = openForCli();
  if (hasUsers(dbh.db)) {
    dbh.close();
    console.error(`The database in ${config.dataDir} already has data. The seed only fills a new, empty database.`);
    console.error('For the demo, use "npm run demo:build" (it uses the separate demo-data folder).');
    return 1;
  }

  const began = realNow();
  const clock = installSimClock();
  const backups = new BackupService(config, dbh, consoleLogger);
  const app = await buildApp({ config, dbh, backups });
  await app.ready();
  try {
    const summary = await seedDemo(app, dbh, clock, { months, businessName: values.business, password: values.password, log: (l) => console.log(l) });
    clock.restore();
    const backup = await backups.runBackup('manual', { id: null, role: 'cli' });
    const audit = verifyAudit(dbh.sqlite);

    console.log('');
    console.log(`Demo data from ${summary.from} to ${summary.to} in ${config.dataDir}`);
    for (const [k, v] of Object.entries(summary.counts).sort()) console.log(`  ${k.padEnd(28)} ${v}`);
    if (summary.skipped.length) console.log(`  (${summary.skipped.length} optional follow-ups were refused by the app's rules and skipped)`);
    for (const line of summary.skipped.slice(0, 30)) console.log(`    - ${line}`);
    console.log(`Audit log: ${audit.ok ? 'verified' : 'PROBLEM'} · backup: ${backup.status} · ${Math.round((realNow() - began) / 1000)} s`);
    console.log('');
    console.log(`Logins (password "${values.password}" for all):`);
    console.log('  admin  superuser (change history)');
    console.log('  owner  owner (profit, expenses, assets, settings)');
    console.log('  ali    operator');
    console.log('  sana   operator');
    return audit.ok && backup.status === 'ok' ? 0 : 1;
  } finally {
    clock.restore();
    await app.close();
    dbh.close();
  }
});
