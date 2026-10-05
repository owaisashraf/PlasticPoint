// npm run db:migrate — applies database migrations to DATA_DIR/shopledger.db.
import { openForCli, runCli } from './common';

runCli(() => {
  const { config, dbh } = openForCli();
  dbh.close();
  console.log(`Database is up to date: ${config.dbFile}`);
  return 0;
});
