// The screens attendees see on their badges, and what their presses do.
//
// The badge (badge/htnmkt/main.lua) is a thin radio terminal: it shows ten
// rows of text and owns nothing but the cursor, which is why moving it is
// instant. This file decides what those rows say, and turns "the badge acted
// on row 4" into a real on-chain trade (through an injected backend, so this
// file has no chain code and can be tested offline).
//
// Row layout, fixed so the badge can skip blank rows when moving:
//   0      header: what you are looking at, and your balance
//   1..7   the things you can pick: markets, or one market's outcomes
//   8      status: what just happened
//   9      hints: which button does what
//
// Wire format (see tools/radio_node.py):
//   uplink   "HMK" seq try key   key = "A"row "S"row "B" "N" "P" "L" "R"
//                                or "G"tag to hand HACK to a touching badge
//                                or "H"name when the app opens
//   downlink "M" tag cell text   cell = char(48 + 3*row + part); each row is
//                                sent as up to 3 parts of 13 chars, so every
//                                frame fits a 20-byte legacy BLE advert
//            "M" tag "~" seq     ack: the badge stops resending that press

export const ROWS = 10;
export const ITEMS = 7;                  // rows 1..7
export const WIDTH = 34;                 // characters per row on the badge
export const PART = 13;                  // 20-byte frame - 7 bytes of header
export const FRAME_MAX = 20;
export const AMOUNTS = [10, 25, 50, 100, 250, 500];
export const CONFIRM_MS = 15_000;     // how long a tap-to-pay offer stands

export function tagOf(mac) {
  return String(mac).replace(/:/g, '').slice(-5).toUpperCase();
}

const fit = (s, n = WIDTH) => {
  s = String(s ?? '').replace(/[^\x20-\x7e]/g, '?');
  return s.length > n ? s.slice(0, n - 1) + '~' : s;
};
const pct = (p) => `${Math.round(p * 100)}%`;
const num = (x) => (x >= 100 ? Math.round(x).toLocaleString('en-US') : x.toFixed(1));
const cols = (left, right, n = WIDTH) => {
  right = String(right);
  return fit(left, n - right.length - 1).padEnd(n - right.length) + right;
};

function label(m) {
  return m.kind === 'team' ? (m.team?.name ?? m.question) : (m.short ?? m.question);
}

function best(m) {
  if (m.outcomes[0] === 'YES') return 0;
  let b = 0;
  m.prices.forEach((p, i) => { if (p > m.prices[b]) b = i; });
  return b;
}

/** A bar drawn in text, because badge widgets cost RAM the radio needs. */
const BAR = 10;
function bar(p) {
  const on = Math.max(0, Math.min(BAR, Math.round(p * BAR)));
  return '='.repeat(on) + '.'.repeat(BAR - on);
}

/** "Aurora        ====...... 42%" */
function itemRow(name, p, resolved) {
  if (p === undefined) return cols(name, '--');
  const right = `${bar(p)} ${pct(p).padStart(4)}`;
  return resolved ? cols(name, `resolved ${pct(p)}`) : cols(name, right);
}

export class Terminal {
  /**
   * backend: {
   *   markets(), board(),
   *   account(mac, name) -> {cash, shares, fresh},
   *   buy(mac, slug, outcome, spend) -> {shares},
   *   sell(mac, slug, outcome, shares) -> {refund},
   *   transfer(fromMac, toMac, amount),
   * }
   * emit(frames): rows that changed on their own (a trade confirming).
   */
  constructor(backend, emit) {
    this.backend = backend;
    this.emit = emit;
    this.sessions = new Map();
  }

  session(mac) {
    let s = this.sessions.get(mac);
    if (!s) {
      s = { mac, tag: tagOf(mac), name: '', view: 'list', page: 0, mi: 0, amt: 2,
        status: '', lastSeq: null, sent: new Array(ROWS * 3).fill(null), last: [],
        busy: false, acct: null, seen: 0 };
      this.sessions.set(mac, s);
    }
    s.seen = Date.now();
    return s;
  }

