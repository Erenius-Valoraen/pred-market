import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  logSumExp, cost, prices, tradeCost, sharesForBudget,
  sellRefund, maxLoss, bForSubsidy,
} from '../src/lmsr.js';

const close = (a, b, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b)),
    `expected ${a} ≈ ${b}`);

test('fresh market quotes uniform prices', () => {
  for (const n of [2, 3, 7]) {
    const p = prices(new Array(n).fill(0), 100);
    p.forEach((x) => close(x, 1 / n));
  }
});

test('prices always sum to 1', () => {
  const p = prices([12.5, -3, 40, 0.1], 25);
  close(p.reduce((a, b) => a + b, 0), 1);
});

test('spending exactly the budget: tradeCost(sharesForBudget(X)) === X', () => {
  const q = [10, 0, -4];
  for (const X of [0.001, 1, 25, 500]) {
    const d = sharesForBudget(q, 50, 1, X);
    close(tradeCost(q, 50, 1, d), X, 1e-9);
  }
});

test('buying an outcome raises its price and lowers the others', () => {
  const b = 100;
  const q = [0, 0, 0];
  const before = prices(q, b);
  q[0] += sharesForBudget(q, b, 0, 30);
  const after = prices(q, b);
  assert.ok(after[0] > before[0]);
  assert.ok(after[1] < before[1] && after[2] < before[2]);
});

test('buy then sell the same shares is a round trip (no free money)', () => {
  const b = 80;
  const q = [5, 2];
  const d = sharesForBudget(q, b, 0, 40);
  const q2 = q.slice(); q2[0] += d;
  close(sellRefund(q2, b, 0, d), 40, 1e-9);
});

test('shares are worth at most 1 each: you pay >= price * shares', () => {
  // Buying d shares at a rising price must cost more than d * starting price
  // and less than d (each share pays out at most 1 on resolution).
  const b = 100;
  const q = [0, 0];
  const d = sharesForBudget(q, b, 0, 50);
  const p0 = prices(q, b)[0];
  assert.ok(50 > d * p0, 'cost exceeds shares * starting price');
  assert.ok(50 < d, 'cost stays below the max payout of those shares');
});

test('maker loss is bounded by b ln n even when one outcome is bought out', () => {
  const b = 100, n = 4;
  const q = new Array(n).fill(0);
  // Buy outcome 0 essentially to certainty.
  const paid = tradeCost(q, b, 0, 5000);
  // If outcome 0 wins the maker pays out 5000 per share held.
  const makerLoss = 5000 - paid;
  assert.ok(makerLoss <= maxLoss(b, n) + 1e-6,
    `loss ${makerLoss} exceeded bound ${maxLoss(b, n)}`);
  close(makerLoss, maxLoss(b, n), 1e-6); // approaches the bound
});

test('numerically stable for large share counts', () => {
  const p = prices([1e6, 1e6 + 10, -1e6], 5);
  p.forEach((x) => assert.ok(Number.isFinite(x)));
  close(p.reduce((a, b) => a + b, 0), 1);
  assert.ok(Number.isFinite(cost([1e6, 0], 1)));
  close(logSumExp([1000, 1000]), 1000 + Math.log(2));
});

test('bForSubsidy inverts maxLoss', () => {
  for (const n of [2, 5, 12]) close(maxLoss(bForSubsidy(250, n), n), 250);
});

test('rejects bad inputs', () => {
  assert.throws(() => prices([0, 0], 0), RangeError);
  assert.throws(() => sharesForBudget([0, 0], 10, 2, 5), RangeError);
  assert.throws(() => sharesForBudget([0, 0], 10, 0, -1), RangeError);
});
