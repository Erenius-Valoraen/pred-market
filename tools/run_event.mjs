// Run everything the event needs, and keep it running.
//
//   npm run event
//
// Starts the market server and the badge bridge, prefixes their output, and
// restarts either one if it exits (with backoff so a crash loop can't spin).
// Run this in your own terminal: it must not depend on an editor or chat
// session staying open.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = process.platform === 'win32' ? 'python' : 'python3';

const services = [
  { name: 'server', cmd: process.execPath, args: [path.join(ROOT, 'server', 'server.js')] },
  { name: 'bridge', cmd: PY, args: ['-u', path.join(ROOT, 'tools', 'badge_bridge.py')] },
];

let stopping = false;

function start(svc, attempt = 0) {
  const started = Date.now();
  const child = spawn(svc.cmd, svc.args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  svc.child = child;
  const tag = `[${svc.name}]`.padEnd(9);
  const pipe = (stream, out) => {
    let buf = '';
    stream.on('data', (d) => {
      buf += d;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const l of lines) if (l && !/bigint: Failed to load bindings/.test(l)) out.write(`${tag} ${l}\n`);
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code) => {
    if (stopping) return;
    // Reset the backoff if it had been healthy for a while.
    const next = Date.now() - started > 60_000 ? 0 : attempt + 1;
    const wait = Math.min(30_000, 1000 * 2 ** next);
    console.error(`${tag} exited (code ${code}); restarting in ${wait / 1000}s`);
    setTimeout(() => start(svc, next), wait);
  });
}

for (const s of services) start(s);
console.log('event mode: server + badge bridge running. Ctrl+C to stop.');

process.on('SIGINT', () => {
  stopping = true;
  for (const s of services) s.child?.kill();
  process.exit(0);
});
