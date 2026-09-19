// Badge terminal: the screens attendees see on their badges.
//
// The badge app is a dumb radio terminal (badge/htnmkt/main.lua): it shows 10
// lines of text and reports button presses. Everything else happens here, per
// badge: which screen you're on, the cursor, quotes, and the trades
// themselves (through an injected backend so this file has no chain code and
// can be tested offline).
//
// Wire format (through the gateway badge):
//   uplink   "HMK" seq key[args]  key = button number, or "H<name>" on open
//   downlink "HMD" tag row text   tag = last 6 hex of the badge's radio MAC

export const ROWS = 10;
export const WIDTH = 34;                 // 44-byte payload - 10 bytes of header
export const BTN = { A: 0, B: 1, HOME: 2, DOWN: 3, LEFT: 4, RIGHT: 5, UP: 6, AUX1: 7, START: 8 };
const AMOUNTS = [10, 25, 50, 100, 250, 500];
const LIST_ROWS = 7;

export function tagOf(mac) {
  return String(mac).replace(/:/g, '').slice(-6).toUpperCase();
}

const fit = (s, n = WIDTH) => {
  s = String(s ?? '').replace(/[^\x20-\x7e]/g, '?');
  return s.length > n ? s.slice(0, n - 1) + '~' : s;
};
const pct = (p) => `${Math.round(p * 100)}%`.padStart(4);
const num = (x) => (x >= 100 ? Math.round(x).toLocaleString('en-US') : x.toFixed(1));
const cols = (left, right, n = WIDTH) => {
  right = String(right);
  return fit(left, n - right.length - 1).padEnd(n - right.length) + right;
};

/** Short label for a market in the list. */
function label(m) {
  if (m.kind === 'team') return m.team?.name ?? m.question;
  return m.short ?? m.question;
}

/** Headline number for a market in the list: YES price, or the favourite. */
function headline(m) {
  if (!m.prices) return '--';
  if (m.status === 'resolved') return 'done';
  if (m.outcomes.length === 2 && m.outcomes[0] === 'YES') return pct(m.prices[0]).trim();
  let best = 0;
  m.prices.forEach((p, i) => { if (p > m.prices[best]) best = i; });
  return pct(m.prices[best]).trim();
}

export class Terminal {
  /**
   * backend: {
   *   markets(): [{slug, question, outcomes, kind, team?, prices, q, b, status}]
   *   account(mac, name): Promise<{cash, shares: {slug: [n0, n1, ...]}}>
   *   buy(mac, slug, outcome, spend): Promise<{shares}>
   *   sell(mac, slug, outcome, shares): Promise<{refund}>
   *   board(): [{name, netWorth, mac?}]
   * }
   * emit(frames): called whenever lines for some badge change (async trades).
   */
  constructor(backend, emit) {
    this.backend = backend;
    this.emit = emit;
    this.sessions = new Map();
  }

  session(mac) {
    let s = this.sessions.get(mac);
    if (!s) {
      s = { mac, tag: tagOf(mac), name: '', view: 'list', cursor: 0, mi: 0, oi: 0, amt: 2,
        status: '', lastSeq: null, sent: new Array(ROWS).fill(null), busy: false, acct: null };
      this.sessions.set(mac, s);
    }
    return s;
  }

  /** Handle one uplink frame. Returns the frames to broadcast (may be []). */
  async handle(mac, payload) {
    if (!payload.startsWith('HMK') || payload.length < 5) return [];
    const s = this.session(mac);
    const seq = payload[3];
    const key = payload.slice(4);
    // Retries repeat the same seq: answer with the full screen again (the
    // earlier answer was evidently lost) but don't act twice.
    const repeat = seq === s.lastSeq;
    s.lastSeq = seq;
    if (key[0] === 'H') {
      s.name = key.slice(1).trim().slice(0, 32) || s.name;
      s.sent.fill(null);
      if (!s.acct) this.loadAccount(s);
      return this.render(s);
    }
    if (repeat) {
      s.sent.fill(null);
      return this.render(s);
    }
    this.press(s, Number(key));
    return this.render(s);
  }

