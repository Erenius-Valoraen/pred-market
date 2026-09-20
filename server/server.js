// Thin backend. It NEVER prices a trade, holds a user key, or signs a trade.
//
//   GET  /api/config        program id, HACK mint, RPC url
//   GET  /api/markets       human-readable metadata (the chain stores numbers)
//   POST /api/faucet        one-time 1000 HACK + a little devnet SOL for fees
//   GET  /api/leaderboard   net worth per registered wallet, read from chain
//
// Everything a trade needs is done in the browser, signed by the user.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PublicKey, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { operatorKeypair, mintAmount, DATA_DIR, UNIT } from '../src/chain.js';
import { connection, withRetry, sendIxs, RPC_URL } from '../src/rpc.js';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { PROGRAM_ID, loadDeployment, outcomeMintPda } from '../src/client.js';
import { loadMarkets, registerTeam, resolveMarket, teamOfBadge, UserError } from '../src/registry.js';
import * as lmsr from '../src/lmsr.js';
import { createBadgeBackend } from '../src/badge-backend.js';
import { Terminal } from '../src/terminal.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, '..', 'web', 'dist');
const PORT = Number(process.env.PORT || 8787);
const FAUCET_FILE = path.join(DATA_DIR, 'faucet.json');

const FAUCET_HACK = 1000;
const FAUCET_SOL = 0.02;            // enough for fees + a few token-account rents
const IP_LIMIT_PER_HOUR = 6;        // blunt sybil brake for a play-money event

const op = operatorKeypair();
const dep = loadDeployment();
if (!dep.hackMint) throw new Error('no HACK mint - run src/onchain-e2e.js first');
const HACK = new PublicKey(dep.hackMint);

// ---------------------------------------------------------------- faucet db
const faucet = fs.existsSync(FAUCET_FILE)
  ? JSON.parse(fs.readFileSync(FAUCET_FILE, 'utf8'))
  : { wallets: {} };
function saveFaucet() {
  const tmp = `${FAUCET_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(faucet, null, 2));
  fs.renameSync(tmp, FAUCET_FILE);
}
const ipHits = new Map();           // ip -> [timestamps]
const inFlight = new Set();         // wallets currently being funded

// ------------------------------------------------------------------- admin
// A random token, created once and kept in data/ (gitignored). Anyone holding
// it can register teams and resolve markets, so share it only with organizers.
const ADMIN_TOKEN_FILE = path.join(DATA_DIR, 'admin-token.txt');
if (!fs.existsSync(ADMIN_TOKEN_FILE)) {
  fs.writeFileSync(ADMIN_TOKEN_FILE, randomBytes(18).toString('base64url'), { mode: 0o600 });
}
const ADMIN_TOKEN = fs.readFileSync(ADMIN_TOKEN_FILE, 'utf8').trim();

function isAdmin(req) {
  const got = Buffer.from(String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''));
  const want = Buffer.from(ADMIN_TOKEN);
  return got.length === want.length && timingSafeEqual(got, want);   // no timing leak
}

// Admin writes read-modify-write markets.json and spend operator SOL, so run
// them strictly one at a time; two organizers registering at once must not
// clobber each other.
let adminQueue = Promise.resolve();
function serialized(fn) {
  const run = adminQueue.then(fn, fn);
  adminQueue = run.catch(() => {});
  return run;
}

// ------------------------------------------------------ badge registrations
// Teams sent from the organizer badge wait here until an organizer names and
// confirms them on the admin page. Persisted so a restart doesn't lose them.
const PENDING_FILE = path.join(DATA_DIR, 'pending.json');
let pending = fs.existsSync(PENDING_FILE) ? JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8')) : [];
function savePending() {
  const tmp = `${PENDING_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(pending, null, 2));
  fs.renameSync(tmp, PENDING_FILE);
}

function addPending(body) {
  const rid = String(body.rid ?? '').slice(0, 40);
  if (!rid) throw new UserError('rid required');
  if (pending.some((p) => p.rid === rid)) return { ok: true, duplicate: true };
  const members = (Array.isArray(body.members) ? body.members : []).slice(0, 8)
    .map((m) => ({
      badgeId: String(m?.badgeId ?? '').replace(/[^a-z0-9-]/gi, '').slice(0, 48),
      name: String(m?.name ?? '').trim().slice(0, 32),
    }))
    .filter((m) => m.badgeId && m.name);
  if (!members.length) throw new UserError('no valid members');
  pending.push({ rid, members, at: Date.now() });
  savePending();
  return { ok: true };
}

