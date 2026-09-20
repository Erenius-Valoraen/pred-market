// HTN Market — the web app.
//
// Three views (markets, leaderboard, register) plus a portfolio rail that
// becomes the "You" tab on a phone. Prices come straight from the Solana
// program; the only things the server decides are the faucet, the
// leaderboard and team registration.
//
// Re-render discipline: the page polls every 5 s, so a region only redraws
// when a key describing its state changes. Otherwise a poll would wipe what
// someone is typing and swap buttons out from under their thumb.

import './polyfill.js';
import * as chain from './chainlib.js';
import * as wallets from './wallet.js';
import {
  $, $$, el, esc, fmt, pct, pct1, short, animate, press, popIn, stagger,
  rollTo, sparkline, priceChart, slideTo, toast, confetti, moveIndicator, SPRING,
} from './ui.js';

const S = {
  view: 'markets',
  filter: 'all',
  sort: 'hot',                // how the team board is ordered
  detail: null,               // slug of the market being read in full
  meta: [], markets: [], history: {}, board: [],
  wallet: null, balances: new Map(), sol: 0, hack: 0,
  sheet: null, busy: false, lastOk: 0, activity: [],
};

const bySlug = (slug) => S.markets.find((m) => m.slug === slug);
const held = (m, i) => (!S.wallet || !m.pubkey ? 0
  : S.balances.get(chain.outcomeMintPda(m.pubkey, i).toBase58()) ?? 0);
const isBinary = (m) => m.outcomes.length === 2 && m.outcomes[0] === 'YES';

/** A market trades under a symbol, like anything else worth betting on. */
const STOP = new Set(['WILL', 'THE', 'A', 'AN', 'OF', 'TO', 'ON', 'IN', 'AT', 'BE', 'IS', 'ANY',
  'WIN', 'WINS', 'RUN', 'GO', 'MANY', 'HOW', 'WHAT', 'KIND', 'PROJECT', 'PROJECTS', 'TEAM', 'THIS']);
function symbol(m) {
  const base = m.team?.name ?? m.short ?? m.question;
  const words = String(base).toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  const keep = words.filter((w) => !STOP.has(w));
  const pick = keep.length ? keep : words;
  if (pick.length === 1) return pick[0].slice(0, 4);
  return pick.slice(0, 4).map((w) => w[0]).join('');
}

/** Price history for one outcome, oldest sample first. */
function series(m, i) {
  return (S.history[m.slug] ?? []).map((row) => row.p?.[i]).filter((x) => typeof x === 'number');
}

/** Change since the oldest sample we kept, in percentage points. */
function movement(m, i) {
  const h = series(m, i);
  if (h.length < 2) return null;
  return Math.round((m.prices[i] - h[0]) * 100);
}

function moveBadge(delta) {
  if (delta === null || delta === 0) return '<span class="move flat">no move yet</span>';
  const up = delta > 0;
  return `<span class="move ${up ? 'up' : 'down'}">${up ? '\u25b2' : '\u25bc'} ${Math.abs(delta)} pts</span>`;
}

/** Shares outstanding: how much conviction is actually riding on this. */
const stakes = (m) => (m.q ?? []).reduce((a, b) => a + b, 0);

/** What one HACK returns if this outcome happens: the bookmaker's number. */
const payout = (p) => (p > 0.005 ? `${(1 / p).toFixed(2)}\u00d7` : '--');

/** Every slip gets a number. Same market, same number, all event long. */
function slipNo(m) {
  let h = 7;
  for (const c of m.slug) h = (h * 31 + c.charCodeAt(0)) % 9973;
  return String(h).padStart(4, '0');
}

function netWorth() {
  let positions = 0;
  for (const m of S.markets) {
    if (m.missing) continue;
    m.outcomes.forEach((_, i) => {
      const h = held(m, i);
      if (h > 0) positions += m.status === 'resolved' ? (i === m.winner ? h : 0) : h * m.prices[i];
    });
  }
  return { cash: S.hack, positions, total: S.hack + positions };
}

const lastKey = {};
function changed(region, key) {
  if (lastKey[region] === key) return false;
  lastKey[region] = key;
  return true;
}

// ------------------------------------------------------------------ header
function renderWallet() {
  const w = $('#wallet');
  if (!changed('wallet', `${S.wallet?.publicKey.toBase58() ?? ''}|${S.hack.toFixed(4)}|${S.wallet?.kind ?? ''}`)) return;
  if (!S.wallet) {
    w.innerHTML = '<button class="primary" id="w-login">Log in</button>';
    $('#w-login').onclick = (e) => { press(e.currentTarget); openLogin(); };
    return;
  }
  const k = S.wallet.publicKey.toBase58();
  w.innerHTML = `
    <span class="pill" title="Your play-money balance"><b class="num" id="hack-top">0.00</b> HACK</span>
    <button class="pill account" id="w-account" aria-haspopup="menu">
      <span class="avatar" style="background:${avatarColor(k)}"></span>
      <span class="num">${esc(short(k))}</span>
    </button>`;
  rollTo($('#hack-top'), S.hack, { digits: 2 });
  $('#w-account').onclick = (e) => { press(e.currentTarget); openAccount(); };
}

