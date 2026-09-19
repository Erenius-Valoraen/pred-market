//! LMSR market maker, evaluated on-chain.
//!
//! Token amounts are integers in base units (6 decimals). The math runs in f64:
//! on SBF, floating point is soft-float, so every validator computes the exact
//! same bits and consensus holds.
//!
//! Every conversion back to integers favours the vault: users receive amounts
//! rounded DOWN, and the creator's subsidy is rounded UP. Combined with LMSR's
//! bounded loss (b * ln n), the vault can always pay every winner.

pub const UNIT: f64 = 1_000_000.0;

#[inline]
fn to_f(units: u64) -> f64 {
    units as f64 / UNIT
}

/// Round down to base units; never negative.
#[inline]
pub fn floor_units(x: f64) -> u64 {
    if !(x > 0.0) {
        return 0;
    }
    libm::floor(x * UNIT) as u64
}

/// Round up to base units.
#[inline]
pub fn ceil_units(x: f64) -> u64 {
    if !(x > 0.0) {
        return 0;
    }
    libm::ceil(x * UNIT) as u64
}

/// Numerically stable ln(sum(exp(q_j / b))).
fn log_sum_exp(q: &[u64], b: f64) -> f64 {
    let mut m = f64::NEG_INFINITY;
    for &x in q {
        let z = to_f(x) / b;
        if z > m {
            m = z;
        }
    }
    let mut s = 0.0;
    for &x in q {
        s += libm::exp(to_f(x) / b - m);
    }
    m + libm::log(s)
}

/// Market maker cost function C(q) = b * ln(sum exp(q_j / b)).
pub fn cost(q: &[u64], b: f64) -> f64 {
    b * log_sum_exp(q, b)
}

/// Current probability of outcome i.
pub fn price(q: &[u64], b: f64, i: usize) -> f64 {
    libm::exp(to_f(q[i]) / b - log_sum_exp(q, b))
}

/// Shares of outcome i bought for exactly `spend` base units.
/// Closed form: b * ln(1 + (exp(X/b) - 1) / p_i).
pub fn shares_for_budget(q: &[u64], b: f64, i: usize, spend: u64) -> u64 {
    let x = to_f(spend);
    let p = price(q, b, i);
    floor_units(b * libm::log1p(libm::expm1(x / b) / p))
}

/// Collateral refunded for selling `shares` of outcome i.
pub fn sell_refund(q: &[u64], b: f64, i: usize, shares: u64) -> u64 {
    let before = cost(q, b);
    let mut next = [0u64; crate::state::MAX_OUTCOMES];
    next[..q.len()].copy_from_slice(q);
    next[i] = next[i].saturating_sub(shares);
    floor_units(before - cost(&next[..q.len()], b))
}

/// Deposit the creator must make so the vault covers the worst case.
pub fn required_subsidy(b: f64, n: usize) -> u64 {
    ceil_units(b * libm::log(n as f64))
}

#[cfg(test)]
mod tests {
    use super::*;

    const B: f64 = 100.0;

    #[test]
    fn fresh_market_is_uniform() {
        let q = [0u64; 4];
        for i in 0..4 {
            assert!((price(&q, B, i) - 0.25).abs() < 1e-12);
        }
    }

    #[test]
    fn matches_the_js_reference_engine() {
        // The JS engine (fuzz-tested) bought 255.624 shares for 150 HACK on a
        // 2-outcome market with subsidy 250 in the end-to-end demo.
        let b = 250.0 / core::f64::consts::LN_2;
        let q = [0u64; 2];
        let got = to_f(shares_for_budget(&q, b, 0, 150_000_000));
        assert!((got - 255.624).abs() < 0.001, "on-chain math gave {got}, JS gave 255.624");
    }

    #[test]
    fn buy_then_sell_never_returns_more_than_paid() {
        let mut q = [3_000_000u64, 1_000_000];
        let spend = 40_000_000;
        let d = shares_for_budget(&q, B, 0, spend);
        q[0] += d;
        let back = sell_refund(&q, B, 0, d);
        assert!(back <= spend, "refund {back} exceeded spend {spend}");
        assert!(spend - back < 10, "round trip lost more than rounding dust");
    }

    #[test]
    fn vault_covers_winner_after_one_sided_buying() {
        // Everyone piles into outcome 0; vault must still pay them all.
        let n = 3;
        let b = B;
        let mut q = [0u64; 3];
        let mut vault = required_subsidy(b, n);
        for _ in 0..200 {
            let spend = 7_000_000;
            let d = shares_for_budget(&q, b, 0, spend);
            q[0] += d;
            vault += spend;
        }
        // Winning shares pay 1:1 in base units.
        assert!(vault >= q[0], "vault {vault} < payout {}", q[0]);
    }
}
