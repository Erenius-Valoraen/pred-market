// End-to-end on devnet: create HACK, open a market, trade (users sign their
// own transactions), resolve, redeem — then attack it to prove the program
// enforces its own rules.

import path from 'node:path';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import {
  operatorKeypair, loadOrCreateKeypair, DATA_DIR, createTokenMint, mintAmount,
  tokenBalance, explorer, PublicKey, UNIT,
} from './chain.js';
import {
  PROGRAM_ID, createMarketIx, buyIx, resolveIx, redeemIx, fetchMarket, send,
  ensureAtaIx, vaultPda, loadDeployment, saveDeployment, withRetry,
} from './client.js';

const op = operatorKeypair();
const dep = loadDeployment();
const link = (sig) => `      ${explorer('tx', sig)}`;

// Program error codes (program/src/lib.rs MarketError). An attack only counts
// as "blocked by the program" if it fails with the SPECIFIC expected code;
// failing for some unrelated reason proves nothing.
const ERR = { NotOpen: 1, NotResolved: 2, BadOutcome: 3, Slippage: 4, BadPda: 5,
  NotAuthority: 6, ZeroAmount: 7, WrongMint: 8, Insolvent: 9 };
function programErrorCode(e) {
  const text = `${e?.message ?? e} ${(e?.logs ?? e?.transactionLogs ?? []).join(' ')}`;
  const m = text.match(/custom program error: 0x([0-9a-f]+)/i);
  return m ? parseInt(m[1], 16) : null;
}
async function expectRejected(label, want, fn) {
  try {
    await fn();
    console.log(`!!! ${label}: SUCCEEDED. THIS IS A BUG.`);
    process.exitCode = 1;
  } catch (e) {
    const got = programErrorCode(e);
    const name = Object.keys(ERR).find((k) => ERR[k] === got) ?? 'unknown';
    if (got === ERR[want]) {
      console.log(`${label}: blocked by the program with ${want} (code ${got}) - correct reason`);
    } else {
      console.log(`??? ${label}: failed, but with ${name} (code ${got}), expected ${want}`);
      process.exitCode = 1;
    }
  }
}
const pct = (p) => `${(p * 100).toFixed(1)}%`;

console.log('program :', PROGRAM_ID.toBase58());
console.log('operator:', op.publicKey.toBase58());

// 1. HACK collateral mint (created once, reused).
let hack;
if (dep.hackMint) {
  hack = new PublicKey(dep.hackMint);
  console.log('\nHACK mint (existing):', hack.toBase58());
} else {
  hack = await createTokenMint(op);
  saveDeployment({ ...dep, hackMint: hack.toBase58(), programId: PROGRAM_ID.toBase58() });
  console.log('\nHACK mint (created) :', hack.toBase58());
}

// 2. Users with their OWN keypairs. They sign their trades; they never hold SOL.
const alice = loadOrCreateKeypair(path.join(DATA_DIR, 'users', 'alice.json'));
const bob = loadOrCreateKeypair(path.join(DATA_DIR, 'users', 'bob.json'));
for (const [name, kp] of [['alice', alice], ['bob', bob]]) {
  await mintAmount(op, hack, kp.publicKey, 1000);
  console.log(`${name.padEnd(6)} ${kp.publicKey.toBase58()}  +1000 HACK`);
}

// 3. Create a market. The program itself pulls the b*ln(n) subsidy into the vault.
const b = 200 / Math.LN2;
const marketId = Date.now();
await mintAmount(op, hack, op.publicKey, 250);
const { market, ix: cix } = createMarketIx({
  authority: op.publicKey, collateralMint: hack, marketId, n: 2, b,
});
const sigC = await send(op, [cix]);
console.log(`\nmarket created ${market.toBase58()}`);
console.log(link(sigC));
console.log(`vault holds ${(await vaultHack()).toFixed(6)} HACK (the b*ln2 subsidy, pulled in by the program)`);