/** A stable colour per wallet, so you recognise your own at a glance. */
function avatarColor(key) {
  let h = 0;
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 58% 45%)`;
}

/** Signing in is a choice between "just let me play" and "I have a wallet". */
function openLogin() {
  const back = el(`<div class="sheet-backdrop" id="sheet-backdrop">
    <div class="sheet" role="dialog" aria-modal="true" aria-label="Log in">
      <div class="grab"></div>
      <h3>Log in to trade</h3>
      <p class="small muted" style="margin:0">No email, no password. Pick one:</p>
      <button class="primary" id="l-burner">Create a quick wallet</button>
      <p class="small muted" style="margin:-4px 0 0">Made in this browser, funded with 1,000 play HACK.
      Nothing to install. Clearing site data loses it.</p>
      <button id="l-phantom">Connect Phantom</button>
      <p class="small muted" style="margin:-4px 0 0">Use a wallet you already have. Same play money, same markets.</p>
      <button class="ghost" id="l-cancel">Not now</button>
    </div>
  </div>`);
  document.body.append(back);
  animate(back.firstElementChild, [{ transform: 'translateY(24px)', opacity: .4 }, { transform: 'none', opacity: 1 }],
    { duration: 400, easing: SPRING });
  back.onclick = (e) => { if (e.target === back) closeSheet(); };
  $('#l-burner').onclick = () => { closeSheet(); connect('burner'); };
  $('#l-phantom').onclick = () => { closeSheet(); connect('phantom'); };
  $('#l-cancel').onclick = () => closeSheet();
}

/** Who you are, and the two things you might want to do about it. */
function openAccount() {
  const k = S.wallet.publicKey.toBase58();
  const back = el(`<div class="sheet-backdrop" id="sheet-backdrop">
    <div class="sheet" role="dialog" aria-modal="true" aria-label="Account">
      <div class="grab"></div>
      <h3>Your account</h3>
      <div class="kv"><span>Wallet</span><b class="num small">${esc(k.slice(0, 12))}\u2026${esc(k.slice(-6))}</b></div>
      <div class="kv"><span>Type</span><b>${S.wallet.kind === 'burner' ? 'Quick wallet (this browser)' : 'Phantom'}</b></div>
      <div class="kv"><span>Balance</span><b class="num">${fmt(S.hack)} HACK</b></div>
      <div class="kv"><span>Fees paid in</span><b class="num">${S.sol.toFixed(3)} SOL</b></div>
      <div class="row">
        <button id="a-copy">Copy address</button>
        <a class="btn" href="${chain.explorer('address', k)}" target="_blank" rel="noopener">View on explorer</a>
      </div>
      ${S.wallet.kind === 'burner'
        ? '<button id="a-phantom">Switch to Phantom</button>' : ''}
      <button id="a-out">Log out</button>
      <p class="small muted" style="margin:0">${S.wallet.kind === 'burner'
        ? 'Logging out forgets this browser wallet. Its positions stay on-chain, but you need the key to sell them, so copy the address first if you care about them.'
        : 'Logging out just disconnects Phantom here.'}</p>
    </div>
  </div>`);
  document.body.append(back);
  animate(back.firstElementChild, [{ transform: 'translateY(24px)', opacity: .4 }, { transform: 'none', opacity: 1 }],
    { duration: 400, easing: SPRING });
  back.onclick = (e) => { if (e.target === back) closeSheet(); };
  $('#a-copy').onclick = async (e) => {
    press(e.currentTarget);
    try { await navigator.clipboard.writeText(k); toast('Address copied', 'ok'); }
    catch { toast('Could not copy \u2014 select it from the explorer page', 'err'); }
  };
  const ph = $('#a-phantom');
  if (ph) ph.onclick = () => { closeSheet(); connect('phantom'); };
  $('#a-out').onclick = async () => {
    closeSheet();
    await S.wallet.disconnect();
    S.wallet = null;
    S.balances = new Map();
    S.hack = 0;
    S.activity = [];
    renderWallet();
    renderView();
    toast('Logged out', 'ok');
  };
}

// ----------------------------------------------------------- market cards
function marketCard(m) {
  const resolved = m.status === 'resolved';
  const lead = m.prices.indexOf(Math.max(...m.prices));
  const shown = isBinary(m) ? 0 : lead;
  const delta = movement(m, shown);
  const hist = series(m, shown);
  const team = m.team;
  const sub = team
    ? [team.project, team.table && `table ${team.table}`].filter(Boolean).map(esc).join(' \u00b7 ')
    : esc(m.resolves ?? '');

  // Two outcomes is a tug of war; more than two is a race between lanes.
  const body = isBinary(m)
    ? `<div class="tug" style="--p:${(m.prices[0] * 100).toFixed(1)}%">
        <div class="tug-bar"><i class="yes"></i><i class="no"></i><span class="knot"></span></div>
        <div class="sides">
          ${['YES', 'NO'].map((name, i) => {
            const h = held(m, i);
            const cls = resolved ? (i === m.winner ? 'won' : 'lost') : (i === 0 ? 'yes' : 'no');
            return `<button class="side ${cls}" data-slug="${esc(m.slug)}" data-i="${i}" ${resolved ? 'disabled' : ''}>
              <span class="name">${name}</span>
              <span class="price num">${pct(m.prices[i])}</span>
              <span class="odds num">pays ${payout(m.prices[i])}</span>
              ${h > 0 ? `<span class="held">you hold ${fmt(h, 1)}</span>` : ''}
            </button>`;
          }).join('')}
        </div>
      </div>`
    : `<div class="race">
        ${m.outcomes.map((o, i) => {
          const h = held(m, i);
          const cls = resolved ? (i === m.winner ? 'won' : 'lost') : (i === lead ? 'lead' : '');
          return `<button class="lane ${cls}" data-slug="${esc(m.slug)}" data-i="${i}" ${resolved ? 'disabled' : ''}>
            <span class="who">${esc(o)}${h > 0 ? `<span class="muted small"> \u00b7 you hold ${fmt(h, 1)}</span>` : ''}</span>
            <span class="pct num">${pct(m.prices[i])} <span class="odds">${payout(m.prices[i])}</span></span>
            <span class="track"><span class="runner" data-lane="${esc(m.slug)}:${i}"></span></span>
          </button>`;
        }).join('')}
      </div>`;

  const win = resolved ? held(m, m.winner) : 0;
  return `<article class="card market ${resolved ? 'resolved' : ''}" data-slug="${esc(m.slug)}">
    <div class="ticker-head">
      <span class="sym">$${esc(symbol(m))}</span>
      ${team ? '<span class="tag team">Team</span>' : '<span class="tag">Event</span>'}
      <span class="spacer"></span>
      <span class="slip-no">NO. ${slipNo(m)}</span>
    </div>
    ${resolved ? `<span class="stamp">${esc(m.outcomes[m.winner])} \u00b7 settled</span>` : ''}
    <button class="open-head" data-open="${esc(m.slug)}">
      <h3>${esc(m.question)}</h3>
      <span class="open-hint">Open market &rarr;</span>
    </button>
    <div class="quote-line">
      <div>
        <div class="label">${isBinary(m) ? 'Chance' : esc(m.outcomes[shown])}</div>
        <div class="big num">${pct(m.prices[shown])}</div>
      </div>
      ${moveBadge(delta)}
      <span class="spacer"></span>
      <span class="stake-line">
        <span class="odds num">pays ${payout(m.prices[shown])}</span>
        <span class="small muted">${fmt(stakes(m), 0)} shares</span>
      </span>
    </div>
    ${priceChart(hist, { up: (delta ?? 0) >= 0 })}
    ${body}
    ${sub ? `<p class="small muted" style="margin:0">${sub}</p>` : ''}
    ${win > 0 ? `<button class="primary" data-redeem="${esc(m.slug)}">Collect ${fmt(win, 2)} HACK</button>` : ''}
  </article>`;
}

/** The strip of live prices along the top: a trading floor has a tape. */
function renderTape() {
  const host = $('#tape');
  if (!host) return;
  const live = S.markets.filter((m) => !m.missing && m.status !== 'resolved');
  if (!live.length) { host.innerHTML = ''; return; }
  const items = live.map((m) => {
    const i = isBinary(m) ? 0 : m.prices.indexOf(Math.max(...m.prices));
    const d = movement(m, i);
    const arrow = d === null || d === 0 ? '\u2014' : `${d > 0 ? '+' : ''}${d}`;
    return `<button class="tape-item" data-slug="${esc(m.slug)}">
      <span class="sym">$${esc(symbol(m))}</span>
      <span class="num">${pct(m.prices[i])}</span>
      ${sparkline(series(m, i), { up: (d ?? 0) >= 0 })}
      <span class="move ${d > 0 ? 'up' : d < 0 ? 'down' : 'flat'}">${arrow}</span>
    </button>`;
  }).join('');
  // Two copies so the marquee loops without a seam.
  host.innerHTML = `<div class="tape-run">${items}${items}</div>`;
  $$('.tape-item', host).forEach((b) => {
    b.onclick = () => {
      const card = $(`.market[data-slug="${b.dataset.slug}"]`);
      card?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (card) {
        animate(card, [{ transform: 'scale(1)' }, { transform: 'scale(1.02)' }, { transform: 'scale(1)' }],
          { duration: 600, easing: SPRING });
      }
    };
  });
}

function wireMarketCards(root) {
  // The board's yes/no buttons sit inside a row that opens the market, so
  // they have to stop the click travelling upwards.
  $$('.side:not([disabled]), .lane:not([disabled]), .acts button[data-slug]', root).forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      press(b);
      openSheet(b.dataset.slug, Number(b.dataset.i), e);
    };
  });
  $$('[data-open]', root).forEach((b) => {
    b.onclick = () => openMarket(b.dataset.open);
  });
  $$('[data-redeem]', root).forEach((b) => { b.onclick = () => { press(b); redeem(b.dataset.redeem); }; });
}

function renderMarketsView() {
  const host = $('#markets-list');
  if (!host) return;
  const key = S.markets.map((m) => m.missing ? 'x'
    : `${m.status}${m.winner}:${m.prices.map((p) => p.toFixed(4)).join(',')}:${m.outcomes.map((_, i) => held(m, i).toFixed(4)).join(',')}`)
    .join('|') + `|${Object.keys(S.history).length}`;
  if (!changed('markets', key)) return;

  if (!S.markets.length) {
    host.innerHTML = '<div class="card empty">Loading markets…<div class="skeleton" style="width:100%"></div></div>';
    return;
  }
  // The grid holds the event questions: a handful, each one different. Teams
  // are dozens of near-identical yes/no bets, so they get a board instead.
  const live = S.markets.filter((m) => !m.missing && m.kind !== 'team');
  const open = live.filter((m) => m.status !== 'resolved');
  const done = live.filter((m) => m.status === 'resolved');
  const pick = [...open, ...done];
  const first = !host.children.length;
  host.innerHTML = pick.length ? pick.map(marketCard).join('')
    : '<div class="card empty">Nothing here yet.</div>';
  wireMarketCards(host);
  $$('.runner', host).forEach((r) => {
    const [slug, i] = r.dataset.lane.split(':');
    const m = bySlug(slug);
    if (m) slideTo(r, m.prices[Number(i)]);
  });
  if (first) stagger($$('.market', host), 40);
}

// --------------------------------------------------------------- the rail
function renderRail() {
  const rail = $('#rail');
  const { cash, positions, total } = netWorth();
  const key = `${S.view}|${S.wallet?.publicKey.toBase58() ?? ''}|${total.toFixed(3)}|${S.board.length}|${S.activity.length}`;
  if (!changed('rail', key)) return;
  rail.innerHTML = `
    <section class="card pad panel" id="portfolio">
      <div class="section-head"><h2>Your book</h2></div>
      ${S.wallet ? `
        <div class="kv"><span>Cash</span><b class="num">${fmt(cash)}</b></div>
        <div class="kv"><span>Positions</span><b class="num">${fmt(positions)}</b></div>
        <div class="kv"><span><b>Net worth</b></span><b class="num" id="net-worth">0</b></div>
        ${S.hack <= 0 ? `<button class="primary" id="claim">Claim 1,000 HACK</button>` : ''}
        <p class="small muted" style="margin:0">Fees paid in SOL: <span class="num">${S.sol.toFixed(3)}</span>${
          S.wallet.kind === 'burner' ? '<br>Your key lives in this browser only.' : ''}</p>`
      : `<p class="muted small" style="margin:0">Log in and you get 1,000 play HACK. No email, nothing to install.</p>
         <button class="primary" id="rail-connect">Log in</button>`}
    </section>
    <section class="card pad panel">
      <div class="section-head"><h2>Leaderboard</h2><span class="small muted">net worth</span></div>
      <ol class="board" id="board-mini"></ol>
    </section>`;
  if (S.wallet) rollTo($('#net-worth'), total, { digits: 2 });
  const claim = $('#claim');
  if (claim) claim.onclick = (e) => { press(e.currentTarget); doClaim(e.currentTarget); };
  const rc = $('#rail-connect');
  if (rc) rc.onclick = (e) => { press(e.currentTarget); openLogin(); };
  renderBoard($('#board-mini'), 8);
}

function renderBoard(host, limit) {
  if (!host) return;
  if (!S.board.length) { host.innerHTML = '<li class="muted small">No traders yet. Be first.</li>'; return; }
  const me = S.wallet?.publicKey.toBase58();
  host.innerHTML = S.board.slice(0, limit).map((r, i) => `
    <li class="${r.wallet === me ? 'me' : ''}">
      <span class="rank">${i + 1}</span>
      <span>${esc(r.name)}</span>
      <span class="num">${fmt(r.netWorth, 0)}</span>
    </li>`).join('');
}

// ------------------------------------------------------------------ views
function viewMarkets() {
  return `
    <div class="tape" id="tape" aria-hidden="true"></div>
    ${S.wallet ? '' : `<section class="card hero">
      <p class="kicker">Hack the North 2026 &middot; play money, real chain</p>
      <h1>Put your money where your&nbsp;guess is.</h1>
      <p>Every price on this page is set by a program on Solana, not by us. Buy the outcome you
      believe, sell when the room disagrees, and settle up when the prizes are announced.</p>
      <div class="row"><button class="primary" id="hero-start">Take 1,000 HACK &rarr;</button>
      <button id="hero-phantom">I have a wallet</button></div>
    </section>`}
    <div class="stats" id="stats"></div>
    <section class="panel" id="lead-panel">
      <div class="section-head"><h2>Moving now</h2><span class="small muted">the biggest swing since these markets opened</span></div>
      <div id="lead"></div>
    </section>
    <section class="panel">
      <div class="section-head"><h2>The questions</h2><span class="small muted">about the event itself</span></div>
      <div class="markets" id="markets-list"></div>
    </section>
    <section class="panel">
      <div class="section-head">
        <h2>Teams</h2>
        <span class="small muted" id="market-count"></span>
        <span class="spacer"></span>
        <div class="filters" id="sorts">
          ${[['hot', 'Hot'], ['chance', 'Chance'], ['volume', 'Volume'], ['new', 'New']].map(([k, label]) =>
            `<button class="tiny ${S.sort === k ? 'on' : ''}" data-sort="${k}">${label}</button>`).join('')}
        </div>
      </div>
      <div class="board-wrap card" id="team-board"></div>
    </section>`;
}

/** The one market worth looking at first, given room to breathe. */
function renderLead() {
  const host = $('#lead');
  if (!host) return;
  const open = S.markets.filter((m) => !m.missing && m.status !== 'resolved');
  if (!open.length) { host.innerHTML = ''; return; }
  const scored = open.map((m) => {
    const i = isBinary(m) ? 0 : m.prices.indexOf(Math.max(...m.prices));
    return { m, i, delta: movement(m, i) ?? 0 };
  }).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || stakes(b.m) - stakes(a.m));
  const { m, i, delta } = scored[0];
  const key = `${m.slug}|${m.prices[i].toFixed(4)}|${delta}|${held(m, i).toFixed(2)}`;
  if (!changed('lead', key)) return;

  const hist = series(m, i);
  host.innerHTML = `<article class="card market lead" data-slug="${esc(m.slug)}">
    <div class="lead-copy">
      <div class="ticker-head">
        <span class="sym">$${esc(symbol(m))}</span>
        ${m.kind === 'team' ? '<span class="tag team">Team</span>' : '<span class="tag">Event</span>'}
        ${moveBadge(delta)}
        <span class="spacer"></span>
        <span class="slip-no">NO. ${slipNo(m)}</span>
      </div>
      <button class="open-head" data-open="${esc(m.slug)}">
        <h3>${esc(m.question)}</h3>
        <span class="open-hint">Open market &rarr;</span>
      </button>
      <div class="quote-line">
        <div>
          <div class="label">${isBinary(m) ? 'Chance' : esc(m.outcomes[i])}</div>
          <div class="big num">${pct(m.prices[i])}</div>
        </div>
        <span class="spacer"></span>
        <span class="stake-line">
          <span class="odds num">pays ${payout(m.prices[i])}</span>
          <span class="small muted">${fmt(stakes(m), 0)} shares</span>
        </span>
      </div>
      <div class="sides">
        ${m.outcomes.slice(0, 2).map((o, k) => `
          <button class="side ${k === 0 ? 'yes' : 'no'}" data-slug="${esc(m.slug)}" data-i="${k}">
            <span class="name">${esc(o)}</span>
            <span class="price num">${pct(m.prices[k])}</span>
            <span class="odds num">pays ${payout(m.prices[k])}</span>
          </button>`).join('')}
      </div>
    </div>
    <div class="lead-chart">${priceChart(hist, { up: delta >= 0, h: 150 })}</div>
  </article>`;
  wireMarketCards(host);
  popIn($('.lead', host));
}

/** Teams are many and alike, so they belong on a board, not in cards. */
function renderTeamBoard() {
  const host = $('#team-board');
  if (!host) return;
  const teams = S.markets.filter((m) => !m.missing && m.kind === 'team');
  const rows = teams.map((m) => ({ m, delta: movement(m, 0) ?? 0, vol: stakes(m) }));
  const order = {
    hot: (a, b) => Math.abs(b.delta) - Math.abs(a.delta) || b.vol - a.vol,
    chance: (a, b) => b.m.prices[0] - a.m.prices[0],
    volume: (a, b) => b.vol - a.vol,
    new: (a, b) => teams.indexOf(b.m) - teams.indexOf(a.m),
  }[S.sort];
  rows.sort(order);
  const key = `${S.sort}|` + rows.map((r) => `${r.m.slug}${r.m.prices[0].toFixed(3)}${r.delta}${held(r.m, 0).toFixed(1)}`).join('');
  if (!changed('board', key)) return;

  if (!rows.length) {
    host.innerHTML = '<div class="empty">No teams registered yet. Yours could be first.</div>';
    return;
  }
  host.innerHTML = `
    <div class="board-head">
      <span>#</span><span>Team</span><span class="hide-sm">Trend</span>
      <span class="ralign">Chance</span><span class="ralign hide-sm">Move</span><span></span>
    </div>
    ${rows.map(({ m, delta }, n) => {
      const h = held(m, 0) + held(m, 1);
      return `<div class="board-row" data-open="${esc(m.slug)}">
        <span class="rank num">${n + 1}</span>
        <span class="who">
          <b>${esc(m.team?.name ?? m.question)}</b>
          ${m.team?.project ? `<span class="small muted hide-sm">${esc(m.team.project)}</span>` : ''}
          ${h > 0.001 ? `<span class="small">you hold ${fmt(h, 1)}</span>` : ''}
        </span>
        <span class="hide-sm">${sparkline(series(m, 0), { w: 72, h: 20, up: delta >= 0 })}</span>
        <span class="chance num">${pct(m.prices[0])}</span>
        <span class="ralign hide-sm">${moveBadge(delta)}</span>
        <span class="acts">
          <button class="tiny yes" data-slug="${esc(m.slug)}" data-i="0">Yes</button>
          <button class="tiny no" data-slug="${esc(m.slug)}" data-i="1">No</button>
        </span>
      </div>`;
    }).join('')}`;
  wireMarketCards(host);
  $$('.board-row', host).forEach((r, i) => popIn(r, Math.min(i, 8) * 30));
}

/** The numbers that tell you the room is alive. */
function renderStats() {
  const host = $('#stats');
  if (!host) return;
  const live = S.markets.filter((m) => !m.missing);
  const volume = live.reduce((a, m) => a + stakes(m), 0);
  const cells = [
    ['Markets', live.filter((m) => m.status !== 'resolved').length],
    ['Traders', S.board.length],
    ['Shares traded', Math.round(volume).toLocaleString('en-US')],
    ['Teams listed', live.filter((m) => m.kind === 'team').length],
  ];
  const key = cells.map((c) => c[1]).join('|');
  if (!changed('stats', key)) return;
  host.innerHTML = cells.map(([label, value]) => `
    <div class="stat"><span class="label">${label}</span><b class="num">${value}</b></div>`).join('');
}

/** A shelf of the markets that moved most: the reason to look now. */
function renderTrending() {
  const host = $('#trending');
  if (!host) return;
  const scored = S.markets
    .filter((m) => !m.missing && m.status !== 'resolved')
    .map((m) => {
      const i = isBinary(m) ? 0 : m.prices.indexOf(Math.max(...m.prices));
      return { m, i, delta: movement(m, i) ?? 0 };
    })
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || stakes(b.m) - stakes(a.m))
    .slice(0, 6);
  const key = scored.map((x) => `${x.m.slug}${x.delta}${x.m.prices[x.i].toFixed(3)}`).join('|');
  if (!changed('trending', key)) return;
  if (!scored.length) { host.innerHTML = ''; return; }
  host.innerHTML = scored.map(({ m, i, delta }) => `
    <button class="trend-card" data-slug="${esc(m.slug)}">
      <span class="sym">$${esc(symbol(m))}</span>
      <span class="trend-q">${esc(m.team?.name ?? m.short ?? m.question)}</span>
      <span class="trend-foot">
        <b class="num">${pct(m.prices[i])}</b>
        <span class="move ${delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat'}">${
          delta === 0 ? 'new' : `${delta > 0 ? '\u25b2' : '\u25bc'} ${Math.abs(delta)}`}</span>
      </span>
      ${sparkline(series(m, i), { w: 120, h: 26, up: delta >= 0 })}
    </button>`).join('');
  $$('.trend-card', host).forEach((b, idx) => {
    popIn(b, idx * 50);
    b.onclick = () => {
      press(b);
      const card = $(`.market[data-slug="${b.dataset.slug}"]`);
      card?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (card) {
        animate(card, [{ transform: 'translate(0,0)' }, { transform: 'translate(-3px,-3px)' }, { transform: 'translate(0,0)' }],
          { duration: 520, easing: SPRING });
      }
    };
  });
}

/** Everything about one market, on its own page. */
function viewDetail() {
  const m = bySlug(S.detail);
  if (!m || m.missing) return '<section class="card pad panel"><p>That market is not open yet.</p></section>';
  const resolved = m.status === 'resolved';
  const lead = m.prices.indexOf(Math.max(...m.prices));
  const shown = isBinary(m) ? 0 : lead;
  const delta = movement(m, shown);
  const hist = series(m, shown);
  const samples = (S.history[m.slug] ?? []).length;
  const team = m.team;
  const mine = m.outcomes.map((o, i) => ({ o, i, h: held(m, i) })).filter((x) => x.h > 0.001);
  const mineValue = mine.reduce((a, x) => a + (resolved ? (x.i === m.winner ? x.h : 0) : x.h * m.prices[x.i]), 0);

  return `
    <button class="back" id="back">&larr; All markets</button>
    <section class="card market detail">
      <div class="ticker-head">
        <span class="sym">$${esc(symbol(m))}</span>
        ${team ? '<span class="tag team">Team</span>' : '<span class="tag">Event</span>'}
        <span class="spacer"></span>
        <span class="slip-no">NO. ${slipNo(m)}</span>
      </div>
      ${resolved ? `<span class="stamp">${esc(m.outcomes[m.winner])} \u00b7 settled</span>` : ''}
      <h1>${esc(m.question)}</h1>
      <div class="quote-line">
        <div>
          <div class="label">${isBinary(m) ? 'Chance' : esc(m.outcomes[shown])}</div>
          <div class="big num">${pct(m.prices[shown])}</div>
        </div>
        ${moveBadge(delta)}
        <span class="spacer"></span>
        <span class="stake-line">
          <span class="odds num">pays ${payout(m.prices[shown])}</span>
          <span class="small muted">${fmt(stakes(m), 0)} shares</span>
        </span>
      </div>
      ${priceChart(hist, { up: (delta ?? 0) >= 0, h: 170 })}
      <p class="small muted chart-foot">${samples > 1
        ? `${samples} price samples \u00b7 one a minute since this page has been watching`
        : 'price history starts as soon as people trade'}</p>
      <div class="detail-trade">
        ${m.outcomes.map((o, i) => {
          const cls = resolved ? (i === m.winner ? 'won' : 'lost') : (isBinary(m) ? (i === 0 ? 'yes' : 'no') : '');
          const h = held(m, i);
          return `<button class="side ${cls}" data-slug="${esc(m.slug)}" data-i="${i}" ${resolved ? 'disabled' : ''}>
            <span class="name">${esc(o)}</span>
            <span class="price num">${pct1(m.prices[i])}</span>
            <span class="odds num">pays ${payout(m.prices[i])}</span>
            ${h > 0 ? `<span class="held">you hold ${fmt(h, 2)}</span>` : ''}
          </button>`;
        }).join('')}
      </div>
      ${resolved && held(m, m.winner) > 0
        ? `<button class="primary" data-redeem="${esc(m.slug)}">Collect ${fmt(held(m, m.winner), 2)} HACK</button>` : ''}
    </section>

    <section class="card pad panel">
      <div class="section-head"><h2>Your position</h2></div>
      ${S.wallet ? (mine.length
        ? `${mine.map((x) => `<div class="kv"><span>${esc(x.o)}</span><b class="num">${fmt(x.h, 2)} shares</b></div>`).join('')}
           <div class="kv"><span>Worth now</span><b class="num">${fmt(mineValue)} HACK</b></div>`
        : '<p class="muted small" style="margin:0">Nothing yet. Pick a side above.</p>')
      : '<p class="muted small" style="margin:0">Log in to take a position.</p>'}
    </section>

    <section class="card pad panel">
      <div class="section-head"><h2>How this settles</h2></div>
      <p style="margin:0">${esc(m.resolves || 'An organizer resolves this market once the result is known.')}</p>
      ${team ? `<div class="kv"><span>Team</span><b>${esc(team.name)}</b></div>
        ${team.project ? `<div class="kv"><span>Project</span><b>${esc(team.project)}</b></div>` : ''}
        ${team.table ? `<div class="kv"><span>Table</span><b>${esc(team.table)}</b></div>` : ''}
        ${team.members?.length ? `<div class="kv"><span>Members</span><b>${team.members.map((x) => esc(x.name)).join(', ')}</b></div>` : ''}`
        : ''}
    </section>

    <section class="card pad panel">
      <div class="section-head"><h2>On chain</h2><span class="small muted">nothing here is ours to edit</span></div>
      <div class="kv"><span>Market account</span>
        <a class="num small" href="${chain.explorer('address', m.address)}" target="_blank" rel="noopener">${esc(short(m.address))}</a></div>
      ${m.createSig ? `<div class="kv"><span>Opened by</span>
        <a class="num small" href="${chain.explorer('tx', m.createSig)}" target="_blank" rel="noopener">${esc(short(m.createSig))}</a></div>` : ''}
      ${m.commitment ? `<div class="kv"><span>Question hash</span><b class="num small">${esc(m.commitment.slice(0, 16))}\u2026</b></div>` : ''}
      <div class="kv"><span>Liquidity (b)</span><b class="num">${fmt(m.b, 1)}</b></div>
      <div class="kv"><span>Shares outstanding</span><b class="num">${m.q.map((x) => fmt(x, 1)).join(' / ')}</b></div>
      <p class="small muted" style="margin:0">The question and its outcomes were hashed into the transaction that
      opened this market, so the wording you are betting on cannot be changed afterwards. Prices come from the
      program's own formula, and only an organizer's key can declare the result \u2014 once.</p>
    </section>`;
}

function viewLeaders() {
  return `<section class="card pad panel">
    <div class="section-head"><h2>Leaderboard</h2><span class="small muted">cash + positions, priced live</span></div>
    <ol class="board" id="board-full"></ol>
  </section>`;
}

function viewYou() {
  const { cash, positions, total } = netWorth();
  const lines = [];
  for (const m of S.markets) {
    if (m.missing) continue;
    m.outcomes.forEach((o, i) => {
      const h = held(m, i);
      if (h <= 0) return;
      const v = m.status === 'resolved' ? (i === m.winner ? h : 0) : h * m.prices[i];
      lines.push(`<div class="kv"><span>${esc(o)} <span class="muted small">· ${esc(m.team?.name ?? m.slug)}</span></span>
        <b class="num">${fmt(v)}</b></div>`);
    });
  }
  return `<section class="card pad panel">
      <div class="section-head"><h2>Your book</h2></div>
      ${S.wallet ? `
        <div class="kv"><span>Cash</span><b class="num">${fmt(cash)}</b></div>
        <div class="kv"><span>Positions</span><b class="num">${fmt(positions)}</b></div>
        <div class="kv"><span><b>Net worth</b></span><b class="num">${fmt(total)}</b></div>
        ${lines.length ? `<h3 class="small" style="margin-top:8px">Holdings</h3>${lines.join('')}`
          : '<p class="muted small" style="margin:0">No positions yet.</p>'}
        ${S.hack <= 0 ? '<button class="primary" id="you-claim">Claim 1,000 HACK</button>' : ''}`
      : '<p class="muted">Log in to get your 1,000 HACK.</p><button class="primary" id="you-connect">Log in</button>'}
    </section>
    <section class="card pad panel">
      <div class="section-head"><h2>Recent trades</h2></div>
      <ul class="board" id="activity">${S.activity.length ? S.activity.slice(0, 10).map((a) =>
        `<li style="grid-template-columns:1fr auto"><span>${esc(a.text)}</span>
          <a class="small muted" href="${chain.explorer('tx', a.sig)}" target="_blank" rel="noopener">tx</a></li>`).join('')
        : '<li class="muted small">Nothing yet.</li>'}</ul>
    </section>`;
}

function viewRegister() {
  return `<section class="card pad panel form" id="register">
    <div class="section-head"><h2>Register your team</h2></div>
    <p class="muted small" style="margin:0">This opens a real market on Solana asking whether your team
    wins a prize. Everyone at the event can then buy YES or NO on you. Takes about ten seconds.</p>
    <div>
      <label for="r-team">Team name</label>
      <input id="r-team" maxlength="48" placeholder="Rubber Duck Debuggers" autocomplete="organization" />
    </div>
    <div class="two">
      <div><label for="r-project">Project (optional)</label><input id="r-project" maxlength="80" placeholder="What are you building?" /></div>
      <div><label for="r-table">Table (optional)</label><input id="r-table" maxlength="12" placeholder="E7-042" /></div>
    </div>
    <div>
      <label>Members (optional)</label>
      <div class="members" id="r-members"></div>
      <button class="tiny" id="r-add" type="button" style="margin-top:8px">+ Add member</button>
    </div>
    <button class="primary" id="r-go">Open our market</button>
    <p class="status" id="r-status"></p>
  </section>`;
}

function renderView() {
  const host = $('#view');
  const html = { markets: viewMarkets, leaders: viewLeaders, register: viewRegister,
    you: viewYou, detail: viewDetail }[S.view]();
  host.innerHTML = html;
  lastKey.markets = null;
  lastKey.rail = null;
  $('#main').classList.toggle('with-rail', S.view === 'markets');
  $('#rail').hidden = S.view !== 'markets';
  if (S.view === 'detail') {
    wireMarketCards(host);
    const back = $('#back');
    if (back) back.onclick = () => { press(back); openMarket(null); };
  }

  if (S.view === 'markets') {
    renderMarketsView();
    renderTape();
    renderLead();
    renderTeamBoard();
    renderStats();
    $$('#sorts button').forEach((b) => {
      b.onclick = () => {
        press(b);
        S.sort = b.dataset.sort;
        $$('#sorts button').forEach((x) => x.classList.toggle('on', x.dataset.sort === S.sort));
        lastKey.board = null;
        renderTeamBoard();
      };
    });
    const hs = $('#hero-start');
    if (hs) hs.onclick = (e) => { press(e.currentTarget); connect('burner'); };
    const hp = $('#hero-phantom');
    if (hp) hp.onclick = (e) => { press(e.currentTarget); openLogin(); };
  }
  if (S.view === 'leaders') renderBoard($('#board-full'), 25);
  if (S.view === 'register') setupRegister();
  if (S.view === 'you') {
    const c = $('#you-claim');
    if (c) c.onclick = (e) => { press(e.currentTarget); doClaim(e.currentTarget); };
    const w = $('#you-connect');
    if (w) w.onclick = (e) => { press(e.currentTarget); openLogin(); };
  }
  $$('#view > *').forEach((n, i) => popIn(n, i * 60));
  renderRail();
}

/** Open (or close, with null) a market's own page. Deep-linked, so a slip
 *  can be shared or scanned straight from a badge table. */
function openMarket(slug) {
  S.detail = slug;
  S.view = slug ? 'detail' : 'markets';
  const hash = slug ? `#m/${slug}` : '#markets';
  if (location.hash !== hash) history.pushState({ slug }, '', hash);
  $$('[role="tab"]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === 'markets' && !slug)));
  moveIndicator($('#tab-indicator'), $('#tabs [data-view="markets"]'));
  renderView();
  scrollTo({ top: 0, behavior: 'smooth' });
}

