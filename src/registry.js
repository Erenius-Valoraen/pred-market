// The market registry: ONE code path for creating and resolving markets,
// shared by the seed script, the admin page, and (later) the badge bridge.
//
// Trust: the chain stores numbers; humans read a question. To stop anyone
// (including us) quietly rewording a question after people have bet, the
// transaction that CREATES a market also writes a SPL Memo:
//     htnmkt:v1 <market address> sha256=<hash of the canonical metadata>
// Anyone can recompute the hash from the displayed text and check it against
// that memo on the explorer. Same transaction, so it is atomic with creation.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { TransactionInstruction, PublicKey } from '@solana/web3.js';
import { mintAmount, DATA_DIR } from './chain.js';
import { connection, withRetry, sendIxs } from './rpc.js';
import { createMarketIx, marketPda, resolveIx } from './client.js';

export const MARKETS_FILE = path.join(DATA_DIR, 'markets.json');

/** A problem with the request (HTTP 400), as opposed to a server fault (500). */
export class UserError extends Error {
  constructor(message) { super(message); this.status = 400; }
}
const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

export const TEAM_SUBSIDY = 100;   // per-team market; b = 100/ln2 ≈ 144

// ----------------------------------------------------------------- storage
export function loadMarkets() {
  return fs.existsSync(MARKETS_FILE) ? JSON.parse(fs.readFileSync(MARKETS_FILE, 'utf8')) : [];
}

export function saveMarkets(list) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${MARKETS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, MARKETS_FILE);
}

/** Stable numeric market id from a slug, so re-runs find the same PDA. */
export function marketIdFor(slug) {
  return createHash('sha256').update(`htn2026:${slug}`).digest().readBigUInt64LE(0) >> 1n;
}

export function slugify(s) {
  return String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 24) || 'team';
}

// ------------------------------------------------------------- commitment
/** The exact fields a trader relies on. Order is fixed so the hash is stable. */
export function canonicalMetadata(m) {
  return JSON.stringify({
    slug: m.slug, question: m.question, outcomes: m.outcomes,
    resolves: m.resolves ?? '', team: m.team ?? null,
  });
}
export function commitmentHash(m) {
  return createHash('sha256').update(canonicalMetadata(m)).digest('hex');
}

function memoIx(text, signer) {
  return new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: [{ pubkey: signer, isSigner: true, isWritable: false }],
    data: Buffer.from(text, 'utf8'),
  });
}

// ----------------------------------------------------------------- create
/**
 * Create a market on-chain (idempotent) and return its metadata record.
 * `def`: { slug, question, outcomes, subsidy, resolves?, kind?, team? }
 */
export async function ensureMarket(op, hack, def) {
  const id = marketIdFor(def.slug);
  const address = marketPda(op.publicKey, id);
  const exists = await withRetry(() => connection.getAccountInfo(address));
  const n = def.outcomes.length;
  const record = {
    slug: def.slug,
    address: address.toBase58(),
    marketId: id.toString(),
    question: def.question,
    outcomes: def.outcomes,
    subsidy: def.subsidy,
    resolves: def.resolves ?? '',
    kind: def.kind ?? 'seed',
    team: def.team ?? null,
  };
  if (exists) return { ...record, created: 'existing' };

  const hash = commitmentHash(record);
  // The program pulls b*ln(n) (rounded up) from the operator; mint a margin.
  await mintAmount(op, hack, op.publicKey, def.subsidy + 1);
  const { ix } = createMarketIx({
    authority: op.publicKey, collateralMint: hack, marketId: id, n, b: def.subsidy / Math.log(n),
  });
  const sig = await sendIxs(op, [ix, memoIx(`htnmkt:v1 ${record.address} sha256=${hash}`, op.publicKey)]);
  return { ...record, commitment: hash, createSig: sig, createdAt: Date.now(), created: 'new' };
}

// --------------------------------------------------------------- teams
/** badge_id -> team name, for every badge-verified member of every team. */
export function teamOfBadge(list = loadMarkets()) {
  const map = new Map();
  for (const m of list) {
    if (m.kind !== 'team') continue;
    for (const mem of m.team?.members ?? []) {
      if (mem.badgeId) map.set(mem.badgeId, m.team.name);
    }
  }
  return map;
}

/**
 * Register a team and open its market. Members may carry a badge_id: the
 * phone form supplies names only; the badge bridge will supply verified ids.
 */
export async function registerTeam(op, hack, input) {
  const team = String(input.team ?? '').trim().slice(0, 48);
  if (!team) throw new UserError('team name required');
  const project = String(input.project ?? '').trim().slice(0, 80);
  const table = String(input.table ?? '').trim().slice(0, 12);
  const members = (Array.isArray(input.members) ? input.members : [])
    .slice(0, 8)
    .map((m) => (typeof m === 'string' ? { name: m } : m))
    .map((m) => ({
      name: String(m?.name ?? '').trim().slice(0, 32),
      badgeId: m?.badgeId ? String(m.badgeId).trim().slice(0, 48) : null,
    }))
    .filter((m) => m.name);

  const list = loadMarkets();
  const dupe = list.find((m) => m.kind === 'team' && m.team?.name.toLowerCase() === team.toLowerCase());
  if (dupe) return { market: dupe, duplicate: true };

  // One person, one team. Only enforceable for members whose identity came
  // from a badge bump (names typed on the phone aren't verified identities).
  const onTeam = teamOfBadge(list);
  const clash = members.filter((m) => m.badgeId && onTeam.has(m.badgeId));
  if (clash.length) {
    throw new UserError(clash.map((m) => `${m.name} is already on ${onTeam.get(m.badgeId)}`).join('; '));
  }

  // Unique slug even if two teams share a name after slugification.
  let slug = `team-${slugify(team)}`;
  for (let k = 2; list.some((m) => m.slug === slug); k++) slug = `team-${slugify(team)}-${k}`;

  const rec = await ensureMarket(op, hack, {
    slug,
    question: `Will ${team} win a prize?`,
    outcomes: ['YES', 'NO'],
    subsidy: TEAM_SUBSIDY,
    resolves: 'YES if this team wins any prize (sponsor track or finalist) at Hack the North 2026.',
    kind: 'team',
    team: { name: team, project, table, members },
  });
  saveMarkets([...list, rec]);
  return { market: rec, duplicate: false };
}

// ------------------------------------------------------------ resolution
export async function resolveMarket(op, slug, winner) {
  const list = loadMarkets();
  const m = list.find((x) => x.slug === slug);
  if (!m) throw new UserError(`unknown market ${slug}`);
  if (!Number.isInteger(winner) || winner < 0 || winner >= m.outcomes.length) {
    throw new UserError(`winner must be 0..${m.outcomes.length - 1}`);
  }
  const sig = await sendIxs(op, [resolveIx({ authority: op.publicKey, market: new PublicKey(m.address), winner })]);
  Object.assign(m, { resolvedWinner: winner, resolveSig: sig, resolvedAt: Date.now() });
  saveMarkets(list);
  return { market: m, signature: sig };
}
