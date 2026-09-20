// Single shared RPC connection + transaction sending that survives the public
// devnet RPC's aggressive rate limiting.
//
// Why not web3.js's sendAndConfirmTransaction: its confirmTransaction fires
// background status checks over a websocket and does not await them. When the
// RPC answers one of those with 429, the rejection is unhandled and kills the
// process. Here every RPC call is awaited and owned, so it can be retried.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Connection, ComputeBudgetProgram, Transaction, clusterApiUrl } from '@solana/web3.js';
import bs58 from 'bs58';

// The endpoint list lives in data/rpc.txt (gitignored) so the key never
// reaches the repo and every tool - server, seeder, tests - shares it
// without anyone remembering to export a variable.
function configuredRpc() {
  if (process.env.SOLANA_RPC) return process.env.SOLANA_RPC;
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const file = process.env.MARKET_DATA_DIR
      ? path.join(path.resolve(process.env.MARKET_DATA_DIR), 'rpc.txt')
      : path.resolve(here, '..', 'data', 'rpc.txt');
    const text = fs.readFileSync(file, 'utf8').trim();
    if (text) return text;
  } catch { /* fall through to the public endpoint */ }
  return clusterApiUrl('devnet');
}

// SOLANA_RPC may list several endpoints, comma separated. Devnet's public
// RPC rate-limits an address hard, and at an event that looks like the
// market going down, so a spare is worth having.
const RPC_URLS = configuredRpc().split(',').map((u) => u.trim()).filter(Boolean);
export const RPC_URL = RPC_URLS[0];
const pool = RPC_URLS.map((u) => new Connection(u, 'confirmed'));
let current = 0;
export const connection = new Proxy({}, {
  get(_, prop) {
    const target = pool[current];
    const value = target[prop];
    return typeof value === 'function' ? value.bind(target) : value;
  },
});
/** Move to the next endpoint after a rate limit; returns true if it changed. */
export function rotateRpc() {
  if (pool.length < 2) return false;
  current = (current + 1) % pool.length;
  console.warn(`[rpc] switching to ${RPC_URLS[current]}`);
  return true;
}

const TRANSIENT = /429|Too Many Requests|fetch failed|ECONNRESET|ETIMEDOUT|socket hang up|50[23]/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Retry ONLY transient network/rate-limit failures, with exponential backoff.
 * A program error (e.g. a rejected trade) is never retried: it is the answer.
 */
export async function withRetry(fn, tries = 7) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= tries - 1 || !TRANSIENT.test(String(e?.message ?? e))) throw e;
      if (/429|Too Many/i.test(String(e?.message ?? e))) rotateRpc();
      await sleep(800 * 2 ** i);
    }
  }
}

/** Poll for confirmation ourselves instead of relying on websocket callbacks. */
async function confirm(signature, lastValidBlockHeight) {
  for (;;) {
    const { value } = await withRetry(() => connection.getSignatureStatuses([signature]));
    const s = value[0];
    if (s?.err) return s.err;
    if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) return null;
    const height = await withRetry(() => connection.getBlockHeight('confirmed'));
    if (height > lastValidBlockHeight) throw new Error(`transaction ${signature} expired before confirming`);
    await sleep(600);
  }
}

/**
 * Sign once, send, confirm. `feePayer` pays the fee; `signers` authorize the
 * instructions (e.g. a user moving their own tokens).
 *
 * Retrying with these identical signed bytes is safe: the chain dedupes by
 * signature, so a retry can never execute a trade twice. Re-signing with a
 * fresh blockhash would NOT be safe, which is why we never do that.
 */
export async function sendIxs(feePayer, ixs, signers = [], cu = 400_000) {
  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: cu }));
  tx.add(...ixs);
  tx.feePayer = feePayer.publicKey;
  const all = [feePayer, ...signers.filter((s) => !s.publicKey.equals(feePayer.publicKey))];

  const { blockhash, lastValidBlockHeight } = await withRetry(() => connection.getLatestBlockhash('confirmed'));
  tx.recentBlockhash = blockhash;
  tx.sign(...all);
  const raw = tx.serialize();
  const expected = bs58.encode(tx.signature);

  const signature = await withRetry(async () => {
    try {
      return await connection.sendRawTransaction(raw, { preflightCommitment: 'confirmed' });
    } catch (e) {
      if (/already been processed/i.test(String(e?.message))) return expected;
      throw e;
    }
  });

  const err = await confirm(signature, lastValidBlockHeight);
  if (err) {
    const info = await withRetry(() => connection.getTransaction(signature,
      { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }));
    const e = new Error(`transaction failed: ${JSON.stringify(err)}`);
    e.logs = info?.meta?.logMessages ?? [];
    throw e;
  }
  return signature;
}