function setView(view) {
  if (S.view === view) return;
  S.detail = null;
  S.view = view;
  $$('[role="tab"]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === view)));
  moveIndicator($('#tab-indicator'), $(`#tabs [data-view="${view}"]`));
  renderView();
}

// -------------------------------------------------------------- register
function memberRow(value = '') {
  const row = el(`<div class="member">
      <input maxlength="32" placeholder="Name" value="${esc(value)}" />
      <button class="tiny" type="button" aria-label="Remove member">Remove</button>
    </div>`);
  row.querySelector('button').onclick = () => {
    animate(row, [{ opacity: 1 }, { opacity: 0, transform: 'translateX(12px)' }], { duration: 160 });
    setTimeout(() => row.remove(), 150);
  };
  return row;
}

function setupRegister() {
  const list = $('#r-members');
  list.append(memberRow(), memberRow());
  $('#r-add').onclick = (e) => {
    press(e.currentTarget);
    const row = memberRow();
    list.append(row);
    popIn(row);
    row.querySelector('input').focus();
  };
  $('#r-go').onclick = submitTeam;
  $('#r-team').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitTeam(); });
}

async function submitTeam() {
  const st = $('#r-status');
  const go = $('#r-go');
  const team = $('#r-team').value.trim();
  if (!team) {
    st.className = 'status err';
    st.textContent = 'Your team needs a name.';
    animate($('#r-team'), [{ transform: 'translateX(0)' }, { transform: 'translateX(-6px)' },
      { transform: 'translateX(6px)' }, { transform: 'translateX(0)' }], { duration: 260 });
    $('#r-team').focus();
    return;
  }
  go.disabled = true;
  st.className = 'status';
  st.textContent = 'Opening your market on Solana…';
  try {
    const res = await fetch('/api/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        team,
        project: $('#r-project').value.trim(),
        table: $('#r-table').value.trim(),
        members: $$('#r-members input').map((i) => i.value.trim()).filter(Boolean).map((name) => ({ name })),
      }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? 'registration failed');
    st.className = 'status ok';
    st.textContent = body.duplicate
      ? `${body.market.team.name} is already listed — find it in Markets.`
      : `You're live. ${body.market.team.name} is now trading.`;
    if (!body.duplicate) confetti({ x: innerWidth / 2, y: innerHeight * 0.4 });
    toast(body.duplicate ? 'That team was already registered' : 'Market opened', 'ok');
    await refreshMeta(true);
    setTimeout(() => setView('markets'), 1200);
  } catch (e) {
    st.className = 'status err';
    st.textContent = e.message;
    go.disabled = false;
  }
}

