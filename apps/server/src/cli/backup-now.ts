// npm run backup:now — takes a backup immediately (safe while the app is running).
import { BackupService } from '../jobs/backup';
import { consoleLogger, openForCli, runCli } from './common';

runCli(async () => {
  const { config, dbh } = openForCli();
  try {
    const backups = new BackupService(config, dbh, consoleLogger);
    const entry = await backups.runBackup('manual', { id: null, role: 'cli' });
    if (entry.status !== 'ok') {
      console.error(`Backup FAILED: ${entry.error}`);
      return 1;
    }
    console.log(`Backup saved: ${entry.file_name}`);
    if (entry.second_copy_status === 'ok') console.log('Copied to the second backup folder.');
    if (entry.second_copy_status === 'failed') console.warn(`Copy to the second folder failed: ${entry.second_copy_error}`);
    return 0;
  } finally {
    dbh.close();
  }
});
