// Walk a freshly opened market to a sensible opening distribution.
//
//   node tools/shape_prices.mjs
//
// A new market starts flat (50/50, or 25% each way), which reads as "nobody
// has looked at this" next to questions that have been trading all weekend.
// This buys, with the seeded traders' own wallets, towards a distribution a
// reasonable room would hold - so the prices are still produced by the
// program, not typed in. Edit TARGETS when you add a question.

import fs from 'node:fs';
import path from 'node:path';
import { Keypair, PublicKey } from '@solana/web3.js';
import { operatorKeypair, tokenBalance, mintAmount, DATA_DIR, UNIT } from '../src/chain.js';
import { sendIxs } from '../src/rpc.js';
import { buyIx, ensureAtaIx, fetchMarket, loadDeployment } from '../src/client.js';
import { loadMarkets } from '../src/registry.js';
import * as lmsr from '../src/lmsr.js';

const TARGETS = {
  'hw-finalist-count': [0.08, 0.30, 0.37, 0.25],   // None / One / Two / Three+
  'badge-radio': [0.44, 0.56],                     // YES / NO
  'submissions': [0.10, 0.33, 0.38, 0.19],         // <200 / 200-299 / 300-399 / 400+
  'rox-solo': [0.45, 0.55],                        // YES / NO
  'grand-category': [0.54, 0.15, 0.15, 0.10, 0.06],
};

const op = operatorKeypair();
const hack = new PublicKey(loadDeployment().hackMint);
const traders = Object.entries(JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'demo-traders.json'), 'utf8')))
  .map(([name, s]) => ({ name, kp: Keypair.fromSecretKey(Uint8Array.from(s)) }));
const HISTORY = path.join(DATA_DIR, 'history.json');
const history = JSON.parse(fs.readFileSync(HISTORY, 'utf8'));

for (const [slug, target] of Object.entries(TARGETS)) {
  const meta = loadMarkets().find((m) => m.slug === slug);
  if (!meta) { console.warn(`no market ${slug}`); continue; }
  const market = new PublicKey(meta.address);
  for (let step = 0; step < 16; step++) {
    const live = await fetchMarket(market);
    const gap = target.map((t, i) => t - live.prices[i]);
    const i = gap.indexOf(Math.max(...gap));
    if (gap[i] < 0.03) {
      console.log(`${slug} settled: ${live.prices.map((p) => Math.round(p * 100) + '%').join(' ')}`);
      break;
    }
    const t = traders[step % traders.length];
    let cash = await tokenBalance(hack, t.kp.publicKey);
    if (cash < 140) { await mintAmount(op, hack, t.kp.publicKey, 400); cash += 400; }
    const spend = Math.min(Math.round(25 + gap[i] * 260), Math.floor(cash) - 1);
    const q = lmsr.sharesForBudget(live.q, live.b, i, spend);
    const ix = buyIx({
      user: t.kp.publicKey, market, collateralMint: hack, outcome: i,
      spend: BigInt(Math.floor(spend * UNIT)), minShares: BigInt(Math.floor(q * 0.96 * UNIT)),
    });
    await sendIxs(op, [ensureAtaIx(op.publicKey, ix.mint, t.kp.publicKey), ix.ix], [t.kp]);
    const after = await fetchMarket(market);
    (history[slug] ??= []).push({ t: Date.now(), p: after.prices.map((x) => Math.round(x * 1000) / 1000) });
    fs.writeFileSync(HISTORY, JSON.stringify(history));
    console.log(`  ${t.name.padEnd(10)} ${String(spend).padStart(3)} on ${meta.outcomes[i].padEnd(14)} -> ` +
      after.prices.map((p) => Math.round(p * 100) + '%').join(' '));
  }
}