// ----------------------------------------------------------- trade sheet
function openSheet(slug, i, event) {
  if (!S.wallet) { openLogin(); return; }
  const m = bySlug(slug);
  S.sheet = { slug, i, mode: 'buy', origin: event ? { x: event.clientX, y: event.clientY } : null };
  const back = el('<div class="sheet-backdrop" id="sheet-backdrop"></div>');
  back.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-label="Trade">
      <div class="grab"></div>
      <div>
        <p class="small muted" style="margin:0 0 4px">${esc(m.question)}</p>
        <h3 id="sheet-title"></h3>
      </div>
      <nav class="tabs" id="sheet-tabs" style="justify-self:start"></nav>
      <div>
        <label for="amount" id="amount-label"></label>
        <input id="amount" inputmode="decimal" placeholder="0" autocomplete="off" />
      </div>
      <div class="chips" id="chips"></div>
      <dl class="quote" id="quote"></dl>
      <button class="primary" id="go"></button>
      <p class="status" id="sheet-status"></p>
    </div>`;
  document.body.append(back);
  animate(back.firstElementChild, [{ transform: 'translateY(26px)', opacity: .4 }, { transform: 'none', opacity: 1 }],
    { duration: 420, easing: SPRING });
  back.onclick = (e) => { if (e.target === back) closeSheet(); };
  $('#amount').oninput = updateQuote;
  $('#go').onclick = execute;
  renderSheetControls();
  setTimeout(() => $('#amount').focus(), 60);
}

function closeSheet() {
  const back = $('#sheet-backdrop');
  if (!back) return;
  S.sheet = null;
  const out = animate(back, [{ opacity: 1 }, { opacity: 0 }], { duration: 140 });
  if (out) out.onfinish = () => back.remove(); else back.remove();
}

function renderSheetControls() {
  const { slug, i, mode } = S.sheet;
  const m = bySlug(slug);
  const h = held(m, i);
  $('#sheet-title').textContent = isBinary(m) ? `${m.outcomes[i]} · ${pct1(m.prices[i])}` : m.outcomes[i];
  $('#sheet-tabs').innerHTML = `<button data-mode="buy" aria-selected="${mode === 'buy'}">Buy</button>` +
    (h > 0 ? `<button data-mode="sell" aria-selected="${mode === 'sell'}">Sell</button>` : '');
  $$('#sheet-tabs button').forEach((b) => {
    b.onclick = () => { S.sheet.mode = b.dataset.mode; $('#amount').value = ''; renderSheetControls(); };
  });
  $('#amount-label').textContent = mode === 'buy' ? 'Spend (HACK)' : `Sell shares (you hold ${fmt(h, 2)})`;
  const chips = mode === 'buy' ? [10, 50, 100, 250] : [0.25, 0.5, 1];
  $('#chips').innerHTML = chips.map((c) =>
    `<button data-c="${c}">${mode === 'buy' ? c : c === 1 ? 'All' : `${c * 100}%`}</button>`).join('');
  $$('#chips button').forEach((b) => {
    b.onclick = () => {
      press(b);
      const c = Number(b.dataset.c);
      $('#amount').value = mode === 'buy' ? Math.min(c, Math.floor(S.hack)) : Number((h * c).toFixed(6));
      updateQuote();
    };
  });
  $('#go').textContent = mode === 'buy' ? 'Buy' : 'Sell';
  updateQuote();
}

function updateQuote() {
  if (!S.sheet) return;
  const { slug, i, mode } = S.sheet;
  const m = bySlug(slug);
  const amt = Number($('#amount').value);
  const q = $('#quote');
  const go = $('#go');
  if (!(amt > 0)) {
    q.innerHTML = `<dt>Price now</dt><dd>${pct1(m.prices[i])}</dd>`;
    go.disabled = true;
    return;
  }
  if (mode === 'buy') {
    const shares = chain.quoteBuy(m, i, amt);
    const after = chain.priceAfterBuy(m, i, shares);
    q.innerHTML = `
      <dt>You get</dt><dd>${fmt(shares, 2)} shares</dd>
      <dt>Average price</dt><dd>${pct1(amt / shares)}</dd>
      <dt>Price moves</dt><dd>${pct1(m.prices[i])} → ${pct1(after)}</dd>
      <dt>If it happens</dt><dd class="up">+${fmt(shares - amt)}</dd>
      <dt>If it doesn't</dt><dd class="down">−${fmt(amt)}</dd>`;
    go.disabled = S.busy || amt > S.hack;
    if (amt > S.hack) q.innerHTML += '<dt class="down">Not enough HACK</dt><dd></dd>';
  } else {
    const h = held(m, i);
    const refund = chain.quoteSell(m, i, Math.min(amt, h));
    q.innerHTML = `<dt>You receive</dt><dd>${fmt(refund)} HACK</dd>
      <dt>Average price</dt><dd>${pct1(refund / amt)}</dd>`;
    go.disabled = S.busy || amt > h + 1e-9;
  }
}

