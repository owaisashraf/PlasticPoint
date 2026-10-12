// Bundles the server and CLI tools into dist/ with esbuild, and copies the
// SQL migrations next to them. npm dependencies stay external (installed by
// `npm ci --omit=dev` on the shop laptop); the shared workspace is bundled in.
import { cpSync, readFileSync, rmSync } from 'node:fs';
import { build } from 'esbuild';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const external = Object.keys(pkg.dependencies).filter((d) => !d.startsWith('@shopledger/'));

rmSync('dist', { recursive: true, force: true });

const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  external,
  sourcemap: true,
  logLevel: 'info',
  // Lets bundled CommonJS helpers call require() inside the ESM bundle.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
};

await build({ ...common, entryPoints: { server: 'src/index.ts' }, outdir: 'dist' });
await build({
  ...common,
  entryPoints: ['migrate', 'backup-now', 'verify-audit', 'reset-superuser', 'seed'].map((n) => `src/cli/${n}.ts`),
  outdir: 'dist/cli',
});

cpSync('src/db/migrations', 'dist/migrations', { recursive: true });
console.log('Server build complete.');
