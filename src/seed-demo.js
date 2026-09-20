// Fill the market with teams and a believable trading history, for real.
//
//   npm run seed:demo            -- teams + traders + a few dozen trades
//   npm run seed:demo -- --dry   -- say what it would do, touch nothing
//
// Nothing here is faked: every team is a real market opened on Solana with
// its question hashed into the creation transaction, every trade is a real
// signed transaction from its own wallet, and the price history written to
// data/history.json is the price the program actually quoted after each
// fill. It just happens on purpose, before the judges arrive, instead of
// waiting for a room to wander past.
//
// Tell people that, by the way: "we seeded these teams and traders
// ourselves this morning" costs you nothing and answers the obvious
// question before it is asked.

import fs from 'node:fs';
import path from 'node:path';
import { Keypair, PublicKey } from '@solana/web3.js';
import { operatorKeypair, mintAmount, tokenBalance, DATA_DIR, UNIT, solBalance } from './chain.js';
import { sendIxs } from './rpc.js';
import { buyIx, sellIx, ensureAtaIx, fetchMarket, loadDeployment } from './client.js';
import { registerTeam, loadMarkets, saveMarkets } from './registry.js';
import * as lmsr from './lmsr.js';

const DRY = process.argv.includes('--dry');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : fallback;
};
const TEAMS = arg('teams', 8);
const TRADERS = arg('traders', 6);
const TRADES = arg('trades', 36);
const START_HACK = 1000;

const TEAM_BOOK = [
  ['Northwind', 'Offline-first notes that sync when you get signal', 'E7-114'],
  ['Halcyon', 'Calmer incident dashboards for on-call engineers', 'E7-036'],
  ['Ironwood', 'Structural analysis you can run from a phone', 'E5-221'],
  ['Bluejay', 'Transit alerts that actually arrive before the bus', 'E7-208'],
  ['Copperline', 'Power monitoring for old buildings', 'DC-160'],
  ['Quartz', 'Search across everything a team has ever written', 'E5-118'],
  ['Meridian', 'Scheduling across timezones without the spreadsheet', 'E7-042'],
  ['Lantern', 'Reading help for low-vision students', 'DC-204'],
  ['Foxglove', 'Plant health from a cheap camera', 'E5-330'],
  ['Kestrel', 'Drone flight logs that explain themselves', 'E7-155'],
];

// The first pass used jokier names; --retire hides those markets so the
// board reads like a real event. They stay on-chain, just out of sight.
const RETIRED = [
  'Rubber Duck Debuggers', 'Late Night Compilers', 'Segfault Symphony',
  'Kernel Panic Attack', 'Caffeine Overflow', 'The Merge Conflicts',
  'Undefined Behaviour', 'Null Pointer Express', 'Stack Overflowers',
  'Heap of Trouble', 'UI Smoke Test', 'Test Badge',
];

const TRADER_BOOK = [
  'Priya K.', 'Marcus O.', 'Chen W.', 'Sofia R.', 'Dev P.', 'Ines A.', 'Tomas L.', 'Amara B.',
];

const MEMBERS = ['Alex', 'Sam', 'Riya', 'Noor', 'Jules', 'Kai', 'Mina', 'Theo', 'Ravi', 'Lena'];

const WALLETS_FILE = path.join(DATA_DIR, 'demo-traders.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const FAUCET_FILE = path.join(DATA_DIR, 'faucet.json');

// A fixed sequence, so two runs of this script behave the same way.
let seed = 20260920;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

const readJson = (f, fallback) => {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; }
};