async function execute() {
  const { slug, i, mode, origin } = S.sheet;
  const m = bySlug(slug);
  const amt = Number($('#amount').value);
  const st = $('#sheet-status');
  S.busy = true;
  $('#go').disabled = true;
  st.className = 'status';
  st.textContent = S.wallet.kind === 'phantom' ? 'Approve in Phantom…' : 'Signing and sending…';
  try {
    let sig, text;
    if (mode === 'buy') {
      const shares = chain.quoteBuy(m, i, amt);
      // Slippage guard: the PROGRAM rejects the fill if someone moved the
      // price more than 3% before our transaction landed.
      sig = await chain.sendWithWallet(S.wallet, chain.buyIxs(S.wallet.publicKey, m.pubkey, i, amt, shares * 0.97));
      text = `Bought ${fmt(shares, 2)} ${m.outcomes[i]} for ${fmt(amt)}`;
    } else {
      const refund = chain.quoteSell(m, i, amt);
      sig = await chain.sendWithWallet(S.wallet, chain.sellIxs(S.wallet.publicKey, m.pubkey, i, amt, refund * 0.97));
      text = `Sold ${fmt(amt, 2)} ${m.outcomes[i]} for ${fmt(refund)}`;
    }
    S.activity.unshift({ text, sig, t: Date.now() });
    saveActivity();
    confetti(origin);
    toast(text, 'ok', chain.explorer('tx', sig));
    closeSheet();
    await poll();
    pollBoard();
  } catch (e) {
    st.className = 'status err';
    st.textContent = chain.explainError(e);
  } finally {
    S.busy = false;
    updateQuote();
  }
}

