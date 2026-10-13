// The demo shop lives in its own folder, ./demo-data, so it never touches the
// real ./data folder.
//
//   npm run demo:build   delete ./demo-data and build 18 months of demo data
//   npm run demo         run the dev servers on ./demo-data
//   npm run demo:start   run the built app on ./demo-data
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const demoDir = join(root, 'demo-data');
const [command, ...args] = process.argv.slice(2);
const env = { ...process.env, DATA_DIR: demoDir };

function run(cmd, cmdArgs) {
  const result = spawnSync(cmd, cmdArgs, { stdio: 'inherit', cwd: root, env, shell: process.platform === 'win32' && cmd === 'npm' });
  process.exit(result.status ?? 1);
}

if (command === 'build') {
  rmSync(demoDir, { recursive: true, force: true });
  run(process.execPath, [join(root, 'scripts/run-cli.mjs'), 'seed', ...args]);
} else if (command === 'dev' || command === 'start') {
  if (!existsSync(join(demoDir, 'shopledger.db'))) {
    console.error('No demo data yet. Run "npm run demo:build" first.');
    process.exit(1);
  }
  console.log(`Demo shop: data from ${demoDir}`);
  run(process.execPath, command === 'dev' ? [join(root, 'scripts/dev.mjs')] : ['--max-semi-space-size=2', join(root, 'apps/server/dist/server.js'), ...args]);
} else {
  console.error('Usage: node scripts/demo.mjs build | dev | start');
  process.exit(1);
}