  /** One uplink frame; returns the frames to broadcast, ack first. */
  async handle(mac, payload) {
    if (!payload.startsWith('HMK') || payload.length < 6) return [];
    const s = this.session(mac);
    const seq = payload[3];
    const key = payload.slice(5);
    const ack = `M${s.tag}~${seq}`;
    if (seq === s.lastSeq) return [ack, ...s.last];   // a retry: don't act twice
    s.lastSeq = seq;
    this.press(s, key);
    const frames = this.render(s);
    s.last = frames;
    return [ack, ...frames];
  }

  press(s, key) {
    const k = key[0];
    const row = Number(key[1]);                       // 1..7, the highlighted row
    const markets = this.backend.markets();
    if (k === 'H') {
      s.name = String(key.slice(1)).trim().slice(0, 32) || s.name;
      s.sent.fill(null);                              // the badge starts blank
      if (!s.acct) this.loadAccount(s);
      return;
    }
    if (k === 'G') return this.give(s, key.slice(1));
    if (s.view === 'list') {
      const pages = Math.max(1, Math.ceil(markets.length / ITEMS));
      if (k === 'N') s.page = Math.min(pages - 1, s.page + 1);
      else if (k === 'P') s.page = Math.max(0, s.page - 1);
      else if (k === 'A') {
        const i = s.page * ITEMS + row - 1;
        if (markets[i]) { s.view = 'market'; s.mi = i; s.status = ''; }
      }
      return;
    }
    // inside a market: rows 1..n are its outcomes
    const m = markets[s.mi];
    if (!m) { s.view = 'list'; return; }
    if (k === 'B') { s.view = 'list'; s.status = ''; }
    else if (k === 'L') s.amt = Math.max(0, s.amt - 1);
    else if (k === 'R') s.amt = Math.min(AMOUNTS.length - 1, s.amt + 1);
    else if (k === 'A' || k === 'S') this.trade(s, m, row - 1, k === 'A' ? 'buy' : 'sell');
  }

  /** Tap to pay: hand the current trade size to the badge we are touching.
   *
   * Two taps, because "touching" is really just a strong signal and money
   * should not move because someone walked past. The first tap names who
   * would get it; a second tap within CONFIRM_MS sends. */
  give(s, tag) {
    const to = [...this.sessions.values()].find((x) => x.tag === tag && x !== s);
    if (!to) { s.status = 'That badge has not opened the app'; return; }
    if (s.busy) { s.status = 'Still working on the last trade'; return; }
    const amount = AMOUNTS[s.amt];
    if ((s.acct?.cash ?? 0) < amount) { s.status = `Not enough HACK for ${amount}`; return; }
    const who = (x) => (x.name ? x.name.split(' ')[0] : 'that badge');
    if (s.confirm?.tag !== tag || Date.now() - s.confirm.at > CONFIRM_MS) {
      s.confirm = { tag, at: Date.now() };
      s.status = `Send ${amount} to ${who(to)}? AUX again`;
      return;
    }
    s.confirm = null;
    s.status = `Sending ${amount} to ${who(to)}...`;
    s.busy = true;
    this.backend.transfer(s.mac, to.mac, amount)
      .then(() => {
        s.status = `Sent ${amount} HACK to ${who(to)}`;
        to.status = `${who(s)} sent you ${amount} HACK`;
      })
      .catch((e) => { s.status = fit(`Failed: ${friendly(e)}`); })
      .then(async () => {
        s.busy = false;
        for (const x of [s, to]) {
          try { x.acct = await this.backend.account(x.mac, x.name); } catch { /* keep old */ }
          this.push(x);
        }
      });
  }

  /** First contact: create and fund this badge's wallet, then redraw. */
  loadAccount(s) {
    if (s.loading) return;
    s.loading = true;
    s.status = 'Setting up your wallet...';
    this.backend.account(s.mac, s.name)
      .then((a) => {
        s.acct = a;
        s.status = a.fresh ? `Welcome${s.name ? ' ' + s.name.split(' ')[0] : ''}! +${num(a.cash)} HACK` : '';
      })
      .catch((e) => { s.status = fit(`Wallet error: ${friendly(e)}`); })
      .then(() => { s.loading = false; this.push(s); });
  }

