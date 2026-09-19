// Put the event-wide seed markets on-chain (idempotent) via the shared registry.
//   npm run seed
import { operatorKeypair, PublicKey } from './chain.js';
import { loadDeployment } from './client.js';
import { ensureMarket, loadMarkets, saveMarkets, MARKETS_FILE } from './registry.js';
import { SEED_MARKETS } from './seed-markets.js';

const op = operatorKeypair();
const dep = loadDeployment();
if (!dep.hackMint) throw new Error('no HACK mint yet - run `npm run e2e` once first');
const hack = new PublicKey(dep.hackMint);

const bySlug = new Map(loadMarkets().map((m) => [m.slug, m]));
for (const def of SEED_MARKETS) {
  const rec = await ensureMarket(op, hack, {
    slug: def.id, question: def.question, outcomes: def.outcomes,
    subsidy: def.subsidy, resolves: def.meta?.resolves ?? '', kind: 'seed', short: def.short,
  });
  // Keep fields recorded at creation time (commitment, sigs) on re-runs.
  bySlug.set(rec.slug, { ...rec, ...bySlug.get(rec.slug), created: rec.created });
  console.log(`${rec.created.padEnd(8)} ${rec.slug.padEnd(15)} ${rec.address}`);
}
saveMarkets([...bySlug.values()]);
console.log(`\n${bySlug.size} markets recorded in ${MARKETS_FILE}`);
