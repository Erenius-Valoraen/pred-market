// Solana devnet plumbing: keypairs, SOL, and SPL token operations.
//
// Design: the OPERATOR pays every fee and every rent deposit. Devnet's faucet
// is aggressively rate-limited, so requiring SOL per user would make the demo
// fragile. Users still own real, individual token accounts on-chain — they
// just never need SOL themselves.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, clusterApiUrl,
} from '@solana/web3.js';
import {
  createMint, getOrCreateAssociatedTokenAccount, mintTo, transfer,
  burn, getAccount, getMint,
} from '@solana/spl-token';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Overridable so demos and tests never touch the real market's state/keys.
export const DATA_DIR = process.env.MARKET_DATA_DIR
  ? path.resolve(process.env.MARKET_DATA_DIR)
  : path.resolve(HERE, '..', 'data');
export const DECIMALS = 6;                 // 1 HACK = 1_000_000 base units
export const UNIT = 10 ** DECIMALS;

const RPC = process.env.SOLANA_RPC || clusterApiUrl('devnet');
export const connection = new Connection(RPC, 'confirmed');

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

/** Associated token account for (mint, owner); operator pays the rent. */
export async function ata(operator, mint, owner) {
  return getOrCreateAssociatedTokenAccount(connection, operator, mint, owner);
}

export async function mintAmount(operator, mint, owner, amount) {
  const acct = await ata(operator, mint, owner);
  return mintTo(connection, operator, mint, acct.address, operator, toBase(amount));
}

/** Move tokens from `ownerKp`'s account to `toOwner`'s. Operator pays the fee. */
export async function transferAmount(operator, mint, ownerKp, toOwner, amount) {
  const from = await ata(operator, mint, ownerKp.publicKey);
  const to = await ata(operator, mint, toOwner);
  return transfer(connection, operator, from.address, to.address, ownerKp, toBase(amount));
}

/** Destroy tokens (used when a winning position is redeemed). */
export async function burnAmount(operator, mint, ownerKp, amount) {
  const acct = await ata(operator, mint, ownerKp.publicKey);
  return burn(connection, operator, acct.address, mint, ownerKp, toBase(amount));
}

export async function tokenBalance(mint, owner) {
  try {
    const { getAssociatedTokenAddressSync } = await import('@solana/spl-token');
    const addr = getAssociatedTokenAddressSync(mint, owner);
    const acct = await getAccount(connection, addr);
    return fromBase(acct.amount);
  } catch {
    return 0; // no account yet = zero balance
  }
}

export async function mintSupply(mint) {
  return fromBase((await getMint(connection, mint)).supply);
}

export function explorer(kind, id) {
  return `https://explorer.solana.com/${kind}/${id}?cluster=devnet`;
}

export { PublicKey, Keypair };
