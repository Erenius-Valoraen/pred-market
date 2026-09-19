// Solana devnet plumbing: keypairs, SOL, and SPL token operations.
//
// Design: the OPERATOR pays every fee and every rent deposit. Devnet's faucet
// is aggressively rate-limited, so requiring SOL per user would make the demo
// fragile. Users still own real, individual token accounts on-chain — they
// just never need SOL themselves.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import {
  createMint, getAccount, getMint, getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction,
} from '@solana/spl-token';
import { connection, sendIxs } from './rpc.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Overridable so demos and tests never touch the real market's state/keys.
export const DATA_DIR = process.env.MARKET_DATA_DIR
  ? path.resolve(process.env.MARKET_DATA_DIR)
  : path.resolve(HERE, '..', 'data');
export const DECIMALS = 6;                 // 1 HACK = 1_000_000 base units
export const UNIT = 10 ** DECIMALS;

export { connection };

export function toBase(amount) {
  // Round down: never mint/transfer more than the math allowed.
  return BigInt(Math.floor(amount * UNIT));
}
export function fromBase(units) {
  return Number(units) / UNIT;
}

function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
}

/** Load a keypair from disk, creating and saving a new one if absent. */
export function loadOrCreateKeypair(file) {
  ensureDir(path.dirname(file));
  if (fs.existsSync(file)) {
    const secret = Uint8Array.from(JSON.parse(fs.readFileSync(file, 'utf8')));
    return Keypair.fromSecretKey(secret);
  }
  const kp = Keypair.generate();
  fs.writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
  return kp;
}

export function operatorKeypair() {
  return loadOrCreateKeypair(path.join(DATA_DIR, 'operator.keypair.json'));
}

export async function solBalance(pubkey) {
  return (await connection.getBalance(pubkey)) / LAMPORTS_PER_SOL;
}

/**
 * Top the operator up from the devnet faucet. The faucet rate-limits hard and
 * often returns 429 or an internal error, so retry with backoff and report
 * clearly instead of crashing.
 */
export async function ensureSol(pubkey, minSol = 1, requestSol = 1) {
  let bal = await solBalance(pubkey);
  if (bal >= minSol) return bal;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const sig = await connection.requestAirdrop(pubkey, requestSol * LAMPORTS_PER_SOL);
      const latest = await connection.getLatestBlockhash();
      await connection.confirmTransaction({ signature: sig, ...latest }, 'confirmed');
      bal = await solBalance(pubkey);
      if (bal >= minSol) return bal;
    } catch (e) {
      const wait = 1500 * attempt;
      console.warn(`  airdrop attempt ${attempt} failed (${String(e.message).slice(0, 90)}); retrying in ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw new Error(
    `Operator ${pubkey.toBase58()} has ${bal} SOL and the devnet faucet refused. ` +
    'Fund it manually at https://faucet.solana.com then re-run.');
}

/** Create a new SPL mint with the operator as mint authority. */
export async function createTokenMint(operator) {
  return createMint(connection, operator, operator.publicKey, null, DECIMALS);
}

/**
 * Mint `amount` of a token to `owner`, creating their token account if needed.
 * One transaction; the operator pays rent and fee. Used only for the play-money
 * HACK faucet — outcome shares are minted exclusively by the on-chain program.
 */
export async function mintAmount(operator, mint, owner, amount) {
  const dest = getAssociatedTokenAddressSync(mint, owner);
  return sendIxs(operator, [
    createAssociatedTokenAccountIdempotentInstruction(operator.publicKey, dest, owner, mint),
    createMintToInstruction(mint, dest, operator.publicKey, toBase(amount)),
  ]);
}

export async function tokenBalance(mint, owner) {
  const { getAssociatedTokenAddressSync, TokenAccountNotFoundError } = await import('@solana/spl-token');
  const addr = getAssociatedTokenAddressSync(mint, owner);
  for (let i = 0; ; i++) {
    try {
      return fromBase((await getAccount(connection, addr)).amount);
    } catch (e) {
      // Only a genuinely missing account means "zero". Anything else (e.g. a
      // 429 rate limit) must not be reported as a confident zero balance.
      if (e instanceof TokenAccountNotFoundError) return 0;
      if (i >= 6 || !/429|Too Many|fetch failed|ECONNRESET|ETIMEDOUT/i.test(String(e?.message))) throw e;
      await new Promise((r) => setTimeout(r, 800 * 2 ** i));
    }
  }
}

export async function mintSupply(mint) {
  return fromBase((await getMint(connection, mint)).supply);
}

export function explorer(kind, id) {
  return `https://explorer.solana.com/${kind}/${id}?cluster=devnet`;
}

export { PublicKey, Keypair };
