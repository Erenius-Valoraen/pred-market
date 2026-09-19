import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Terminal, BTN, ROWS, WIDTH, FRAME_MAX, tagOf } from '../src/terminal.js';

const MAC = 'E8:F6:0A:29:D3:F4';
const TAG = '9D3F4';

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
// Reassemble frames the way the badge does: 3 parts per row, joined.
function decode(frames, screen = {}) {
  const parts = screen.parts ?? (screen.parts = {});
  const out = [];
  for (const f of frames) {
    if (f[6] === '~') continue;                       // ack
    const c = f.charCodeAt(6) - 48;
    parts[c] = f.slice(7);
    const r = Math.floor(c / 3);
    out.push({ tag: f.slice(1, 6), row: r, text: (parts[r * 3] ?? '') + (parts[r * 3 + 1] ?? '') + (parts[r * 3 + 2] ?? '') });
  }
  return out;
}

test('tag is the last 5 hex digits of the radio address', () => {
  assert.equal(tagOf(MAC), TAG);
  assert.equal(tagOf('e8:f6:0a:29:d3:f4'), TAG);
});

test('hello draws a full screen, frames fit the 44-byte radio payload', async () => {
  const { backend } = fake();
  const emitted = [];
  const t = new Terminal(backend, (f) => emitted.push(...f));
  const frames = await t.handle(MAC, 'HMK10HAbhi Dutta');
  assert.ok(frames.length >= ROWS + 1);
  for (const f of [...frames, ...emitted]) {
    assert.ok(f.startsWith(`M${TAG}`));
    assert.ok(Buffer.byteLength(f) <= FRAME_MAX, `${f} is ${f.length} bytes`);
  }
  await settle();
  const screen = {};
  decode(frames, screen);
  const after = decode(emitted, screen);
  assert.ok(after.some((x) => x.row === 0 && /1,000 HACK/.test(x.text)));
  assert.ok(after.some((x) => /Welcome Abhi!/.test(x.text)));
});

test('only changed parts are resent; a retry repeats the last answer without acting', async () => {
  const { backend } = fake();
  const t = new Terminal(backend, () => {});
  await t.handle(MAC, 'HMK10H');
  await settle();
  const first = await t.handle(MAC, `HMK20${BTN.DOWN}`);
  assert.equal(first[0], `M${TAG}~2`, 'ack comes first');
  const rows = first.slice(1);
  assert.deepEqual([...new Set(rows.map((f) => Math.floor((f.charCodeAt(6) - 48) / 3)))].sort(), [1, 2]);
  assert.ok(rows.length <= 2, 'moving the cursor only changes the first part of two rows');
  const retry = await t.handle(MAC, `HMK21${BTN.DOWN}`);            // same seq = the badge missed our reply
  assert.deepEqual(retry, first);
  assert.equal(t.session(MAC).cursor, 1, 'retry must not move again');
});

test('buy then sell from the badge', async () => {
  const { backend, calls } = fake();
  const emitted = [];
  const t = new Terminal(backend, (f) => emitted.push(...f));
  await t.handle(MAC, 'HMK10H');
  await settle();
  await t.handle(MAC, `HMK20${BTN.A}`);                  // open Aurora
  await t.handle(MAC, `HMK30${BTN.RIGHT}`);              // spend 50 -> 100
  const buying = decode(await t.handle(MAC, `HMK40${BTN.A}`));
  assert.ok(buying.some((x) => /Buying YES with 100/.test(x.text)));
  await settle();
  assert.deepEqual(calls[0], ['buy', 'team-aurora', 0, 100]);
  const done = decode(emitted);
  assert.ok(done.some((x) => /Bought 150 YES for 100/.test(x.text)));
  assert.ok(done.some((x) => /> YES x150/.test(x.text)));

  emitted.length = 0;
  await t.handle(MAC, `HMK50${BTN.START}`);
  await settle();
  assert.deepEqual(calls[1], ['sell', 'team-aurora', 0, 150]);
  assert.ok(decode(emitted).some((x) => /Sold for 60/.test(x.text)));
});

test('cannot overspend; long questions wrap and stay within width', async () => {
  const { backend, calls } = fake();
  const t = new Terminal(backend, () => {});
  await t.handle(MAC, 'HMK10H');
  await settle();
  await t.handle(MAC, `HMK20${BTN.DOWN}`);
  await t.handle(MAC, `HMK30${BTN.A}`);                  // open the 5-outcome market
  for (let i = 4; i < 9; i++) await t.handle(MAC, `HMK${i}0${BTN.RIGHT}`);   // max spend 500
  const s = t.session(MAC);
  s.acct.cash = 100;
  const r = decode(await t.handle(MAC, `HMK90${BTN.A}`));
  assert.ok(r.some((x) => /Not enough HACK for 500/.test(x.text)));
  assert.equal(calls.length, 0);
  for (const line of t.lines(s)) assert.ok(line.length <= WIDTH);
  assert.ok(t.lines(s)[1].length > 0, 'question continues on row 1');
});

test('leaderboard view marks you', async () => {
  const { backend } = fake();
  const t = new Terminal(backend, () => {});
  await t.handle(MAC, 'HMK10H');
  const r = decode(await t.handle(MAC, `HMK20${BTN.AUX1}`));
  assert.ok(r.some((x) => /^>1\. Abhi/.test(x.text)));
  assert.ok(r.some((x) => /You are #1 of 2/.test(x.text)));
});
