// Browser-side chain access. Mirrors program/src/{lib,state}.rs.
// Reads go straight to the chain; trades are signed by the user's own wallet.

import {
  Connection, PublicKey, Transaction, TransactionInstruction, ComputeBudgetProgram,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from '@solana/spl-token';
import * as lmsr from '../../src/lmsr.js';

export const UNIT = 1_000_000;
export let connection;
export let PROGRAM_ID;
export let HACK;

export function init(config) {
  connection = new Connection(config.rpc, 'confirmed');
  PROGRAM_ID = new PublicKey(config.programId);
  HACK = new PublicKey(config.hackMint);
}

const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };

export const vaultPda = (market) =>
  PublicKey.findProgramAddressSync([Buffer.from('vault'), market.toBuffer()], PROGRAM_ID)[0];
export const outcomeMintPda = (market, i) =>
  PublicKey.findProgramAddressSync([Buffer.from('outcome'), market.toBuffer(), Buffer.from([i])], PROGRAM_ID)[0];

// ------------------------------------------------------------- retrying reads
const TRANSIENT = /429|Too Many|fetch failed|Failed to fetch|NetworkError|50[23]/i;
export async function withRetry(fn, tries = 6) {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) {
      if (i >= tries - 1 || !TRANSIENT.test(String(e?.message ?? e))) throw e;
      await new Promise((r) => setTimeout(r, 700 * 2 ** i));
    }
  }
}

/**
 * Prices and balances come from OUR server, not from Solana directly: at a
 * hackathon every phone hitting the public devnet RPC gets everyone rate
 * limited. The server reads the same accounts once and caches them. The only
 * thing the browser still sends to the chain is its own signed transaction.
 */
export async function fetchMarkets() {
  const rows = await (await fetch('/api/state')).json();
  return rows.map((m) => ({ ...m, pubkey: m.missing ? null : new PublicKey(m.address) }));
}

/** All token balances for a wallet: mint(base58) -> amount. */
export async function fetchBalances(owner) {
  const { mints } = await (await fetch(`/api/wallet/${owner.toBase58()}`)).json();
  return new Map(Object.entries(mints ?? {}));
}

export async function solBalance(owner) {
  const { sol } = await (await fetch(`/api/wallet/${owner.toBase58()}`)).json();
  return sol ?? 0;
}

// ------------------------------------------------------------------- quotes
// The exact function the program evaluates, so the preview matches the fill.
export const quoteBuy = (m, i, spend) => lmsr.sharesForBudget(m.q, m.b, i, spend);
export const quoteSell = (m, i, shares) => lmsr.sellRefund(m.q, m.b, i, shares);
export function priceAfterBuy(m, i, shares) {
  const q = m.q.slice(); q[i] += shares;
  return lmsr.prices(q, m.b)[i];
}

// -------------------------------------------------------------- instructions
const w = (pubkey, isSigner = false) => ({ pubkey, isSigner, isWritable: true });
const r = (pubkey, isSigner = false) => ({ pubkey, isSigner, isWritable: false });
const ix = (data, keys) => new TransactionInstruction({ programId: PROGRAM_ID, data, keys });

function tradeKeys(user, market, outcome) {
  const mint = outcomeMintPda(market, outcome);
  return {
    mint,
    keys: [
      r(user, true), w(market), w(vaultPda(market)),
      w(getAssociatedTokenAddressSync(HACK, user)),
      w(mint), w(getAssociatedTokenAddressSync(mint, user)), r(TOKEN_PROGRAM_ID),
    ],
  };
}

const floorUnits = (x) => BigInt(Math.max(0, Math.floor(x * UNIT)));

export function buyIxs(user, market, outcome, spend, minShares) {
  const { mint, keys } = tradeKeys(user, market, outcome);
  return [
    createAssociatedTokenAccountIdempotentInstruction(user, getAssociatedTokenAddressSync(mint, user), user, mint),
    ix(Buffer.concat([Buffer.from([1, outcome]), u64(floorUnits(spend)), u64(floorUnits(minShares))]), keys),
  ];
}

export function sellIxs(user, market, outcome, shares, minRefund) {
  const { keys } = tradeKeys(user, market, outcome);
  return [ix(Buffer.concat([Buffer.from([2, outcome]), u64(floorUnits(shares)), u64(floorUnits(minRefund))]), keys)];
}

export function redeemIxs(user, market, winner) {
  const { keys } = tradeKeys(user, market, winner);
  keys[1] = r(market);
  return [ix(Buffer.from([4]), keys)];
}

// ------------------------------------------------------------------- sending
/** Sign once with the user's wallet, send, poll for confirmation. */
export async function sendWithWallet(wallet, ixs) {
  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }));
  tx.add(...ixs);
  tx.feePayer = wallet.publicKey;
  const { blockhash, lastValidBlockHeight } = await withRetry(() => connection.getLatestBlockhash('confirmed'));
  tx.recentBlockhash = blockhash;
  const signed = await wallet.signTransaction(tx);
  const raw = signed.serialize();
  const sig = await withRetry(() => connection.sendRawTransaction(raw, { preflightCommitment: 'confirmed' }));
  for (;;) {
    const { value } = await withRetry(() => connection.getSignatureStatuses([sig]));
    const s = value[0];
    if (s?.err) throw new Error(`transaction failed: ${JSON.stringify(s.err)}`);
    if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) return sig;
    const h = await withRetry(() => connection.getBlockHeight('confirmed'));
    if (h > lastValidBlockHeight) throw new Error('transaction expired - try again');
    await new Promise((res) => setTimeout(res, 700));
  }
}

/** Turn a program error into something a human can act on. */
export function explainError(e) {
  const msg = String(e?.message ?? e);
  const logs = (e?.logs ?? e?.transactionLogs ?? []).join('\n');
  // Our error codes start at 1, and so do the SPL Token program's, so the
  // bare code is ambiguous (token InsufficientFunds is also 0x1). The logs say
  // which program actually failed, so check them first.
  if (/insufficient funds|insufficient lamports/i.test(logs + msg)) {
    return 'Not enough HACK (or SOL for fees).';
  }
  if (/User rejected/i.test(msg)) return 'You cancelled the signature.';
  const code = msg.match(/custom program error: 0x([0-9a-f]+)/i);
  const known = { 1: 'This market is closed.', 2: 'This market has not been resolved yet.',
    3: 'Invalid outcome.', 4: 'The price moved before your trade landed. Try again.',
    7: 'Amount too small.', 8: 'Wrong token account.' };
  if (code) return known[parseInt(code[1], 16)] ?? `Program error ${parseInt(code[1], 16)}.`;
  return msg.slice(0, 160);
}

export const explorer = (kind, id) => `https://explorer.solana.com/${kind}/${id}?cluster=devnet`;
