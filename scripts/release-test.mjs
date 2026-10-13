// npm run release:test — the move-to-laptop test (CLAUDE.md section 18), run on
// the release zip from `npm run package`, in folders with spaces in their names:
//
//   laptop A: unzip, install.bat, use it (3 months of seeded shop data), start, check
//   laptop B: unzip, install.bat, copy A's data folder, verify-audit, start, check
//             the same figures, PDFs and screens; then restore from a backup file
//
// Also reports start-up time and idle memory (targets: under 5 s, under 200 MB).
// Uses its own temp folders and ports; never the real data folder.
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const zip = join(root, 'release', `ShopLedger-${version}.zip`);
if (!existsSync(zip)) {
  console.error(`No ${zip}. Run "npm run package" first.`);
  process.exit(1);
}

const base = mkdtempSync(join(tmpdir(), 'ShopLedger move test '));
const env = { ...process.env, NODE_ENV: 'production' };
delete env.DATA_DIR; // each copy uses its own .\data, like on a laptop
delete env.PORT;

let failures = 0;
const results = [];
function check(what, ok, detail = '') {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
  console.log(results.at(-1));
  if (!ok) failures += 1;
  return ok;
}

const ps = (path) => `'${path.replaceAll("'", "''")}'`;
function unzipTo(dir) {
  const r = spawnSync('powershell', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory(${ps(zip)}, ${ps(dir)})`], { stdio: 'inherit' });
  return r.status === 0 ? join(dir, 'ShopLedger') : null;
}
function run(app, cmd, args) {
  const r = spawnSync(cmd, args, { cwd: app, env, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}
const install = (app) => run(app, 'cmd.exe', ['/d', '/c', 'scripts\\install.bat', '/test']);
const cli = (app, ...args) => run(app, process.execPath, ['scripts/run-cli.mjs', ...args]);

/** Started the way scripts/start.bat starts it. */
async function startServer(app, port) {
  const began = Date.now();
  const child = spawn(process.execPath, ['--max-semi-space-size=2', 'apps/server/dist/server.js'], { cwd: app, env: { ...env, PORT: String(port) }, stdio: 'ignore' });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) return { child, url, startup_ms: Date.now() - began };
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  throw new Error('ShopLedger did not start within 10 seconds');
}

async function loginAs(url, username) {
  const res = await fetch(`${url}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'demo1234' }) });
  const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  return { ok: res.ok, get: (path) => fetch(`${url}${path}`, { headers: { cookie } }) };
}

/** The figures that must be identical after the move. */
async function snapshot(url) {
  const owner = await loginAs(url, 'owner');
  if (!owner.ok) return null;
  const sales = await (await owner.get('/api/sales?limit=1&status=all')).json();
  const overdue = await (await owner.get('/api/overdue/count')).json();
  const customers = await (await owner.get('/api/customers?limit=500')).json();
  const balance = customers.customers.reduce((s, c) => s + c.balance_paisa, 0);
  const pl = await (await owner.get('/api/reports/net-profit')).json();
  return { sales: sales.total, last_invoice: sales.sales[0]?.doc_no, overdue: overdue.count, receivables_paisa: balance, net_profit: JSON.stringify(pl.summary ?? pl.totals ?? null), owner };
}

