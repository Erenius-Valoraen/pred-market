// Client for the on-chain market program: PDAs, instruction encoding, and a
// decoder for the market account. Mirrors program/src/{lib,state}.rs exactly.

import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { withRetry } from './rpc.js';
import {
  TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from '@solana/spl-token';
import fs from 'node:fs';
import path from 'node:path';
import { connection, DATA_DIR, UNIT } from './chain.js';
import * as lmsr from './lmsr.js';

export const PROGRAM_ID = new PublicKey(
  process.env.MARKET_PROGRAM_ID || 'ApdW8HztjPCrUqS4mu6gfsdP795GcrDD1BojPTzZ4Yi');

const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const u8 = (n) => Buffer.from([n]);

// ------------------------------------------------------------------- PDAs

export function marketPda(authority, marketId) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('market'), authority.toBuffer(), u64(marketId)], PROGRAM_ID)[0];
}
export function vaultPda(market) {
  return PublicKey.findProgramAddressSync([Buffer.from('vault'), market.toBuffer()], PROGRAM_ID)[0];
}
export function outcomeMintPda(market, i) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('outcome'), market.toBuffer(), Buffer.from([i])], PROGRAM_ID)[0];
}

// --------------------------------------------------------- account decode

export async function fetchMarket(market) {
  const info = await withRetry(() => connection.getAccountInfo(market));
  if (!info) return null;
  const d = info.data;
  const n = d[3];
  const q = [];
  for (let i = 0; i < n; i++) q.push(Number(d.readBigUInt64LE(88 + 8 * i)));
  const bUnits = Number(d.readBigUInt64LE(80));
  const b = bUnits / UNIT;
  const qf = q.map((x) => x / UNIT);
  return {
    address: market,
    n,
    status: d[4] === 0 ? 'open' : 'resolved',
    winner: d[5],
    authority: new PublicKey(d.subarray(8, 40)),
    collateralMint: new PublicKey(d.subarray(40, 72)),
    marketId: Number(d.readBigUInt64LE(72)),
    b,
    q: qf,
    prices: lmsr.prices(qf, b),        // same formula the program runs
  };
}

// ------------------------------------------------------------ instructions

function ix(data, keys) {
  return new TransactionInstruction({ programId: PROGRAM_ID, data, keys });
}
const w = (pubkey, isSigner = false) => ({ pubkey, isSigner, isWritable: true });
const r = (pubkey, isSigner = false) => ({ pubkey, isSigner, isWritable: false });

export function createMarketIx({ authority, collateralMint, marketId, n, b }) {
  const market = marketPda(authority, marketId);
  const bUnits = Math.round(b * UNIT);
  const keys = [
    w(authority, true), w(market), w(vaultPda(market)), r(collateralMint),
    w(getAssociatedTokenAddressSync(collateralMint, authority)),
    r(TOKEN_PROGRAM_ID), r(SystemProgram.programId),
  ];
  for (let i = 0; i < n; i++) keys.push(w(outcomeMintPda(market, i)));
  return { market, ix: ix(Buffer.concat([u8(0), u64(marketId), u8(n), u64(bUnits)]), keys) };
}

function tradeKeys(user, market, collateralMint, outcome) {
  const mint = outcomeMintPda(market, outcome);
  return {
    mint,
    userOutcome: getAssociatedTokenAddressSync(mint, user),
    keys: [
      r(user, true), w(market), w(vaultPda(market)),
      w(getAssociatedTokenAddressSync(collateralMint, user)),
      w(mint), w(getAssociatedTokenAddressSync(mint, user)), r(TOKEN_PROGRAM_ID),
    ],
  };
}

export function buyIx({ user, market, collateralMint, outcome, spend, minShares = 0 }) {
  const t = tradeKeys(user, market, collateralMint, outcome);
  return { ...t, ix: ix(Buffer.concat([u8(1), u8(outcome), u64(spend), u64(minShares)]), t.keys) };
}

export function sellIx({ user, market, collateralMint, outcome, shares, minRefund = 0 }) {
  const t = tradeKeys(user, market, collateralMint, outcome);
  return { ...t, ix: ix(Buffer.concat([u8(2), u8(outcome), u64(shares), u64(minRefund)]), t.keys) };
}

export function resolveIx({ authority, market, winner }) {
  return ix(Buffer.from([3, winner]), [r(authority, true), w(market)]);
}

export function redeemIx({ user, market, collateralMint, winner }) {
  const t = tradeKeys(user, market, collateralMint, winner);
  const keys = t.keys.slice();
  keys[1] = r(market);            // redeem only reads the market
  return ix(Buffer.from([4]), keys);
}

// -------------------------------------------------------------- sending

// Users sign their own trades (they authorize the token movement) but never
// need SOL: the operator is the fee payer. Implementation lives in rpc.js so
// there is exactly one signing-and-retry path in the codebase.
export { sendIxs as send, withRetry } from './rpc.js';

/** Idempotently create the user's token account for a mint (fee payer pays rent). */
export function ensureAtaIx(payer, mint, owner) {
  return createAssociatedTokenAccountIdempotentInstruction(
    payer, getAssociatedTokenAddressSync(mint, owner), owner, mint);
}

export function loadDeployment() {
  const f = path.join(DATA_DIR, 'deployment.json');
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
}
export function saveDeployment(obj) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'deployment.json'), JSON.stringify(obj, null, 2));
}