async function main() {
  const op = operatorKeypair();
  const dep = loadDeployment();
  if (!dep.hackMint) throw new Error('no HACK mint yet - run `npm run e2e` once first');
  const hack = new PublicKey(dep.hackMint);
  const sol = await solBalance(op.publicKey);
  console.log(`operator ${op.publicKey.toBase58()}  ${sol.toFixed(3)} SOL`);
  console.log(`plan: ${TEAMS} teams, ${TRADERS} traders, ${TRADES} trades` + (DRY ? '  (dry run)' : ''));
  if (sol < 0.4) console.warn('! low on SOL: top up at faucet.solana.com before the demo');
  if (DRY) {
    TEAM_BOOK.slice(0, TEAMS).forEach(([t, p, table]) => console.log(`  team  ${t} - ${p} (${table})`));
    TRADER_BOOK.slice(0, TRADERS).forEach((t) => console.log(`  trader ${t}`));
    return;
  }

  // ------------------------------------------------------------- teams
  if (process.argv.includes('--retire')) {
    const list = loadMarkets();
    let n = 0;
    for (const m of list) {
      if (m.kind === 'team' && RETIRED.includes(m.team?.name) && !m.hidden) { m.hidden = true; n += 1; }
    }
    saveMarkets(list);
    console.log(`  retired ${n} earlier demo team(s) - hidden from the site and the badges`);
  }
  const existing = new Set(loadMarkets().map((m) => m.team?.name?.toLowerCase()).filter(Boolean));
  for (const [name, project, table] of TEAM_BOOK.slice(0, TEAMS)) {
    if (existing.has(name.toLowerCase())) { console.log(`  team exists  ${name}`); continue; }
    const members = Array.from({ length: 2 + Math.floor(rnd() * 3) }, () => ({ name: pick(MEMBERS) }));
    const r = await registerTeam(op, hack, { team: name, project, table, members });
    console.log(`  team opened  ${name}  ${r.market.address}`);
  }

  // ----------------------------------------------------------- traders
  const saved = readJson(WALLETS_FILE, {});
  const traders = [];
  for (const name of TRADER_BOOK.slice(0, TRADERS)) {
    if (!saved[name]) saved[name] = Array.from(Keypair.generate().secretKey);
    const kp = Keypair.fromSecretKey(Uint8Array.from(saved[name]));
    traders.push({ name, kp });
  }
  fs.writeFileSync(WALLETS_FILE, JSON.stringify(saved, null, 1), { mode: 0o600 });

  for (const t of traders) {
    const bal = await tokenBalance(hack, t.kp.publicKey);
    if (bal < 50) {
      await mintAmount(op, hack, t.kp.publicKey, START_HACK);
      console.log(`  funded       ${t.name}  ${START_HACK} HACK`);
    } else {
      console.log(`  has funds    ${t.name}  ${bal.toFixed(0)} HACK`);
    }
  }

  // Put them on the leaderboard under their names.
  const faucet = readJson(FAUCET_FILE, { wallets: {} });
  for (const t of traders) {
    faucet.wallets[t.kp.publicKey.toBase58()] ??= { name: t.name, at: Date.now(), demo: true };
  }
  fs.writeFileSync(FAUCET_FILE, JSON.stringify(faucet, null, 2));

  // ------------------------------------------------------------ trades
  // Each market gets a side the room leans towards, so prices end up spread
  // out and moving instead of every card sitting at 50%.
  const markets = loadMarkets().filter((m) => !m.hidden);
  const history = readJson(HISTORY_FILE, {});
  const lean = new Map(markets.map((m) => [m.slug, rnd() < 0.5 ? 0 : 1 % m.outcomes.length]));
  let done = 0;
  let failed = 0;

  for (let i = 0; i < TRADES; i++) {
    const meta = pick(markets);
    const trader = pick(traders);
    const market = new PublicKey(meta.address);
    try {
      const live = await fetchMarket(market);
      if (!live || live.status !== 'open') continue;
      const favourite = lean.get(meta.slug) ?? 0;
      // Mostly with the lean, sometimes against it: that is what makes a chart.
      const outcome = rnd() < 0.72 ? favourite : Math.floor(rnd() * live.n);
      const cash = await tokenBalance(hack, trader.kp.publicKey);
      const spend = Math.min(Math.round(20 + rnd() * 110), Math.floor(cash) - 1);
      if (spend < 10) continue;

      const quote = lmsr.sharesForBudget(live.q, live.b, outcome, spend);
      const ix = buyIx({
        user: trader.kp.publicKey, market, collateralMint: hack, outcome,
        spend: BigInt(Math.floor(spend * UNIT)),
        minShares: BigInt(Math.floor(quote * 0.97 * UNIT)),
      });
      await sendIxs(op, [ensureAtaIx(op.publicKey, ix.mint, trader.kp.publicKey), ix.ix], [trader.kp]);
      done += 1;

      // Record the price the program quotes now: this is the real path.
      const after = await fetchMarket(market);
      const row = (history[meta.slug] ??= []);
      row.push({ t: Date.now(), p: after.prices.map((x) => Math.round(x * 1000) / 1000) });
      if (row.length > 120) row.splice(0, row.length - 120);
      fs.writeFileSync(HISTORY_FILE, JSON.stringify(history));

      console.log(`  trade ${String(done).padStart(2)}/${TRADES}  ${trader.name.padEnd(10)} ` +
        `${spend.toString().padStart(3)} HACK on ${live.n === 2 ? (outcome ? 'NO ' : 'YES') : `#${outcome}`} ` +
        `${meta.team?.name ?? meta.slug}  ->  ${Math.round(after.prices[outcome] * 100)}%`);
    } catch (e) {
      failed += 1;
      console.warn(`  ! trade failed on ${meta.slug}: ${String(e.message).slice(0, 80)}`);
      if (failed > 6) throw new Error('too many failures - is devnet throttling? try again in a minute');
    }
  }

  const left = await solBalance(op.publicKey);
  console.log(`\ndone: ${done} trades, ${failed} failed. Operator has ${left.toFixed(3)} SOL ` +
    `(spent ${(sol - left).toFixed(3)}).`);
  console.log('Say out loud during the demo: these teams and traders were seeded by us,');
  console.log('the trades and prices are real on devnet.');
}

main().catch((e) => { console.error(e.message); process.exit(1); });
