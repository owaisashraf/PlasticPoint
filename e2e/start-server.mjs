// Starts the built ShopLedger server for end-to-end tests on a brand-new,
// throwaway data folder (never ./data). Used by playwright.config.ts.
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = join(tmpdir(), 'shopledger-e2e-data');
rmSync(dataDir, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });

const child = spawn(process.execPath, [join(root, 'apps/server/dist/server.js')], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, NODE_ENV: 'production', DATA_DIR: dataDir, PORT: process.env.E2E_PORT ?? '3130', HOST: '127.0.0.1' },
});
const stop = () => child.kill('SIGINT');
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', (code) => process.exit(code ?? 0));