  trade(s, m, outcome, side) {
    const name = m.outcomes[outcome];
    if (!name) return;
    if (s.busy) { s.status = 'Still working on the last trade'; return; }
    if (m.status === 'resolved') { s.status = 'This market is closed'; return; }
    let job;
    if (side === 'buy') {
      const spend = AMOUNTS[s.amt];
      if ((s.acct?.cash ?? 0) < spend) { s.status = `Not enough HACK for ${spend}`; return; }
      s.status = `Buying ${name} with ${spend}...`;
      job = this.backend.buy(s.mac, m.slug, outcome, spend)
        .then((r) => `Bought ${num(r.shares)} ${fit(name, 10)} for ${spend}`);
    } else {
      const held = s.acct?.shares?.[m.slug]?.[outcome] ?? 0;
      if (held < 0.001) { s.status = `You hold no ${fit(name, 12)}`; return; }
      s.status = `Selling ${num(held)} ${fit(name, 10)}...`;
      job = this.backend.sell(s.mac, m.slug, outcome, held)
        .then((r) => `Sold for ${num(r.refund)} HACK`);
    }
    s.busy = true;
    job
      .then((msg) => { s.status = msg; })
      .catch((e) => { s.status = fit(`Failed: ${friendly(e)}`); })
      .then(async () => {
        s.busy = false;
        try { s.acct = await this.backend.account(s.mac, s.name); } catch { /* keep old */ }
        this.push(s);
      });
  }

  push(s) {
    const frames = this.render(s);
    if (frames.length) {
      s.last = frames;
      this.emit(frames);
    }
  }

  /** The ten rows this badge should be showing. */
  lines(s) {
    const markets = this.backend.markets();
    const cash = s.acct ? `${num(s.acct.cash)} HACK` : '...';
    const L = new Array(ROWS).fill('');
    if (s.view === 'list') {
      L[0] = cols('HTN MARKET', cash);
      const top = s.page * ITEMS;
      for (let r = 0; r < ITEMS; r++) {
        const m = markets[top + r];
        if (m) L[1 + r] = itemRow(label(m), m.prices?.[best(m)], m.status === 'resolved');
      }
      L[9] = markets.length > ITEMS
        ? `A open   page ${s.page + 1}/${Math.ceil(markets.length / ITEMS)}`
        : 'A open a market';
    } else {
      const m = markets[s.mi];
      L[0] = cols(fit(label(m), 22), cash);
      const held = s.acct?.shares?.[m.slug] ?? [];
      m.outcomes.slice(0, ITEMS).forEach((o, i) => {
        const own = held[i] > 0.001 ? ` x${num(held[i])}` : '';
        L[1 + i] = itemRow(`${o}${own}`, m.prices?.[i], m.status === 'resolved');
      });
      L[9] = `A buy ${AMOUNTS[s.amt]}  START sell  B back`;
    }
    L[8] = fit(s.status);
    return L.map((x) => fit(x));
  }

  /** Frames for the row parts that changed since we last sent them. */
  render(s) {
    const L = this.lines(s);
    const out = [];
    for (let r = 0; r < ROWS; r++) {
      for (let k = 0; k < 3; k++) {
        const c = r * 3 + k;
        const part = L[r].slice(k * PART, (k + 1) * PART);
        if (part !== s.sent[c]) {
          out.push(`M${s.tag}${String.fromCharCode(48 + c)}${part}`);
          s.sent[c] = part;
        }
      }
    }
    return out;
  }

  /** Every frame of a badge's current screen, for the background re-send. */
  allFrames(s) {
    const L = this.lines(s);
    const out = [];
    for (let r = 0; r < ROWS; r++) {
      for (let k = 0; k < 3; k++) {
        const part = L[r].slice(k * PART, (k + 1) * PART);
        if (part !== '') out.push(`M${s.tag}${String.fromCharCode(48 + r * 3 + k)}${part}`);
      }
    }
    return out;
  }

  /** Badges that spoke recently: worth re-sending their screen in the background. */
  activeSessions(ms = 180_000) {
    const now = Date.now();
    return [...this.sessions.values()].filter((s) => now - s.seen < ms);
  }
}

function friendly(e) {
  const t = String(e?.message ?? e);
  if (/Slippage|custom program error: 0x4\b/.test(t)) return 'price moved, try again';
  if (/insufficient|0x1\b/.test(t)) return 'not enough funds';
  if (/NotOpen/.test(t)) return 'market closed';
  return t.slice(0, 24);
}
