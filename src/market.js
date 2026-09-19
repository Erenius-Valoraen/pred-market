// Market engine: LMSR pricing + settlement through a pluggable ledger.
//
// Solvency invariant: the HOUSE's HACK balance never goes negative.
//   * Each market is pre-funded with exactly LMSR's worst-case loss, b*ln(n).
//   * Every rounding favours the house: users receive amounts rounded DOWN.
// With both, a market is solvent by construction regardless of how it trades.

import * as lmsr from './lmsr.js';
import { HOUSE } from './ledger.js';

export const HACK = 'HACK';
export const STARTING_BALANCE = 1000;
const DP = 1e6;                                    // token precision (6 dp)
const down = (x) => Math.floor(x * DP + 1e-9) / DP;
const up = (x) => Math.ceil(x * DP - 1e-9) / DP;

const asset = (marketId, outcome) => `${marketId}:${outcome}`;

export class MarketEngine {
  constructor(ledger, state = null) {
    this.ledger = ledger;
    this.state = state ?? { markets: {}, users: {}, trades: [], seq: 0 };
  }

  // ---------------------------------------------------------------- users

  /** Join the market. Idempotent: re-registering never double-mints. */
  async register({ badgeId, name, team = [] }) {
    if (!badgeId) throw new Error('badgeId required');
    const existing = this.state.users[badgeId];
    if (existing) {
      if (team.length) existing.team = team;
      return { user: existing, fresh: false };
    }
    const user = { badgeId, name: name ?? badgeId, team, joinedAt: Date.now() };
    this.state.users[badgeId] = user;
    await this.ledger.mint(HACK, badgeId, STARTING_BALANCE);
    return { user, fresh: true };
  }

  #user(badgeId) {
    const u = this.state.users[badgeId];
    if (!u) throw new Error(`unknown user ${badgeId} - register first`);
    return u;
  }

  // -------------------------------------------------------------- markets

  async createMarket({ id, question, outcomes = ['YES', 'NO'], subsidy = 200, meta = {} }) {
    if (!question) throw new Error('question required');
    if (outcomes.length < 2) throw new Error('need at least 2 outcomes');
    const mid = id ?? `m${++this.state.seq}`;
    if (this.state.markets[mid]) throw new Error(`market ${mid} already exists`);
    const b = lmsr.bForSubsidy(subsidy, outcomes.length);
    const market = {
      id: mid, question, outcomes, q: outcomes.map(() => 0), b, subsidy,
      status: 'open', winner: null, volume: 0, createdAt: Date.now(), meta,
    };
    this.state.markets[mid] = market;
    // Fund the house with exactly the worst case it can lose on this market.
    await this.ledger.mint(HACK, HOUSE, up(lmsr.maxLoss(b, outcomes.length)));
    return market;
  }

  #market(marketId) {
    const m = this.state.markets[marketId];
    if (!m) throw new Error(`unknown market ${marketId}`);
    return m;
  }

  #open(m) {
    if (m.status !== 'open') throw new Error(`market ${m.id} is ${m.status}`);
  }

  #outcome(m, outcome) {
    if (!Number.isInteger(outcome) || outcome < 0 || outcome >= m.outcomes.length) {
      throw new Error(`outcome ${outcome} invalid for ${m.id}`);
    }
  }

  quote(marketId) {
    const m = this.#market(marketId);
    return lmsr.prices(m.q, m.b);
  }

  // --------------------------------------------------------------- trading

  /** Spend `spend` HACK on `outcome`. Returns shares received. */
  async buy({ badgeId, marketId, outcome, spend }) {
    this.#user(badgeId);
    const m = this.#market(marketId);
    this.#open(m);
    this.#outcome(m, outcome);
    const cost = up(spend);
    if (!(cost > 0)) throw new Error('spend must be positive');
    const have = await this.ledger.balance(HACK, badgeId);
    if (have + 1e-9 < cost) throw new Error(`insufficient HACK: have ${have}, need ${cost}`);

    const before = lmsr.prices(m.q, m.b);
    const shares = down(lmsr.sharesForBudget(m.q, m.b, outcome, cost));
    if (!(shares > 0)) throw new Error('trade too small');

    await this.ledger.transfer(HACK, badgeId, HOUSE, cost);
    await this.ledger.mint(asset(m.id, outcome), badgeId, shares);
    m.q[outcome] += shares;
    m.volume += cost;
    const after = lmsr.prices(m.q, m.b);
    this.state.trades.push({ t: Date.now(), badgeId, marketId, outcome, side: 'buy', cost, shares });
    return { shares, cost, before, after };
  }

  /** Sell `shares` of `outcome` back to the maker. Returns HACK refunded. */
  async sell({ badgeId, marketId, outcome, shares }) {
    this.#user(badgeId);
    const m = this.#market(marketId);
    this.#open(m);
    this.#outcome(m, outcome);
    const held = await this.ledger.balance(asset(m.id, outcome), badgeId);
    if (!(shares > 0) || held + 1e-9 < shares) {
      throw new Error(`cannot sell ${shares}: holding ${held}`);
    }
    const refund = down(lmsr.sellRefund(m.q, m.b, outcome, shares));
    await this.ledger.burn(asset(m.id, outcome), badgeId, shares);
    await this.ledger.transfer(HACK, HOUSE, badgeId, refund);
    m.q[outcome] -= shares;
    m.volume += refund;
    this.state.trades.push({ t: Date.now(), badgeId, marketId, outcome, side: 'sell', refund, shares });
    return { refund, after: lmsr.prices(m.q, m.b) };
  }

  // ------------------------------------------------------------ resolution

  async resolve(marketId, winner) {
    const m = this.#market(marketId);
    this.#open(m);
    this.#outcome(m, winner);
    m.status = 'resolved';
    m.winner = winner;
    m.resolvedAt = Date.now();
    return m;
  }

  /** Each winning share pays exactly 1 HACK. Losing shares pay nothing. */
  async redeem({ badgeId, marketId }) {
    const m = this.#market(marketId);
    if (m.status !== 'resolved') throw new Error(`market ${m.id} not resolved`);
    const a = asset(m.id, m.winner);
    const shares = await this.ledger.balance(a, badgeId);
    if (!(shares > 0)) return { payout: 0 };
    const payout = down(shares);
    await this.ledger.burn(a, badgeId, shares);
    await this.ledger.transfer(HACK, HOUSE, badgeId, payout);
    return { payout };
  }

  // ------------------------------------------------------------- read side

  async portfolio(badgeId) {
    this.#user(badgeId);
    const cash = await this.ledger.balance(HACK, badgeId);
    const positions = [];
    let marked = cash;
    for (const m of Object.values(this.state.markets)) {
      const p = lmsr.prices(m.q, m.b);
      for (let i = 0; i < m.outcomes.length; i++) {
        const sh = await this.ledger.balance(asset(m.id, i), badgeId);
        if (sh > 0) {
          const value = m.status === 'resolved' ? (i === m.winner ? sh : 0) : sh * p[i];
          positions.push({ marketId: m.id, outcome: m.outcomes[i], shares: sh, value });
          marked += value;
        }
      }
    }
    return { cash, positions, netWorth: marked };
  }

  async leaderboard() {
    const rows = [];
    for (const u of Object.values(this.state.users)) {
      const { netWorth } = await this.portfolio(u.badgeId);
      rows.push({ badgeId: u.badgeId, name: u.name, netWorth });
    }
    return rows.sort((a, b) => b.netWorth - a.netWorth);
  }
}
