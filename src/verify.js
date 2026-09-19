// Independently verify a market's question hasn't been changed since creation.
//
//   npm run verify -- <slug>        (or no slug to check every market)
//
// Pulls the creation transaction FROM THE CHAIN, extracts the memo written in
// that same transaction, recomputes SHA-256 over the metadata the website
// displays, and compares. A mismatch means the displayed question differs
// from what traders were promised when the market opened.

import { connection, withRetry } from './rpc.js';
import { loadMarkets, commitmentHash } from './registry.js';

const want = process.argv[2];
const list = loadMarkets().filter((m) => !want || m.slug === want);
if (!list.length) { console.log(want ? `no market ${want}` : 'no markets'); process.exit(1); }

let bad = 0;
for (const m of list) {
  if (!m.createSig) {
    console.log(`-  ${m.slug.padEnd(24)} created before commitments existed (no memo to check)`);
    continue;
  }
  const tx = await withRetry(() => connection.getTransaction(m.createSig,
    { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }));
  const logs = tx?.meta?.logMessages ?? [];
  const memo = logs.map((l) => l.match(/Memo \(len \d+\): "(.*)"/)?.[1]).find(Boolean) ?? '';
  const m2 = memo.match(/^htnmkt:v1 (\S+) sha256=([0-9a-f]{64})$/);
  const recomputed = commitmentHash(m);
  const ok = m2 && m2[1] === m.address && m2[2] === recomputed && !tx.meta.err;
  if (!ok) bad++;
  console.log(`${ok ? 'OK' : 'XX'} ${m.slug.padEnd(24)} ${ok ? 'question matches on-chain commitment' : 'MISMATCH'}`);
  if (!ok || want) {
    console.log(`     on-chain memo : ${memo || '(none found)'}`);
    console.log(`     recomputed    : sha256=${recomputed}`);
    console.log(`     question      : ${m.question}`);
  }
}
process.exitCode = bad ? 1 : 0;