/** Pending registrations, each member annotated if already on a team. */
function listPending() {
  const onTeam = teamOfBadge();
  return pending.map((p) => ({
    ...p,
    members: p.members.map((m) => ({ ...m, alreadyOn: onTeam.get(m.badgeId) ?? null })),
  }));
}

async function confirmPending(body) {
  const p = pending.find((x) => x.rid === body.rid);
  if (!p) throw new UserError('that pending registration no longer exists');
  const r = await registerTeam(op, HACK, {
    team: body.team, project: body.project, table: body.table, members: p.members,
  });
  // A name clash returns the EXISTING team without adding these members;
  // keep the pending entry so the organizer can pick a different name.
  if (r.duplicate) throw new UserError(`a team called "${r.market.team.name}" already exists - use another name`);
  pending = pending.filter((x) => x.rid !== body.rid);
  savePending();
  return r;
}

function cleanName(s) {
  return String(s ?? '').replace(/[^\p{L}\p{N} ._'-]/gu, '').trim().slice(0, 32);
}

// ------------------------------------------------------------ chain reads
async function marketStates() {
  // `hidden` markets (the ones created while testing) stay on-chain but are
  // not offered to traders on the web page or the badges.
  const list = loadMarkets().filter((m) => !m.hidden);
  const infos = await withRetry(() =>
    connection.getMultipleAccountsInfo(list.map((m) => new PublicKey(m.address))));
  return list.map((m, i) => {
    const d = infos[i]?.data;
    if (!d) return { ...m, missing: true };
    const n = d[3];
    const q = [];
    for (let k = 0; k < n; k++) q.push(Number(d.readBigUInt64LE(88 + 8 * k)) / UNIT);
    const b = Number(d.readBigUInt64LE(80)) / UNIT;
    return { ...m, q, b, status: d[4] === 0 ? 'open' : 'resolved', winner: d[5], prices: lmsr.prices(q, b) };
  });
}

let boardCache = { at: 0, rows: [] };
async function leaderboard() {
  if (Date.now() - boardCache.at < 60_000) return boardCache.rows;
  const markets = await marketStates();
  // mint address -> value of one share, straight from on-chain prices
  const shareValue = new Map();
  for (const m of markets) {
    if (m.missing) continue;
    m.outcomes.forEach((_, i) => {
      const v = m.status === 'resolved' ? (i === m.winner ? 1 : 0) : m.prices[i];
      shareValue.set(outcomeMintPda(new PublicKey(m.address), i).toBase58(), v);
    });
  }
  const rows = [];
  for (const [wallet, info] of Object.entries(faucet.wallets)) {
    const res = await withRetry(() => connection.getParsedTokenAccountsByOwner(
      new PublicKey(wallet), { programId: TOKEN_PROGRAM_ID }));
    let cash = 0, positions = 0;
    for (const a of res.value) {
      const t = a.account.data.parsed.info;
      const amt = Number(t.tokenAmount.amount) / UNIT;
      if (t.mint === HACK.toBase58()) cash += amt;
      else if (shareValue.has(t.mint)) positions += amt * shareValue.get(t.mint);
    }
    rows.push({ wallet, name: info.name || `${wallet.slice(0, 4)}…${wallet.slice(-4)}`,
      cash, positions, netWorth: cash + positions });
  }
  rows.sort((a, b) => b.netWorth - a.netWorth);
  boardCache = { at: Date.now(), rows };
  return rows;
}

// ------------------------------------------------------- badge trading
// Attendees trade from their own badges over the badge radio; the gateway
// badge + tools/badge_bridge.py relay frames to these two admin endpoints.
const badgeBackend = createBadgeBackend({
  op, hack: HACK, marketStates,
  onWallet(wallet, name) {
    faucet.wallets[wallet] = { name: cleanName(name), at: Date.now(), badge: true };
    saveFaucet();
    boardCache.at = 0;
  },
});
let outbox = [];
const terminal = new Terminal(badgeBackend, (frames) => { outbox.push(...frames); });
// Everything worth repeating on air: the current screen of every badge that
// spoke recently, so a row one of them missed arrives eventually.
function carousel() {
  const frames = [];
  for (const s of terminal.activeSessions()) frames.push(...terminal.allFrames(s));
  return frames;
}
const refreshBoard = () => leaderboard().then((rows) => badgeBackend.setBoard(rows))
  .catch((e) => console.error('[badges] leaderboard:', e.message));
setInterval(refreshBoard, 60_000).unref();
refreshBoard();

// ------------------------------------------------------- price history
// A few hours of prices per market, sampled from the same chain reads the
// badges use, so the web page can draw a sparkline without asking Solana for
// history it does not keep.
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const HISTORY_MAX = 120;              // samples kept per market (~2 h at 60 s)
let history = {};
try {
  history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  // Older files stored a bare price per sample; start those over.
  for (const [k, v] of Object.entries(history)) if (typeof v?.[0] !== 'object') delete history[k];
} catch { /* first run */ }

async function sampleHistory() {
  const markets = await marketStates();
  for (const m of markets) {
    if (m.missing || !m.prices) continue;
    const row = (history[m.slug] ??= []);
    row.push({ t: Date.now(), p: m.prices.map((x) => Math.round(x * 1000) / 1000) });
    if (row.length > HISTORY_MAX) row.splice(0, row.length - HISTORY_MAX);
  }
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history));
}
setInterval(() => sampleHistory().catch(() => {}), 60_000).unref();
sampleHistory().catch(() => {});

