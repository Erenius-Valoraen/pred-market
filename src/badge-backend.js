// Chain backend for badge traders (see src/terminal.js).
//
// A badge can't sign Solana transactions (badge Lua has no crypto), so each
// badge gets its own keypair held here, keyed by the badge's radio address.
// Every trade is still a real, individually-signed on-chain transaction from
// that badge's own wallet into the public market program; the operator only
// pays fees and rent. This is custodial for badge users and we say so.

import fs from 'node:fs';
import path from 'node:path';
import { Keypair, PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, createTransferInstruction } from '@solana/spl-token';
import { DATA_DIR, UNIT, mintAmount } from './chain.js';
import { connection, withRetry, sendIxs } from './rpc.js';
import { buyIx, sellIx, ensureAtaIx, outcomeMintPda, fetchMarket } from './client.js';
import * as lmsr from './lmsr.js';

const WALLETS_FILE = path.join(DATA_DIR, 'badge-wallets.json');
export const START_HACK = 1000;
const SLIPPAGE = 0.97;
const units = (x) => BigInt(Math.floor(x * UNIT));

export function createBadgeBackend({ op, hack, marketStates, onWallet = () => {} }) {
  const wallets = fs.existsSync(WALLETS_FILE) ? JSON.parse(fs.readFileSync(WALLETS_FILE, 'utf8')) : {};
  const save = () => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(WALLETS_FILE, JSON.stringify(wallets, null, 1), { mode: 0o600 });
  };
  const keypair = (mac) => Keypair.fromSecretKey(Uint8Array.from(wallets[mac].secret));

  // Market list, refreshed in the background so key presses answer instantly.
  let markets = [];
  let boardRows = [];
  const mintIndex = new Map();        // outcome mint -> [slug, i]
  async function refresh() {
    const list = (await marketStates()).filter((m) => !m.missing);
    for (const m of list) {
      m.outcomes.forEach((_, i) => mintIndex.set(outcomeMintPda(new PublicKey(m.address), i).toBase58(), [m.slug, i]));
    }
    markets = list;
  }
  const tick = () => refresh().catch((e) => console.error('[badges] market refresh:', e.message));
  tick();
  setInterval(tick, 12_000).unref();   // public devnet RPC rate-limits heavy reads

  async function ensureWallet(mac, name) {
    let fresh = false;
    if (!wallets[mac]) {
      wallets[mac] = { secret: Array.from(Keypair.generate().secretKey), name, created: Date.now(), funded: false };
      save();
    }
    const w = wallets[mac];
    if (name && w.name !== name) { w.name = name; save(); }
    const kp = keypair(mac);
    if (!w.funded) {
      await mintAmount(op, hack, kp.publicKey, START_HACK);
      w.funded = true;
      fresh = true;
      save();
      onWallet(kp.publicKey.toBase58(), w.name || `badge ${mac.slice(-5)}`);
    }
    return { kp, fresh };
  }

  async function account(mac, name) {
    const { kp, fresh } = await ensureWallet(mac, name);
    const res = await withRetry(() => connection.getParsedTokenAccountsByOwner(kp.publicKey, { programId: TOKEN_PROGRAM_ID }));
    let cash = 0;
    const shares = {};
    for (const a of res.value) {
      const t = a.account.data.parsed.info;
      const amt = Number(t.tokenAmount.amount) / UNIT;
      if (t.mint === hack.toBase58()) cash += amt;
      const hit = mintIndex.get(t.mint);
      if (hit) (shares[hit[0]] ??= [])[hit[1]] = amt;
    }
    return { cash, shares, fresh, wallet: kp.publicKey.toBase58() };
  }

  const bySlug = (slug) => {
    const m = markets.find((x) => x.slug === slug);
    if (!m) throw new Error('unknown market');
    return m;
  };

  async function buy(mac, slug, outcome, spend) {
    const kp = keypair(mac);
    const m = bySlug(slug);
    const market = new PublicKey(m.address);
    const live = await fetchMarket(market);           // quote against fresh state
    const quote = lmsr.sharesForBudget(live.q, live.b, outcome, spend);
    const b = buyIx({ user: kp.publicKey, market, collateralMint: hack, outcome,
      spend: units(spend), minShares: units(quote * SLIPPAGE) });
    await sendIxs(op, [ensureAtaIx(op.publicKey, b.mint, kp.publicKey), b.ix], [kp]);
    await tick();                                     // show the new price right away
    return { shares: quote };
  }

  async function sell(mac, slug, outcome, shares) {
    const kp = keypair(mac);
    const m = bySlug(slug);
    const market = new PublicKey(m.address);
    const live = await fetchMarket(market);
    const refund = lmsr.sellRefund(live.q, live.b, outcome, shares);
    const s = sellIx({ user: kp.publicKey, market, collateralMint: hack, outcome,
      shares: units(shares), minRefund: units(refund * SLIPPAGE) });
    await sendIxs(op, [s.ix], [kp]);
    await tick();
    return { refund };
  }

  /** Tap to pay: one badge hands play money to another, on-chain. */
  async function transfer(fromMac, toMac, amount) {
    const from = keypair(fromMac);
    const to = keypair(toMac);
    const dst = getAssociatedTokenAddressSync(hack, to.publicKey);
    await sendIxs(op, [
      ensureAtaIx(op.publicKey, hack, to.publicKey),
      createTransferInstruction(getAssociatedTokenAddressSync(hack, from.publicKey), dst,
        from.publicKey, units(amount)),
    ], [from]);
    return { amount };
  }

  return {
    markets: () => markets,
    account, buy, sell, transfer,
    board: () => boardRows,
    setBoard(rows) {
      const macOf = new Map(Object.entries(wallets).map(([mac, w]) =>
        [Keypair.fromSecretKey(Uint8Array.from(w.secret)).publicKey.toBase58(), mac]));
      boardRows = rows.map((r) => ({ ...r, mac: macOf.get(r.wallet) }));
    },
  };
}