async function redeem(slug) {
  const m = bySlug(slug);
  try {
    toast('Redeeming…');
    const sig = await chain.sendWithWallet(S.wallet, chain.redeemIxs(S.wallet.publicKey, m.pubkey, m.winner));
    S.activity.unshift({ text: `Redeemed ${m.outcomes[m.winner]}`, sig, t: Date.now() });
    saveActivity();
    confetti();
    toast('Winnings paid out', 'ok', chain.explorer('tx', sig));
    await poll();
  } catch (e) {
    toast(chain.explainError(e), 'err');
  }
}

// ---------------------------------------------------------------- wallet
async function connect(kind) {
  try {
    S.wallet = kind === 'phantom' ? await wallets.connectPhantom() : wallets.connectBurner();
    loadActivity();
    renderWallet();
    renderView();
    await poll();
    if (S.hack <= 0) doClaim();
  } catch (e) {
    toast(chain.explainError(e), 'err');
  }
}

async function doClaim(button) {
  if (button) button.disabled = true;
  const t = toast('Minting your 1,000 HACK on Solana…');
  try {
    const res = await fetch('/api/faucet', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ wallet: S.wallet.publicKey.toBase58(), name: localStorage.getItem('htnmkt.name') ?? '' }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? 'faucet failed');
    t.remove();
    if (!body.already) confetti();
    toast(body.already ? 'This wallet already claimed' : 'You have 1,000 HACK. Go bet.', 'ok');
    await poll();
    pollBoard();
  } catch (e) {
    t.remove();
    toast(e.message, 'err');
    if (button) button.disabled = false;
  }
}