// --------------------------------------------------------- registration
// Teams register themselves on the site. Each one opens a real market on
// Solana, which costs the operator SOL, so this is rate limited per network
// and capped overall; the duplicate-name check lives in registerTeam.
const REGISTER_PER_HOUR = 4;
const MAX_TEAM_MARKETS = 150;
const regHits = new Map();

async function handleRegister(req, body) {
  const ip = req.socket.remoteAddress ?? '?';
  const hour = Date.now() - 3_600_000;
  const hits = (regHits.get(ip) ?? []).filter((t) => t > hour);
  if (hits.length >= REGISTER_PER_HOUR) {
    return [429, { error: 'too many teams registered from this network in the last hour' }];
  }
  if (loadMarkets().filter((m) => m.kind === 'team').length >= MAX_TEAM_MARKETS) {
    return [503, { error: 'team registration is full - find an organizer' }];
  }
  const r = await serialized(() => registerTeam(op, HACK, {
    team: body.team, project: body.project, table: body.table,
    members: (Array.isArray(body.members) ? body.members : []).slice(0, 8),
  }));
  if (!r.duplicate) {
    hits.push(Date.now());
    regHits.set(ip, hits);
  }
  boardCache.at = 0;
  return [200, r];
}

// ---------------------------------------------------------------- handlers
async function handleFaucet(req, body) {
  let wallet;
  try { wallet = new PublicKey(body.wallet); } catch { return [400, { error: 'invalid wallet' }]; }
  const key = wallet.toBase58();
  if (faucet.wallets[key]) return [200, { ok: true, already: true, ...faucet.wallets[key] }];
  if (inFlight.has(key)) return [429, { error: 'already being funded' }];

  const ip = req.socket.remoteAddress ?? '?';
  const hour = Date.now() - 3_600_000;
  const hits = (ipHits.get(ip) ?? []).filter((t) => t > hour);
  if (hits.length >= IP_LIMIT_PER_HOUR) return [429, { error: 'faucet limit reached for this network, try later' }];

  inFlight.add(key);
  try {
    // SOL for fees first, then HACK.
    await sendIxs(op, [SystemProgram.transfer({
      fromPubkey: op.publicKey, toPubkey: wallet, lamports: Math.round(FAUCET_SOL * LAMPORTS_PER_SOL),
    })]);
    const sig = await mintAmount(op, HACK, wallet, FAUCET_HACK);
    hits.push(Date.now());
    ipHits.set(ip, hits);
    faucet.wallets[key] = { name: cleanName(body.name), at: Date.now() };
    saveFaucet();
    boardCache.at = 0;
    return [200, { ok: true, hack: FAUCET_HACK, sol: FAUCET_SOL, signature: sig }];
  } finally {
    inFlight.delete(key);
  }
}

