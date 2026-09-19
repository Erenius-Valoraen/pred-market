import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MarketEngine, HACK, STARTING_BALANCE } from '../src/market.js';
import { MemoryLedger, HOUSE } from '../src/ledger.js';

const fresh = () => new MarketEngine(new MemoryLedger());

test('register mints the starting balance exactly once', async () => {
  const e = fresh();
  assert.equal((await e.register({ badgeId: 'a', name: 'Ada' })).fresh, true);
  assert.equal((await e.register({ badgeId: 'a', name: 'Ada' })).fresh, false);
  assert.equal(await e.ledger.balance(HACK, 'a'), STARTING_BALANCE);
});

test('buying moves HACK to the house, mints shares, and moves the price', async () => {
  const e = fresh();
  await e.register({ badgeId: 'a' });
  const m = await e.createMarket({ question: 'Does QNX win?', subsidy: 100 });
  const r = await e.buy({ badgeId: 'a', marketId: m.id, outcome: 0, spend: 50 });
  assert.equal(await e.ledger.balance(HACK, 'a'), STARTING_BALANCE - 50);
  assert.equal(await e.ledger.balance(`${m.id}:0`, 'a'), r.shares);
  assert.ok(r.after[0] > r.before[0], 'YES price should rise');
  assert.ok(r.shares > 50, 'at p<1 you get more than one share per HACK');
});

test('winners are paid 1 HACK per share; losers get nothing', async () => {
  const e = fresh();
  await e.register({ badgeId: 'yes' });
  await e.register({ badgeId: 'no' });
  const m = await e.createMarket({ question: 'Q', subsidy: 100 });
  const y = await e.buy({ badgeId: 'yes', marketId: m.id, outcome: 0, spend: 40 });
  await e.buy({ badgeId: 'no', marketId: m.id, outcome: 1, spend: 40 });
  await e.resolve(m.id, 0);
  const py = await e.redeem({ badgeId: 'yes', marketId: m.id });
  const pn = await e.redeem({ badgeId: 'no', marketId: m.id });
  assert.ok(Math.abs(py.payout - y.shares) < 1e-6);
  assert.equal(pn.payout, 0);
});

test('guards: no trading after resolution, no double redeem, no overspend', async () => {
  const e = fresh();
  await e.register({ badgeId: 'a' });
  const m = await e.createMarket({ question: 'Q' });
  await assert.rejects(e.buy({ badgeId: 'a', marketId: m.id, outcome: 0, spend: 1e9 }), /insufficient/);
  await assert.rejects(e.redeem({ badgeId: 'a', marketId: m.id }), /not resolved/);
  await e.buy({ badgeId: 'a', marketId: m.id, outcome: 0, spend: 10 });
  await e.resolve(m.id, 0);
  await assert.rejects(e.buy({ badgeId: 'a', marketId: m.id, outcome: 0, spend: 1 }), /resolved/);
  const first = await e.redeem({ badgeId: 'a', marketId: m.id });
  const second = await e.redeem({ badgeId: 'a', marketId: m.id });
  assert.ok(first.payout > 0);
  assert.equal(second.payout, 0, 'redeeming twice must pay nothing the second time');
});

test('cannot sell shares you do not hold', async () => {
  const e = fresh();
  await e.register({ badgeId: 'a' });
  const m = await e.createMarket({ question: 'Q' });
  await assert.rejects(e.sell({ badgeId: 'a', marketId: m.id, outcome: 0, shares: 5 }), /cannot sell/);
});

test('SOLVENCY FUZZ: house never goes negative for any trade history or winner', async () => {
  // Deterministic PRNG so failures are reproducible.
  let s = 12345;
  const rnd = () => ((s = (s * 1103515245 + 12345) >>> 0) / 2 ** 32);

  for (let trial = 0; trial < 40; trial++) {
    const nOut = 2 + Math.floor(rnd() * 4);                 // 2..5 outcomes
    const users = Array.from({ length: 6 }, (_, i) => `u${i}`);

    // Replay the SAME random trade history once per possible winner.
    for (let winner = 0; winner < nOut; winner++) {
      const e = fresh();
      s = 1000 + trial;                                       // same history each time
      for (const u of users) await e.register({ badgeId: u });
      const m = await e.createMarket({
        question: `trial ${trial}`, outcomes: Array.from({ length: nOut }, (_, i) => `o${i}`),
        subsidy: 20 + rnd() * 300,
      });

      for (let k = 0; k < 60; k++) {
        const u = users[Math.floor(rnd() * users.length)];
        const o = Math.floor(rnd() * nOut);
        const held = await e.ledger.balance(`${m.id}:${o}`, u);
        try {
          if (held > 0 && rnd() < 0.35) {
            await e.sell({ badgeId: u, marketId: m.id, outcome: o, shares: held * (0.2 + rnd() * 0.8) });
          } else {
            const cash = await e.ledger.balance(HACK, u);
            await e.buy({ badgeId: u, marketId: m.id, outcome: o, spend: Math.min(cash, 1 + rnd() * 120) });
          }
        } catch { /* insufficient funds / too small: fine, skip */ }
        assert.ok((await e.ledger.balance(HACK, HOUSE)) >= -1e-6, 'house negative mid-trading');
      }

      await e.resolve(m.id, winner);
      for (const u of users) await e.redeem({ badgeId: u, marketId: m.id });
      const house = await e.ledger.balance(HACK, HOUSE);
      assert.ok(house >= -1e-6,
        `house insolvent: ${house} (trial ${trial}, ${nOut} outcomes, winner ${winner})`);
    }
  }
});

test('conservation: trades only move HACK, they never create it', async () => {
  const e = fresh();
  const users = ['a', 'b', 'c'];
  for (const u of users) await e.register({ badgeId: u });
  const m = await e.createMarket({ question: 'Q', subsidy: 150 });
  const total = async () => {
    let t = await e.ledger.balance(HACK, HOUSE);
    for (const u of users) t += await e.ledger.balance(HACK, u);
    return t;
  };
  const t0 = await total();
  await e.buy({ badgeId: 'a', marketId: m.id, outcome: 0, spend: 80 });
  await e.buy({ badgeId: 'b', marketId: m.id, outcome: 1, spend: 60 });
  const held = await e.ledger.balance(`${m.id}:0`, 'a');
  await e.sell({ badgeId: 'a', marketId: m.id, outcome: 0, shares: held / 2 });
  assert.ok(Math.abs((await total()) - t0) < 1e-6, 'HACK was created or destroyed by trading');
});
