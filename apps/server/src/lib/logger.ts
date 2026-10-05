import { join } from 'node:path';
import pino, { type Logger } from 'pino';
import pinoRoll from 'pino-roll';

/** Number of daily log files kept in DATA_DIR/logs. */
export const LOG_DAYS_KEPT = 14;

/**
 * Logs to DATA_DIR/logs/shopledger.YYYY-MM-DD.N.log, one file per day, 14 days
 * kept. Runs in the main thread (no transport worker) to keep memory low.
 * Also logs to the console during development.
 */
export async function createLogger(logsDir: string, isProduction: boolean): Promise<Logger> {
  const file = await pinoRoll({
    file: join(logsDir, 'shopledger'),
    frequency: 'daily',
    dateFormat: 'yyyy-MM-dd',
    extension: '.log',
    mkdir: true,
    limit: { count: LOG_DAYS_KEPT },
  });
  const level = process.env.LOG_LEVEL ?? 'info';
  const redact = { paths: ['req.headers.cookie', 'res.headers["set-cookie"]', '*.password', '*.access_token'], remove: true };
  if (isProduction) return pino({ level, redact }, file);
  return pino({ level, redact }, pino.multistream([{ stream: file }, { stream: process.stdout }]));
}
