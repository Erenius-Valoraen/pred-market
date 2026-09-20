// Keep the market breathing while you present.
//
//   npm run demo:live              -- a trade every 25-70s, forever
//   npm run demo:live -- --every 40 --max 60
//
// The seeded traders (src/seed-demo.js) take small positions at random
// intervals, so prices tick, the tape moves and the leaderboard reshuffles
// while judges are looking at the page. Every trade is real: signed by that
// trader's own wallet and settled by the program on devnet. Ctrl+C stops it.
//
// Sizes are deliberately small (10-40 HACK): enough to move a price a point
// or two, not enough to make a market look silly mid-demo.

import fs from 'node:fs';
import path from 'node:path';
import { Keypair, PublicKey } from '@solana/web3.js';
import { operatorKeypair, tokenBalance, mintAmount, DATA_DIR, UNIT, solBalance } from '../src/chain.js';
import { sendIxs } from '../src/rpc.js';
import { buyIx, sellIx, ensureAtaIx, fetchMarket, loadDeployment } from '../src/client.js';
import { loadMarkets } from '../src/registry.js';
import * as lmsr from '../src/lmsr.js';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : fallback;
};
const MIN_GAP = arg('every', 25) * 1000;
const MAX_GAP = arg('max', 70) * 1000;
const TOP_UP = 150;                    // refill a trader that runs dry

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const stamp = () => new Date().toLocaleTimeString();

const traders = (() => {
  const file = path.join(DATA_DIR, 'demo-traders.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Object.entries(saved).map(([name, secret]) => ({
    name, kp: Keypair.fromSecretKey(Uint8Array.from(secret)),
  }));
})();

const op = operatorKeypair();
const hack = new PublicKey(loadDeployment().hackMint);
let stopping = false;
process.on('SIGINT', () => { stopping = true; console.log('\nstopping after this trade'); });

console.log(`demo ticker: ${traders.length} traders, a trade every ${MIN_GAP / 1000}-${MAX_GAP / 1000}s`);
console.log('every trade is real on devnet. Ctrl+C to stop.\n');

while (!stopping) {
  const trader = pick(traders);
  const meta = pick(loadMarkets().filter((m) => !m.hidden));
  try {
    const market = new PublicKey(meta.address);
    const live = await fetchMarket(market);
    if (!live || live.status !== 'open') continue;

    let cash = await tokenBalance(hack, trader.kp.publicKey);
    if (cash < 45) {
      await mintAmount(op, hack, trader.kp.publicKey, TOP_UP);
      cash += TOP_UP;
      console.log(`${stamp()}  topped up ${trader.name}`);
    }

    // Lean towards whatever is already favoured, but not always: a market
    // that only ever goes one way stops looking like a market.
    const favourite = live.prices.indexOf(Math.max(...live.prices));
    const outcome = Math.random() < 0.65 ? favourite : Math.floor(Math.random() * live.n);
    const spend = Math.min(Math.round(10 + Math.random() * 30), Math.floor(cash) - 1);
    if (spend < 10) continue;

    const quote = lmsr.sharesForBudget(live.q, live.b, outcome, spend);
    const ix = buyIx({
      user: trader.kp.publicKey, market, collateralMint: hack, outcome,
      spend: BigInt(Math.floor(spend * UNIT)),
      minShares: BigInt(Math.floor(quote * 0.96 * UNIT)),
    });
    await sendIxs(op, [ensureAtaIx(op.publicKey, ix.mint, trader.kp.publicKey), ix.ix], [trader.kp]);
    const after = await fetchMarket(market);
    const label = meta.team?.name ?? meta.short ?? meta.slug;
    console.log(`${stamp()}  ${trader.name.padEnd(10)} ${String(spend).padStart(2)} HACK on ` +
      `${live.n === 2 ? (outcome ? 'NO ' : 'YES') : `#${outcome}`} ${label}  ->  ` +
      `${Math.round(after.prices[outcome] * 100)}%`);
  } catch (e) {
    console.warn(`${stamp()}  skipped (${String(e.message).slice(0, 70)})`);
    await sleep(5000);
  }
  await sleep(MIN_GAP + Math.random() * (MAX_GAP - MIN_GAP));
}

console.log(`operator has ${(await solBalance(op.publicKey)).toFixed(3)} SOL left`);
