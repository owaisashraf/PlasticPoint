// npm run verify-audit — checks the audit log hash chain.
import { verifyAudit } from '../lib/audit';
import { openForCli, runCli } from './common';

runCli(() => {
  const { dbh } = openForCli();
  try {
    const result = verifyAudit(dbh.sqlite);
    if (result.ok) {
      console.log(`Audit log OK: ${result.rows_checked} rows checked, chain intact.`);
      if (result.last_id) console.log(`Last row: ${result.last_id}  ${result.last_hash}`);
      return 0;
    }
    console.error(`Audit log FAILED the integrity check (${result.rows_checked} rows checked):`);
    for (const p of result.problems) console.error(`  - ${p}`);
    return 2;
  } finally {
    dbh.close();
  }
});