function saveActivity() {
  if (!S.wallet) return;
  try {
    localStorage.setItem(`htnmkt.act.${S.wallet.publicKey.toBase58()}`, JSON.stringify(S.activity.slice(0, 30)));
  } catch { /* private mode: activity is a nicety, not state we depend on */ }
}
function loadActivity() {
  S.activity = [];
  if (!S.wallet) return;
  try {
    S.activity = JSON.parse(localStorage.getItem(`htnmkt.act.${S.wallet.publicKey.toBase58()}`) ?? '[]');
  } catch { /* ignore */ }
}

// --------------------------------------------------------------- polling
async function poll() {
  try {
    // Prices first and draw them: the balance call must never hold the
    // market list hostage.
    S.markets = await chain.fetchMarkets();
    S.lastOk = Date.now();
    draw();
    if (S.wallet) {
      const [bal, sol] = await Promise.all([
        chain.fetchBalances(S.wallet.publicKey),
        chain.solBalance(S.wallet.publicKey),
      ]);
      S.balances = bal;
      S.sol = sol;
      S.hack = bal.get(chain.HACK.toBase58()) ?? 0;
    }
  } catch (e) {
    if (Date.now() - S.lastOk > 20_000) toast(`Solana is slow to answer (${chain.explainError(e)})`, 'err');
  }
  draw();
}

