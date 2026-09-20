// Record a price point with whoever owns the history.
//
// The server keeps data/history.json in memory and rewrites it on a timer, so
// a script that writes the file directly has its points erased on the next
// tick. If the server is up, post to it; if it isn't (seeding a fresh box),
// fall back to writing the file, which is then the only writer.

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './chain.js';

const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const BASE = process.env.HTN_SERVER || 'http://localhost:8787';
const HISTORY_MAX = 120;

const token = () => {
  try { return fs.readFileSync(path.join(DATA_DIR, 'admin-token.txt'), 'utf8').trim(); } catch { return ''; }
};

export async function logPrice(slug, prices) {
  const p = prices.map((x) => Math.round(x * 1000) / 1000);
  try {
    const r = await fetch(`${BASE}/api/admin/price`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token()}` },
      body: JSON.stringify({ slug, prices: p }),
      signal: AbortSignal.timeout(4000),
    });
    if (r.ok) return;
  } catch { /* server down: we own the file */ }
  let history = {};
  try { history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch { /* first run */ }
  const row = (history[slug] ??= []);
  const last = row[row.length - 1];
  if (last && last.p.length === p.length && last.p.every((x, i) => x === p[i])) return;
  row.push({ t: Date.now(), p });
  if (row.length > HISTORY_MAX) row.splice(0, row.length - HISTORY_MAX);
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history));
}