function memoryMb(pid) {
  const r = spawnSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).WorkingSet64`], { encoding: 'utf8' });
  return Math.round(Number(r.stdout.trim()) / 1024 / 1024);
}

console.log(`Release test in: ${base}\n`);
let serverA;
let serverB;
try {
  // --- Laptop A ---------------------------------------------------------------------
  const appA = unzipTo(join(base, 'laptop A'));
  check('laptop A: unzip the release', Boolean(appA));
  let r = install(appA);
  check('laptop A: install.bat', r.code === 0, r.code === 0 ? 'parts already bundled, database prepared' : r.out.slice(-400));
  r = cli(appA, 'seed', '--months', '3');
  check('laptop A: 3 months of shop use (seed)', r.code === 0, r.code === 0 ? r.out.match(/sales\s+\d+/)?.[0] : r.out.slice(-400));

  serverA = await startServer(appA, 3191);
  const before = await snapshot(serverA.url);
  check('laptop A: owner logs in and sees the shop', Boolean(before), before ? `${before.sales} invoices, last ${before.last_invoice}` : '');
  serverA.child.kill();
  serverA = null;
  await new Promise((r) => setTimeout(r, 500));

  // --- Laptop B: copy the data folder -----------------------------------------------------
  const appB = unzipTo(join(base, 'laptop B'));
  check('laptop B: unzip the release', Boolean(appB));
  r = install(appB);
  check('laptop B: install.bat', r.code === 0, r.code === 0 ? '' : r.out.slice(-400));
  rmSync(join(appB, 'data'), { recursive: true, force: true });
  cpSync(join(appA, 'data'), join(appB, 'data'), { recursive: true });
  check('laptop B: copy the data folder from A', existsSync(join(appB, 'data', 'shopledger.db')));
  r = cli(appB, 'verify-audit');
  check('laptop B: verify-audit', r.code === 0 && r.out.includes('Audit log OK'), r.out.trim().split('\n')[0]);

  serverB = await startServer(appB, 3192);
  check('laptop B: start-up time under 5 s', serverB.startup_ms < 5000, `${serverB.startup_ms} ms`);
  const after = await snapshot(serverB.url);
  check('laptop B: same invoices, overdue, balances and net profit as A', JSON.stringify({ ...after, owner: 0 }) === JSON.stringify({ ...before, owner: 0 }), after ? `${after.sales} invoices, ${after.overdue} overdue, receivables Rs ${(after.receivables_paisa / 100).toLocaleString('en-PK')}` : 'login failed');
  if (after) {
    const list = await (await after.owner.get('/api/sales?limit=1')).json();
    const pdf = await after.owner.get(`/api/sales/${list.sales[0].id}/pdf`);
    const bytes = Buffer.from(await pdf.arrayBuffer());
    check('laptop B: invoice PDF', pdf.headers.get('content-type') === 'application/pdf' && bytes.subarray(0, 4).toString() === '%PDF', `${Math.round(bytes.length / 1024)} KB`);
    const page = await fetch(`${serverB.url}/reports`);
    check('laptop B: screens are served', page.ok && (await page.text()).includes('<div id="root"'));
    const operator = await loginAs(serverB.url, 'ali');
    const denied = await operator.get('/api/reports/profit-loss');
    check('laptop B: operators still cannot see profit', operator.ok && denied.status === 403);
  }
  await new Promise((r) => setTimeout(r, 3000));
  const mem = memoryMb(serverB.child.pid);
  check('laptop B: idle memory under 200 MB', mem > 0 && mem < 200, `${mem} MB`);
  serverB.child.kill();
  serverB = null;
  await new Promise((r) => setTimeout(r, 500));

  // --- Laptop B again: from a backup file instead ----------------------------------------
  const backups = readdirSync(join(appB, 'data', 'backups')).filter((f) => /^shopledger-.*\.db$/.test(f)).sort();
  const newest = backups.at(-1);
  if (check('backup file: a backup exists', Boolean(newest), newest)) {
    for (const f of ['shopledger.db', 'shopledger.db-wal', 'shopledger.db-shm']) rmSync(join(appB, 'data', f), { force: true });
    cpSync(join(appB, 'data', 'backups', newest), join(appB, 'data', 'shopledger.db'));
    r = cli(appB, 'verify-audit');
    check('backup file: verify-audit', r.code === 0 && r.out.includes('Audit log OK'), r.out.trim().split('\n')[0]);
    serverB = await startServer(appB, 3193);
    const restored = await snapshot(serverB.url);
    check('backup file: same invoices and balances as A', restored?.sales === before?.sales && restored?.receivables_paisa === before?.receivables_paisa);
    serverB.child.kill();
    serverB = null;
  }
} catch (e) {
  check('release test', false, e instanceof Error ? e.message : String(e));
} finally {
  serverA?.child.kill();
  serverB?.child.kill();
}

console.log('');
console.log(failures === 0 ? 'Release test PASSED.' : `Release test FAILED (${failures}). Folders kept for a look: ${base}`);
if (failures === 0) {
  await new Promise((r) => setTimeout(r, 500));
  rmSync(base, { recursive: true, force: true });
}
process.exit(failures === 0 ? 0 : 1);
