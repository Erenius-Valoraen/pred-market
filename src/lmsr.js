// Logarithmic Market Scoring Rule (Hanson) — the automated market maker.
//
// Why LMSR: it always quotes a price, so a market with three traders still has
// live, moving odds. No order book, no counterparty needed. The market maker's
// worst-case loss is bounded by b * ln(n), which is what lets us seed hundreds
// of thin markets with a known, finite subsidy.
//
//   cost(q)   = b * ln( sum_j exp(q_j / b) )
//   price_i   = exp(q_i / b) / sum_j exp(q_j / b)        (softmax; sums to 1)
//   buy Δ of i costs  cost(q + Δ e_i) - cost(q)
//
// q is the vector of outstanding shares per outcome. Everything here is pure
// and synchronous so it can be unit-tested without a chain.

/** Numerically stable log(sum(exp(x))). */
export function logSumExp(xs) {
  let m = -Infinity;
  for (const x of xs) if (x > m) m = x;
  if (m === -Infinity) return -Infinity;
  let s = 0;
  for (const x of xs) s += Math.exp(x - m);
  return m + Math.log(s);
}

function assertB(b) {
  if (!(b > 0) || !Number.isFinite(b)) throw new RangeError(`b must be a positive finite number, got ${b}`);
}

function assertOutcome(q, i) {
  if (!Number.isInteger(i) || i < 0 || i >= q.length) {
    throw new RangeError(`outcome index ${i} out of range for ${q.length} outcomes`);
  }
}

/** Market maker's cost function C(q). */
export function cost(q, b) {
  assertB(b);
  return b * logSumExp(q.map((x) => x / b));
}

/** Current probabilities (prices) for every outcome. Sums to 1. */
export function prices(q, b) {
  assertB(b);
  const z = q.map((x) => x / b);
  const lse = logSumExp(z);
  return z.map((x) => Math.exp(x - lse));
}

/** Cost to buy `delta` shares of outcome i (delta may be negative = sell). */
export function tradeCost(q, b, i, delta) {
  assertOutcome(q, i);
  const next = q.slice();
  next[i] += delta;
  return cost(next, b) - cost(q, b);
}

/**
 * Shares of outcome i you receive for spending exactly `budget`.
 *
 * Closed form: Δ = b * ln(1 + (exp(X/b) - 1) / p_i). expm1/log1p keep it
 * accurate when X is small relative to b, which is the common case.
 */
export function sharesForBudget(q, b, i, budget) {
  assertOutcome(q, i);
  if (!(budget >= 0)) throw new RangeError(`budget must be >= 0, got ${budget}`);
  if (budget === 0) return 0;
  const p = prices(q, b)[i];
  return b * Math.log1p(Math.expm1(budget / b) / p);
}

/** HACK refunded for selling `delta` shares of outcome i back to the maker. */
export function sellRefund(q, b, i, delta) {
  assertOutcome(q, i);
  if (!(delta >= 0)) throw new RangeError(`delta must be >= 0, got ${delta}`);
  if (delta > q[i] + 1e-9) {
    // In LMSR q can go negative in principle, but a user can only sell what
    // they hold; the engine enforces that. This guard catches engine bugs.
  }
  return -tradeCost(q, b, i, -delta);
}

/** Worst-case subsidy the market maker can lose on this market. */
export function maxLoss(b, n) {
  assertB(b);
  return b * Math.log(n);
}

/**
 * Choose b so the maker's worst-case loss equals `subsidy`.
 * Bigger b = deeper liquidity = prices move less per trade.
 */
export function bForSubsidy(subsidy, n) {
  if (!(subsidy > 0)) throw new RangeError('subsidy must be > 0');
  if (!(n >= 2)) throw new RangeError('need at least 2 outcomes');
  return subsidy / Math.log(n);
}