/** Paint whatever we currently know. */
function draw() {
  $('#live').classList.toggle('stale', Date.now() - S.lastOk > 20_000);
  renderWallet();
  if (S.view === 'markets') {
    renderMarketsView();
    renderTape();
    renderLead();
    renderTeamBoard();
    renderStats();
  }
  if (S.view === 'you' || S.view === 'detail') renderView();
  renderRail();
  const count = $('#market-count');
  if (count) {
    const teams = S.markets.filter((m) => !m.missing && m.kind === 'team').length;
    count.textContent = `${teams} registered · tap a row to open it`;
  }
  if (S.sheet) updateQuote();
}

async function pollBoard() {
  try {
    S.board = await (await fetch('/api/leaderboard')).json();
    renderBoard($('#board-mini'), 8);
    renderBoard($('#board-full'), 25);
    renderStats();
  } catch { /* ignore */ }
  try { S.history = await (await fetch('/api/history')).json(); } catch { /* ignore */ }
  await refreshMeta(false);
}

/** Teams register during the event, so pick up new markets without a reload. */
async function refreshMeta(force) {
  try {
    const meta = await (await fetch('/api/markets')).json();
    meta.sort((a, b) => (a.kind === 'team') - (b.kind === 'team'));
    if (force || meta.length !== S.meta.length) {
      S.meta = meta;
      await poll();
    }
  } catch { /* ignore */ }
}

// ------------------------------------------------------------------- boot
$$('[role="tab"]').forEach((b) => {
  b.onclick = () => { press(b); setView(b.dataset.view); };
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });
addEventListener('popstate', () => {
  const m = location.hash.match(/^#m\/(.+)$/);
  S.detail = m ? decodeURIComponent(m[1]) : null;
  S.view = S.detail ? 'detail' : 'markets';
  renderView();
});
window.addEventListener('resize', () => moveIndicator($('#tab-indicator'), $(`#tabs [data-view="${S.view}"]`)));

(async function boot() {
  const deep = location.hash.match(/^#m\/(.+)$/);
  if (deep) { S.detail = decodeURIComponent(deep[1]); S.view = 'detail'; }
  renderView();
  moveIndicator($('#tab-indicator'), $('#tabs [data-view="markets"]'));
  try {
    const [config, meta, history] = await Promise.all([
      fetch('/api/config').then((r) => r.json()),
      fetch('/api/markets').then((r) => r.json()),
      fetch('/api/history').then((r) => r.json()).catch(() => ({})),
    ]);
    S.history = history;
    chain.init(config);
    S.meta = meta.sort((a, b) => (a.kind === 'team') - (b.kind === 'team'));
    S.wallet = await wallets.restore();
    loadActivity();
  } catch (e) {
    toast(`Could not load the market: ${e.message}`, 'err');
  }
  renderWallet();
  renderView();
  await poll();
  pollBoard();
  // Devnet's public RPC rate-limits the heavy calls, so poll gently: the
  // market moves when someone trades, and a trade refreshes immediately.
  setInterval(poll, 6000);
  setInterval(pollBoard, 30_000);
})();
