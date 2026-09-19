// Create the seed markets ON-CHAIN and record their metadata.
//
// The chain stores numbers (q, b, status); humans need the question and the
// outcome names. Those live in data/markets.json, keyed by market address.
// Idempotent: a market whose account already exists is skipped, so this can
// be re-run safely after adding new markets.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { operatorKeypair, mintAmount, DATA_DIR, PublicKey } from './chain.js';
import { connection, withRetry } from './rpc.js';
import { createMarketIx, marketPda, send, loadDeployment } from './client.js';
import { SEED_MARKETS } from './seed-markets.js';

export const MARKETS_FILE = path.join(DATA_DIR, 'markets.json');

/** Stable numeric market id from a slug, so re-runs find the same PDA. */
export function marketIdFor(slug) {
  return createHash('sha256').update(`htn2026:${slug}`).digest().readBigUInt64LE(0) >> 1n;
}

export function loadMarkets() {
  return fs.existsSync(MARKETS_FILE) ? JSON.parse(fs.readFileSync(MARKETS_FILE, 'utf8')) : [];
}

export function saveMarkets(list) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${MARKETS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, MARKETS_FILE);
}

/** Create one market on-chain (if needed) and return its metadata record. */
export async function ensureMarket(op, hack, def) {
  const id = marketIdFor(def.slug ?? def.id);
  const address = marketPda(op.publicKey, id);
  const exists = await withRetry(() => connection.getAccountInfo(address));
  const n = def.outcomes.length;
  if (!exists) {
    const b = def.subsidy / Math.log(n);
    // The program pulls b*ln(n) (rounded up) from the operator; mint a margin.
    await mintAmount(op, hack, op.publicKey, def.subsidy + 1);
    const { ix } = createMarketIx({ authority: op.publicKey, collateralMint: hack, marketId: id, n, b });
    await send(op, [ix]);
  }
  return {
    slug: def.slug ?? def.id,
    address: address.toBase58(),
    marketId: id.toString(),
    question: def.question,
    outcomes: def.outcomes,
    subsidy: def.subsidy,
    resolves: def.meta?.resolves ?? def.resolves ?? '',
    kind: def.kind ?? 'seed',
    created: exists ? 'existing' : 'new',
  };
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` ||
    process.argv[1]?.endsWith('seed-onchain.js')) {
  const op = operatorKeypair();
  const dep = loadDeployment();
  if (!dep.hackMint) throw new Error('no HACK mint yet - run src/onchain-e2e.js once first');
  const hack = new PublicKey(dep.hackMint);

  const existing = new Map(loadMarkets().map((m) => [m.slug, m]));
  for (const def of SEED_MARKETS) {
    const rec = await ensureMarket(op, hack, { ...def, slug: def.id });
    existing.set(rec.slug, { ...existing.get(rec.slug), ...rec });
    console.log(`${rec.created.padEnd(8)} ${rec.slug.padEnd(15)} ${rec.address}`);
  }
  saveMarkets([...existing.values()]);
  console.log(`\n${existing.size} markets recorded in ${MARKETS_FILE}`);
}
