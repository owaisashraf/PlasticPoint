// Runs the server (tsx watch) and the web app (vite) together for development.
// Ctrl+C stops both.
import { spawn } from 'node:child_process';

const procs = [
  ['server', ['run', 'dev', '-w', '@shopledger/server']],
  ['web', ['run', 'dev', '-w', '@shopledger/web']],
].map(([name, args]) => {
  const child = spawn('npm', args, { stdio: ['inherit', 'pipe', 'pipe'], shell: true });
  const prefix = name === 'server' ? '\x1b[36m[server]\x1b[0m ' : '\x1b[35m[web]\x1b[0m    ';
  const pipe = (stream, out) =>
    stream.on('data', (chunk) => {
      for (const line of chunk.toString().split(/\r?\n/)) if (line) out.write(prefix + line + '\n');
    });
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code) => {
    console.log(`${prefix}exited with code ${code}`);
    stopAll();
  });
  return child;
});

let stopping = false;
function stopAll() {
  if (stopping) return;
  stopping = true;
  for (const p of procs) if (p.exitCode === null) p.kill('SIGINT');
}

process.on('SIGINT', stopAll);
process.on('SIGTERM', stopAll);
