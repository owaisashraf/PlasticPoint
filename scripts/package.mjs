// npm run package — builds the app and makes the folder to copy to the shop
// laptop (CLAUDE.md section 18), plus a .zip of it:
//
//   release/ShopLedger/                 apps/server/dist, apps/web/dist, scripts, docs,
//                                       a package.json with only the runtime parts,
//                                       package-lock.json and node_modules (Windows x64,
//                                       Node 24), so installing needs no internet
//   release/ShopLedger-<version>.zip
//
// The shop laptop needs only Node.js 24 LTS. install.bat runs `npm ci --omit=dev`
// only when the bundled parts are missing or do not load.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const releaseDir = join(root, 'release');
const out = join(releaseDir, 'ShopLedger');
const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const serverPkg = JSON.parse(readFileSync(join(root, 'apps/server/package.json'), 'utf8'));

function run(cmd, args, cwd = root) {
  console.log(`> ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) {
    console.error(`Failed: ${cmd} ${args.join(' ')}`);
    process.exit(1);
  }
}

run('npm', ['run', 'build']);

rmSync(releaseDir, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const noMaps = (src) => !src.endsWith('.map');
cpSync(join(root, 'apps/server/dist'), join(out, 'apps/server/dist'), { recursive: true, filter: noMaps });
cpSync(join(root, 'apps/web/dist'), join(out, 'apps/web/dist'), { recursive: true, filter: noMaps });
cpSync(join(root, 'docs'), join(out, 'docs'), { recursive: true });
cpSync(join(root, '.env.example'), join(out, '.env.example'));
mkdirSync(join(out, 'scripts'));
for (const f of ['run-cli.mjs', 'install.bat', 'start.bat', 'verify-audit.bat', 'backup-now.bat', 'reset-superuser.bat']) {
  cpSync(join(root, 'scripts', f), join(out, 'scripts', f));
}

// Only what runs on the laptop: the server's npm dependencies (the shared
// workspace is already bundled into dist).
const dependencies = Object.fromEntries(Object.entries(serverPkg.dependencies).filter(([name]) => !name.startsWith('@shopledger/')));
const allowScripts = Object.fromEntries(Object.entries(rootPkg.allowScripts ?? {}).filter(([spec]) => Object.keys(dependencies).some((d) => spec.startsWith(`${d}@`))));
writeFileSync(
  join(out, 'package.json'),
  `${JSON.stringify(
    {
      name: 'shopledger',
      version: rootPkg.version,
      private: true,
      type: 'module',
      engines: rootPkg.engines,
      scripts: {
        start: 'node --max-semi-space-size=2 apps/server/dist/server.js',
        'db:migrate': 'node scripts/run-cli.mjs migrate',
        'backup:now': 'node scripts/run-cli.mjs backup-now',
        'verify-audit': 'node scripts/run-cli.mjs verify-audit',
        'reset-superuser': 'node scripts/run-cli.mjs reset-superuser',
        seed: 'node scripts/run-cli.mjs seed',
      },
      dependencies,
      allowScripts,
    },
    null,
    2,
  )}\n`,
);
writeFileSync(
  join(out, 'README.txt'),
  [
    `ShopLedger ${rootPkg.version}`,
    '',
    'To install on a new laptop:',
    '  1. Install "Node.js 24 LTS" for Windows from https://nodejs.org',
    '  2. Copy this ShopLedger folder to the laptop (for example to C:\\ShopLedger)',
    '  3. Double-click scripts\\install.bat',
    '  4. Start ShopLedger with the shortcut on the desktop',
    '',
    'Moving from another laptop: see docs\\MOVE_TO_NEW_LAPTOP.md',
    'How to use ShopLedger: see docs\\USER_GUIDE.md',
    '',
  ].join('\r\n'),
);

// The runtime parts, installed now so the laptop needs no internet.
run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], out);

// Zipped with Windows' own .NET zip support (Git Bash's tar cannot make zips; Windows tar crashes on node_modules).
const zipName = `ShopLedger-${rootPkg.version}.zip`;
const ps = (path) => `'${path.replaceAll("'", "''")}'`;
const zip = spawnSync(
  'powershell',
  [
    '-NoProfile',
    '-Command',
    `Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory(${ps(out)}, ${ps(join(releaseDir, zipName))}, [IO.Compression.CompressionLevel]::Optimal, $true)`,
  ],
  { stdio: 'inherit' },
);
if (zip.status !== 0) {
  console.error('Making the zip failed.');
  process.exit(1);
}

function folderSize(dir) {
  let total = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    total += e.isDirectory() ? folderSize(p) : statSync(p).size;
  }
  return total;
}
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
console.log('');
console.log(`Release folder: ${out} (${mb(folderSize(out))}, of which node_modules ${mb(existsSync(join(out, 'node_modules')) ? folderSize(join(out, 'node_modules')) : 0)})`);
console.log(`Zip:            ${join(releaseDir, zipName)} (${mb(statSync(join(releaseDir, zipName)).size)})`);