async function route(req, url, body) {
  if (url.pathname === '/api/config') {
    return [200, { programId: PROGRAM_ID.toBase58(), hackMint: HACK.toBase58(), rpc: RPC_URL, decimals: 6 }];
  }
  if (url.pathname === '/api/markets') return [200, loadMarkets().filter((m) => !m.hidden)];
  if (url.pathname === '/api/history') return [200, history];
  if (url.pathname === '/api/register' && req.method === 'POST') return handleRegister(req, body);
  if (url.pathname === '/api/leaderboard') return [200, await leaderboard()];
  if (url.pathname === '/api/faucet' && req.method === 'POST') return handleFaucet(req, body);

  if (url.pathname.startsWith('/api/admin/')) {
    if (!isAdmin(req)) return [401, { error: 'admin token required' }];
    if (url.pathname === '/api/admin/check') return [200, { ok: true }];
    if (url.pathname === '/api/admin/team' && req.method === 'POST') {
      const r = await serialized(() => registerTeam(op, HACK, body));
      boardCache.at = 0;
      return [200, r];
    }
    if (url.pathname === '/api/admin/pending' && req.method === 'POST') {
      return [200, await serialized(() => addPending(body))];
    }
    if (url.pathname === '/api/admin/pending') return [200, listPending()];
    if (url.pathname === '/api/admin/pending/confirm' && req.method === 'POST') {
      const r = await serialized(() => confirmPending(body));
      boardCache.at = 0;
      return [200, r];
    }
    if (url.pathname === '/api/admin/pending/dismiss' && req.method === 'POST') {
      return [200, await serialized(() => {
        pending = pending.filter((x) => x.rid !== body.rid);
        savePending();
        return { ok: true };
      })];
    }
    if (url.pathname === '/api/admin/badge/rx' && req.method === 'POST') {
      const mac = String(body.mac ?? '').toUpperCase();
      if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac)) throw new UserError('bad mac');
      return [200, { frames: await terminal.handle(mac, String(body.payload ?? '').slice(0, 44)) }];
    }
    if (url.pathname === '/api/admin/badge/outbox' && req.method === 'POST') {
      const frames = outbox;
      outbox = [];
      return [200, { frames, carousel: carousel() }];
    }
    if (url.pathname === '/api/admin/resolve' && req.method === 'POST') {
      const r = await serialized(() => resolveMarket(op, String(body.slug), Number(body.winner)));
      boardCache.at = 0;
      return [200, r];
    }
  }
  return [404, { error: 'not found' }];
}

// ------------------------------------------------------------------ static
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname === '/admin' ? '/admin.html' : pathname;
  const file = path.resolve(DIST, `.${decodeURIComponent(rel)}`);
  if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    const index = path.join(DIST, 'index.html');
    if (!fs.existsSync(index)) { res.writeHead(404); return res.end('frontend not built: npm run build'); }
    res.writeHead(200, { 'content-type': TYPES['.html'] });
    return fs.createReadStream(index).pipe(res);
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (!url.pathname.startsWith('/api/')) return serveStatic(res, url.pathname);
  let raw = '';
  req.on('data', (c) => { raw += c; if (raw.length > 4096) req.destroy(); });
  req.on('end', async () => {
    let status = 500, payload = { error: 'internal error' };
    try {
      const body = raw ? JSON.parse(raw) : {};
      [status, payload] = await route(req, url, body);
    } catch (e) {
      // 400 = the request was wrong (fix your input); 500 = we broke.
      status = e instanceof UserError ? 400 : e instanceof SyntaxError ? 400 : 500;
      if (status === 500) console.error(e);
      payload = { error: String(e.message ?? e).slice(0, 200) };
    }
    res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify(payload));
  });
}).listen(PORT, () => {
  console.log(`htn-market server on http://localhost:${PORT}`);
  console.log(`program ${PROGRAM_ID.toBase58()}  HACK ${HACK.toBase58()}`);
  console.log(`admin page: http://localhost:${PORT}/admin  (token in ${ADMIN_TOKEN_FILE})`);
});