async function vaultHack() {
  const { getAccount } = await import('@solana/spl-token');
  const { connection } = await import('./chain.js');
  const a = await withRetry(() => getAccount(connection, vaultPda(market)));
  return Number(a.amount) / UNIT;
}

// 4. Trades. Price is computed ON-CHAIN by the program.
async function trade(who, kp, outcome, spend) {
  const before = (await fetchMarket(market)).prices[outcome];
  const { mint, ix: bix } = buyIx({
    user: kp.publicKey, market, collateralMint: hack, outcome, spend: spend * UNIT,
  });
  const sig = await send(op, [ensureAtaIx(op.publicKey, mint, kp.publicKey), bix], [kp]);
  const m = await fetchMarket(market);
  const got = await tokenBalance(mint, kp.publicKey);
  console.log(`\n${who} buys ${outcome === 0 ? 'YES' : 'NO'} for ${spend}: ${got.toFixed(3)} shares, ` +
    `${outcome === 0 ? 'YES' : 'NO'} ${pct(before)} -> ${pct(m.prices[outcome])}`);
  console.log(link(sig));
}
await trade('alice', alice, 0, 150);
await trade('bob  ', bob, 1, 60);

const mid = await fetchMarket(market);
console.log(`\nlive odds (read straight from the chain): YES ${pct(mid.prices[0])}  NO ${pct(mid.prices[1])}`);
console.log(`vault: ${(await vaultHack()).toFixed(6)} HACK`);

// 5. ATTACK 1: bob tries to declare himself the winner.
console.log('');
await expectRejected('attack 1 (bob resolves the market)', 'NotAuthority',
  () => send(op, [resolveIx({ authority: bob.publicKey, market, winner: 1 })], [bob]));

// 6. Oracle resolves YES.
const sigR = await send(op, [resolveIx({ authority: op.publicKey, market, winner: 0 })]);
console.log('oracle resolves YES');
console.log(link(sigR));

// 7. ATTACK 2: trade after resolution. Create bob's token account in the same
//    transaction so the ONLY possible reason to fail is the market being closed.
{
  const { mint, ix: late } = buyIx({
    user: bob.publicKey, market, collateralMint: hack, outcome: 0, spend: 10 * UNIT,
  });
  await expectRejected('attack 2 (trade after resolution)', 'NotOpen',
    () => send(op, [ensureAtaIx(op.publicKey, mint, bob.publicKey), late], [bob]));
}

// 7b. ATTACK 3: bob (who bet NO) tries to redeem as if he'd won.
await expectRejected('attack 3 (loser redeems)', 'ZeroAmount',
  () => send(op, [
    ensureAtaIx(op.publicKey, (buyIx({ user: bob.publicKey, market, collateralMint: hack, outcome: 0, spend: 1 })).mint, bob.publicKey),
    redeemIx({ user: bob.publicKey, market, collateralMint: hack, winner: 0 }),
  ], [bob]));

// 8. Alice redeems her winning shares, 1 HACK each, paid by the vault.
const aliceBefore = await tokenBalance(hack, alice.publicKey);
const sigX = await send(op, [redeemIx({ user: alice.publicKey, market, collateralMint: hack, winner: 0 })], [alice]);
const aliceAfter = await tokenBalance(hack, alice.publicKey);
console.log(`\nalice redeems: +${(aliceAfter - aliceBefore).toFixed(6)} HACK  (now ${aliceAfter.toFixed(2)})`);
console.log(link(sigX));
console.log(`bob (bet NO) keeps ${(await tokenBalance(hack, bob.publicKey)).toFixed(2)} HACK`);

const left = await vaultHack();
console.log(`\nvault after payout: ${left.toFixed(6)} HACK  ->  ${left >= 0 ? 'SOLVENT' : 'INSOLVENT'}`);
console.log(`market: ${explorer('address', market.toBase58())}`);
saveDeployment({ ...loadDeployment(), lastDemoMarket: market.toBase58() });