  /** First contact: create/fund the wallet in the background, then redraw. */
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
      .then(() => { s.loading = false; this.emit(this.render(s)); });
  }

  press(s, b) {
    const markets = this.backend.markets();
    if (s.view === 'list') {
      const n = markets.length;
      if (b === BTN.DOWN && n) s.cursor = (s.cursor + 1) % n;
      else if (b === BTN.UP && n) s.cursor = (s.cursor - 1 + n) % n;
      else if (b === BTN.RIGHT && n) s.cursor = Math.min(n - 1, s.cursor + LIST_ROWS);
      else if (b === BTN.LEFT) s.cursor = Math.max(0, s.cursor - LIST_ROWS);
      else if (b === BTN.A && n) { s.view = 'market'; s.mi = s.cursor; s.oi = 0; s.status = ''; }
      else if (b === BTN.AUX1) s.view = 'board';
      else if (b === BTN.B) { s.sent.fill(null); s.status = ''; }       // B on the list = redraw
      return;
    }
    if (s.view === 'board') {
      if (b === BTN.B || b === BTN.AUX1 || b === BTN.A) s.view = 'list';
      return;
    }
    // market view
    const m = markets[s.mi];
    if (!m) { s.view = 'list'; return; }
    const k = m.outcomes.length;
    if (b === BTN.B) { s.view = 'list'; s.status = ''; }
    else if (b === BTN.DOWN) s.oi = (s.oi + 1) % k;
    else if (b === BTN.UP) s.oi = (s.oi - 1 + k) % k;
    else if (b === BTN.RIGHT) s.amt = Math.min(AMOUNTS.length - 1, s.amt + 1);
    else if (b === BTN.LEFT) s.amt = Math.max(0, s.amt - 1);
    else if (b === BTN.A) this.trade(s, m, 'buy');
    else if (b === BTN.START) this.trade(s, m, 'sell');
  }

  trade(s, m, side) {
    if (s.busy) { s.status = 'Still working on the last trade'; return; }
    if (m.status === 'resolved') { s.status = 'Market is closed'; return; }
    const outcome = s.oi;
    const name = m.outcomes[outcome];
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
        this.emit(this.render(s));
      });
  }

  /** Lines for this badge's current screen. */
  lines(s) {
    const markets = this.backend.markets();
    const cash = s.acct ? `${num(s.acct.cash)} HACK` : '...';
    const L = new Array(ROWS).fill('');
    if (s.view === 'list') {
      L[0] = cols('HTN MARKET', cash);
      if (!markets.length) L[2] = 'No markets yet';
      const top = Math.floor(s.cursor / LIST_ROWS) * LIST_ROWS;
      for (let r = 0; r < LIST_ROWS; r++) {
        const m = markets[top + r];
        if (!m) break;
        L[1 + r] = cols(`${top + r === s.cursor ? '>' : ' '} ${label(m)}`, headline(m));
      }
      L[8] = fit(s.status);
      L[9] = 'A open  UP/DN move  AUX leaders';
    } else if (s.view === 'board') {
      L[0] = cols('LEADERBOARD', cash);
      const rows = this.backend.board();
      const mine = rows.findIndex((r) => r.mac === s.mac);
      rows.slice(0, 7).forEach((r, i) => {
        L[1 + i] = cols(`${i === mine ? '>' : ' '}${i + 1}. ${r.name}`, num(r.netWorth));
      });
      L[8] = mine >= 0 ? `You are #${mine + 1} of ${rows.length}` : 'Trade to get on the board';
      L[9] = 'B back';
    } else {
      const m = markets[s.mi];
      const q = m?.question ?? '';
      L[0] = fit(q);
      L[1] = q.length > WIDTH ? fit(q.slice(WIDTH - 1)) : '';
      const held = s.acct?.shares?.[m?.slug] ?? [];
      m?.outcomes.slice(0, 5).forEach((o, i) => {
        const own = held[i] > 0.001 ? ` x${num(held[i])}` : '';
        L[2 + i] = cols(`${i === s.oi ? '>' : ' '} ${o}${own}`, m.prices ? pct(m.prices[i]).trim() : '--');
      });
      L[7] = cols(`Spend < ${AMOUNTS[s.amt]} >`, cash);
      L[8] = fit(s.status);
      L[9] = 'A buy  START sell all  B back';
    }
    return L.map((x) => fit(x));
  }

  /** Frames for rows that changed since we last sent them. */
  render(s) {
    const L = this.lines(s);
    const out = [];
    for (let r = 0; r < ROWS; r++) {
      if (L[r] !== s.sent[r]) {
        out.push(`HMD${s.tag}${r}${L[r]}`);
        s.sent[r] = L[r];
      }
    }
    return out;
  }
}

function friendly(e) {
  const t = String(e?.message ?? e);
  if (/Slippage|0x4\b|custom program error: 0x4/.test(t)) return 'price moved, try again';
  if (/insufficient|0x1\b/.test(t)) return 'not enough funds';
  if (/NotOpen/.test(t)) return 'market closed';
  return t.slice(0, 24);
}
