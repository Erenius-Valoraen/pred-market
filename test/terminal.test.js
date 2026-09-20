import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Terminal, ROWS, ITEMS, WIDTH, FRAME_MAX, AMOUNTS, tagOf } from '../src/terminal.js';

const MAC = 'E8:F6:0A:29:D3:F4';
const TAG = '9D3F4';

function fake(extraMarkets = 0) {
  const markets = [
    { slug: 'team-aurora', kind: 'team', team: { name: 'Aurora' }, question: 'Will Aurora win a prize?',
      outcomes: ['YES', 'NO'], prices: [0.42, 0.58], status: 'open' },
    { slug: 'grand', kind: 'seed', short: 'Best Overall kind', question: 'What kind of project wins Best Overall?',
      outcomes: ['AI', 'Hardware', 'Web', 'Dev tools', 'Other'], prices: [0.3, 0.2, 0.2, 0.2, 0.1], status: 'open' },
  ];
  for (let i = 0; i < extraMarkets; i++) {
    markets.push({ slug: `t${i}`, kind: 'team', team: { name: `Team ${i}` },
      outcomes: ['YES', 'NO'], prices: [0.5, 0.5], status: 'open' });
  }
  const acct = { cash: 1000, shares: {}, fresh: true };
  const calls = [];
  return {
    calls, markets,
    backend: {
      markets: () => markets,
      board: () => [],
      account: async () => ({ ...acct, shares: structuredClone(acct.shares) }),
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
    },
  };
}

const settle = () => new Promise((r) => setTimeout(r, 10));
// Reassemble frames the way the badge does: 3 parts per row, joined.
function decode(frames, screen = {}) {
  const parts = screen.parts ?? (screen.parts = {});
  const rows = screen.rows ?? (screen.rows = {});
  for (const f of frames) {
    if (f[6] === '~') continue;
    const c = f.charCodeAt(6) - 48;
    parts[c] = f.slice(7);
    const r = Math.floor(c / 3);
    rows[r] = (parts[r * 3] ?? '') + (parts[r * 3 + 1] ?? '') + (parts[r * 3 + 2] ?? '');
  }
  return rows;
}

test('tag is the last 5 hex digits of the radio address', () => {
  assert.equal(tagOf(MAC), TAG);
  assert.equal(tagOf('e8:f6:0a:29:d3:f4'), TAG);
});

test('opening the app draws the market list inside 20-byte frames', async () => {
  const { backend } = fake();
  const emitted = [];
  const t = new Terminal(backend, (f) => emitted.push(...f));
  const frames = await t.handle(MAC, 'HMK10HAbhi Dutta');
  assert.equal(frames[0], `M${TAG}~1`, 'ack comes first');
  for (const f of [...frames, ...emitted]) {
    assert.ok(f.startsWith(`M${TAG}`));
    assert.ok(Buffer.byteLength(f) <= FRAME_MAX, `${f} is ${f.length} bytes`);
  }
  const screen = {};
  decode(frames, screen);
  assert.match(screen.rows[1], /Aurora\s+=+\.+\s+42%/);
  assert.match(screen.rows[2], /Best Overall kind\s+=+\.+\s+30%/);
  await settle();
  decode(emitted, screen);
  assert.match(screen.rows[0], /HTN MARKET\s+1,000 HACK/);
  assert.match(screen.rows[8], /Welcome Abhi! \+1,000 HACK/);
});

test('moving the cursor costs nothing: only real actions carry a row', async () => {
  const { backend } = fake();
  const t = new Terminal(backend, () => {});
  await t.handle(MAC, 'HMK10H');
  await settle();
  // The badge highlights rows itself, so there is no key for "moved".
  const open = decode(await t.handle(MAC, 'HMK20A2'));        // open row 2
  assert.equal(t.session(MAC).view, 'market');
  assert.equal(t.session(MAC).mi, 1);
  assert.match(open[1], /^AI/);
  const back = decode(await t.handle(MAC, 'HMK30B'));
  assert.equal(t.session(MAC).view, 'list');
  assert.match(back[1], /Aurora/);
});

test('a retried press is acked but acts once', async () => {
  const { backend, calls } = fake();
  const t = new Terminal(backend, () => {});
  await t.handle(MAC, 'HMK10H');
  await settle();
  await t.handle(MAC, 'HMK20A1');                             // open Aurora
  const a = await t.handle(MAC, 'HMK30A1');                   // buy YES
  const b = await t.handle(MAC, 'HMK31A1');                   // same seq = retry
  await settle();
  assert.deepEqual(calls, [['buy', 'team-aurora', 0, AMOUNTS[2]]]);
  assert.equal(b[0], `M${TAG}~3`);
  assert.deepEqual(b.slice(1), a.slice(1));
});

test('buy, then sell, with the trade size on Left/Right', async () => {
  const { backend, calls } = fake();
  const sc = {};                                              // the badge's screen
  const t = new Terminal(backend, (f) => decode(f, sc));
  decode(await t.handle(MAC, 'HMK10H'), sc);
  await settle();
  decode(await t.handle(MAC, 'HMK20A1'), sc);
  decode(await t.handle(MAC, 'HMK30R'), sc);                  // 50 -> 100
  const rows = decode(await t.handle(MAC, 'HMK40A1'), sc);
  assert.match(rows[8], /Buying YES with 100/);
  await settle();
  assert.deepEqual(calls[0], ['buy', 'team-aurora', 0, 100]);
  assert.match(sc.rows[8], /Bought 150 YES for 100/);
  assert.match(sc.rows[1], /YES x150\s+=+\.+\s+42%/);

  decode(await t.handle(MAC, 'HMK50S1'), sc);                 // sell all of row 1
  await settle();
  assert.deepEqual(calls[1], ['sell', 'team-aurora', 0, 150]);
  assert.match(sc.rows[8], /Sold for 60/);
});

test('paging, and refusing what you cannot pay for', async () => {
  const { backend, calls } = fake(8);                         // 10 markets, 7 per page
  const sc = {};
  const t = new Terminal(backend, (f) => decode(f, sc));
  decode(await t.handle(MAC, 'HMK10H'), sc);
  await settle();
  decode(await t.handle(MAC, 'HMK20N'), sc);
  assert.equal(t.session(MAC).page, 1);
  assert.match(sc.rows[1], /Team 5/);
  assert.match(sc.rows[9], /page 2\/2/);
  decode(await t.handle(MAC, 'HMK30P'), sc);
  assert.equal(t.session(MAC).page, 0);

  decode(await t.handle(MAC, 'HMK40A1'), sc);                 // open Aurora
  for (let i = 5; i < 8; i++) decode(await t.handle(MAC, `HMK${i}0R`), sc);   // raise to 500
  t.session(MAC).acct.cash = 10;
  decode(await t.handle(MAC, 'HMK80A1'), sc);
  assert.match(sc.rows[8], /Not enough HACK for 500/);
  assert.equal(calls.length, 0);
  for (const line of t.lines(t.session(MAC))) assert.ok(line.length <= WIDTH);
});

test('every screen leaves rows 1..7 for the cursor and row 8 for status', async () => {
  const { backend } = fake();
  const t = new Terminal(backend, () => {});
  await t.handle(MAC, 'HMK10H');
  await settle();
  const s = t.session(MAC);
  assert.equal(t.lines(s).length, ROWS);
  assert.equal(t.lines(s).slice(1, 1 + ITEMS).filter(Boolean).length, 2, 'two markets, two rows');
  assert.ok(t.allFrames(s).every((f) => Buffer.byteLength(f) <= FRAME_MAX));
});
