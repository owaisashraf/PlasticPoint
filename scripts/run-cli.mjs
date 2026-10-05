// Runs a server CLI command (migrate, backup-now, verify-audit, reset-superuser).
// On a dev machine (tsx installed) it runs the TypeScript source; on the shop
// laptop (dev dependencies omitted) it runs the built bundle in apps/server/dist.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const [name, ...args] = process.argv.slice(2);
if (!name) {
  console.error('Usage: node scripts/run-cli.mjs <command> [args]');
  process.exit(1);
}

function isInstalled(pkg) {
  try {
    createRequire(import.meta.url).resolve(`${pkg}/package.json`);
    return true;
  } catch {
    return false;
  }
}
const hasTsx = isInstalled('tsx');

const src = join(root, 'apps/server/src/cli', `${name}.ts`);
const built = join(root, 'apps/server/dist/cli', `${name}.js`);

let cmd;
if (hasTsx && existsSync(src)) {
  cmd = [process.execPath, ['--import', 'tsx', src, ...args]];
} else if (existsSync(built)) {
  cmd = [process.execPath, [built, ...args]];
} else {
  console.error(`Command "${name}" not found. Run "npm run build" first.`);
  process.exit(1);
}

const result = spawnSync(cmd[0], cmd[1], { stdio: 'inherit', cwd: root });
process.exit(result.status ?? 1);
