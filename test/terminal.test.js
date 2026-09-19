import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Terminal, BTN, ROWS, WIDTH, tagOf } from '../src/terminal.js';

const MAC = 'E8:F6:0A:29:D3:F4';
const TAG = '29D3F4';

function fake() {
  const markets = [
    { slug: 'team-aurora', kind: 'team', team: { name: 'Aurora' }, question: 'Will Aurora win a prize?',
      outcomes: ['YES', 'NO'], prices: [0.42, 0.58], status: 'open' },
    { slug: 'grand', kind: 'seed', question: 'What kind of project wins Best Overall? (long question here)',
      outcomes: ['AI', 'Hardware', 'Web', 'Dev tools', 'Other'], prices: [0.3, 0.2, 0.2, 0.2, 0.1], status: 'open' },
  ];
  const acct = { cash: 1000, shares: {}, fresh: true };
  const calls = [];
  return {
    calls,
    backend: {
      markets: () => markets,
      account: async () => ({ ...acct, shares: { ...acct.shares } }),
      buy: async (mac, slug, i, spend) => {
        calls.push(['buy', slug, i, spend]);
        acct.cash -= spend;
        (acct.shares[slug] ??= [0, 0])[i] += spend * 1.5;
        acct.fresh = false;
        return { shares: spend * 1.5 };
      },
      sell: async (mac, slug, i, shares) => {
        calls.push(['sell', slug, i, shares]);
        acct.shares[slug][i] = 0;
        acct.cash += shares * 0.4;
        return { refund: shares * 0.4 };
      },
      board: () => [{ name: 'Abhi', netWorth: 1010, mac: MAC }, { name: 'Nathan', netWorth: 990 }],
    },
  };
}

const settle = () => new Promise((r) => setTimeout(r, 10));
const decode = (frames) => frames.map((f) => ({ tag: f.slice(3, 9), row: Number(f[9]), text: f.slice(10) }));

test('tag is the last 6 hex digits of the radio address', () => {
  assert.equal(tagOf(MAC), TAG);
  assert.equal(tagOf('e8:f6:0a:29:d3:f4'), TAG);
});

test('hello draws a full screen, frames fit the 44-byte radio payload', async () => {
  const { backend } = fake();
  const emitted = [];
  const t = new Terminal(backend, (f) => emitted.push(...f));
  const frames = await t.handle(MAC, 'HMK1HAbhi Dutta');
  assert.equal(frames.length, ROWS);
  for (const f of [...frames, ...emitted]) {
    assert.ok(f.startsWith(`HMD${TAG}`));
    assert.ok(Buffer.byteLength(f) <= 44, `${f} is ${f.length} bytes`);
  }
  await settle();
  const after = decode(emitted);
  assert.ok(after.some((x) => x.row === 0 && /1,000 HACK/.test(x.text)));
  assert.ok(after.some((x) => /Welcome Abhi!/.test(x.text)));
});

test('only changed rows are resent; a retried press resends everything', async () => {
  const { backend } = fake();
  const t = new Terminal(backend, () => {});
  await t.handle(MAC, 'HMK1H');
  await settle();
  const moved = decode(await t.handle(MAC, `HMK2${BTN.DOWN}`));
  assert.deepEqual(moved.map((x) => x.row).sort(), [1, 2]);       // cursor moved between rows 1 and 2
  const retry = await t.handle(MAC, `HMK2${BTN.DOWN}`);            // same seq = the badge missed our reply
  assert.equal(retry.length, ROWS);
  assert.ok(decode(retry).some((x) => x.row === 2 && x.text.startsWith('>')), 'retry must not move again');
});

test('buy then sell from the badge', async () => {
  const { backend, calls } = fake();
  const emitted = [];
  const t = new Terminal(backend, (f) => emitted.push(...f));
  await t.handle(MAC, 'HMK1H');
  await settle();
  await t.handle(MAC, `HMK2${BTN.A}`);                  // open Aurora
  await t.handle(MAC, `HMK3${BTN.RIGHT}`);              // spend 50 -> 100
  const buying = decode(await t.handle(MAC, `HMK4${BTN.A}`));
  assert.ok(buying.some((x) => /Buying YES with 100/.test(x.text)));
  await settle();
  assert.deepEqual(calls[0], ['buy', 'team-aurora', 0, 100]);
  const done = decode(emitted);
  assert.ok(done.some((x) => /Bought 150 YES for 100/.test(x.text)));
  assert.ok(done.some((x) => /> YES x150/.test(x.text)));

  emitted.length = 0;
  await t.handle(MAC, `HMK5${BTN.START}`);
  await settle();
  assert.deepEqual(calls[1], ['sell', 'team-aurora', 0, 150]);
  assert.ok(decode(emitted).some((x) => /Sold for 60/.test(x.text)));
});

test('cannot overspend; long questions wrap and stay within width', async () => {
  const { backend, calls } = fake();
  const t = new Terminal(backend, () => {});
  await t.handle(MAC, 'HMK1H');
  await settle();
  await t.handle(MAC, `HMK2${BTN.DOWN}`);
  await t.handle(MAC, `HMK3${BTN.A}`);                  // open the 5-outcome market
  for (let i = 4; i < 9; i++) await t.handle(MAC, `HMK${i}${BTN.RIGHT}`);   // max spend 500
  const s = t.session(MAC);
  s.acct.cash = 100;
  const r = decode(await t.handle(MAC, `HMK9${BTN.A}`));
  assert.ok(r.some((x) => /Not enough HACK for 500/.test(x.text)));
  assert.equal(calls.length, 0);
  for (const line of t.lines(s)) assert.ok(line.length <= WIDTH);
  assert.ok(t.lines(s)[1].length > 0, 'question continues on row 1');
});

test('leaderboard view marks you', async () => {
  const { backend } = fake();
  const t = new Terminal(backend, () => {});
  await t.handle(MAC, 'HMK1H');
  const r = decode(await t.handle(MAC, `HMK2${BTN.AUX1}`));
  assert.ok(r.some((x) => /^>1\. Abhi/.test(x.text)));
  assert.ok(r.some((x) => /You are #1 of 2/.test(x.text)));
});
