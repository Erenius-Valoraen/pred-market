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
  if (!changed('wallet', `${S.wallet?.publicKey.toBase58() ?? ''}|${S.hack.toFixed(4)}`)) return;
  if (!S.wallet) {
    w.innerHTML = '<button class="primary" id="w-connect">Start trading</button>';
    $('#w-connect').onclick = (e) => { press(e.currentTarget); connect('burner'); };
    return;
  }
  const k = S.wallet.publicKey.toBase58();
  w.innerHTML = `<span class="pill" title="Your play-money balance"><b class="num" id="hack-top">0.00</b> HACK</span>
    <a class="pill addr" href="${chain.explorer('address', k)}" target="_blank" rel="noopener">${esc(short(k))}</a>`;
  rollTo($('#hack-top'), S.hack, { digits: 2 });
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
              <span class="name">${name}${resolved && i === m.winner ? ' \u00b7 won' : ''}</span>
              <span class="price num">${pct(m.prices[i])}</span>
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
            <span class="pct num">${pct(m.prices[i])}</span>
            <span class="track"><span class="runner" data-lane="${esc(m.slug)}:${i}"></span></span>
          </button>`;
        }).join('')}
      </div>`;

  const win = resolved ? held(m, m.winner) : 0;
  return `<article class="card market ${resolved ? 'resolved' : ''}" data-slug="${esc(m.slug)}">
    <div class="ticker-head">
      <span class="sym">$${esc(symbol(m))}</span>
      ${resolved ? `<span class="tag">Settled \u00b7 ${esc(m.outcomes[m.winner])}</span>`
        : team ? '<span class="tag team">Team</span>' : '<span class="tag">Event</span>'}
      <span class="spacer"></span>
      ${m.createSig ? `<a class="small muted" href="${chain.explorer('tx', m.createSig)}" target="_blank" rel="noopener"
        title="The creation transaction contains a SHA-256 hash of this question and its outcomes">locked \u2713</a>` : ''}
    </div>
    <h3>${esc(m.question)}</h3>
    <div class="quote-line">
      <div>
        <div class="label">${isBinary(m) ? 'Chance' : esc(m.outcomes[shown])}</div>
        <div class="big num">${pct(m.prices[shown])}</div>
      </div>
      ${moveBadge(delta)}
      <span class="spacer"></span>
      <span class="small muted">${fmt(stakes(m), 0)} shares out</span>
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
  $$('.side:not([disabled]), .outcome-row:not([disabled])', root).forEach((b) => {
    b.onclick = (e) => { press(b); openSheet(b.dataset.slug, Number(b.dataset.i), e); };
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
  const live = S.markets.filter((m) => !m.missing);
  const open = live.filter((m) => m.status !== 'resolved');
  const done = live.filter((m) => m.status === 'resolved');
  const first = !host.children.length;
  host.innerHTML = [...open, ...done].map(marketCard).join('');
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
      : `<p class="muted small" style="margin:0">Start trading and you get 1,000 play HACK. No install, no login.</p>
         <button class="primary" id="rail-connect">Start trading</button>`}
    </section>
    <section class="card pad panel">
      <div class="section-head"><h2>Leaderboard</h2><span class="small muted">net worth</span></div>
      <ol class="board" id="board-mini"></ol>
    </section>`;
  if (S.wallet) rollTo($('#net-worth'), total, { digits: 2 });
  const claim = $('#claim');
  if (claim) claim.onclick = (e) => { press(e.currentTarget); doClaim(e.currentTarget); };
  const rc = $('#rail-connect');
  if (rc) rc.onclick = (e) => { press(e.currentTarget); connect('burner'); };
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
    ${S.wallet ? '' : `<section class="card hero">
      <h1>Bet on who wins Hack the North.</h1>
      <p>Play money, real Solana. Every price is set by a program on-chain, not by us — and the
      question was hashed into the transaction that opened each market, so nobody can reword it later.</p>
      <div class="row"><button class="primary" id="hero-start">Start with 1,000 HACK</button>
      <button id="hero-phantom">Use Phantom</button></div>
    </section>`}
    <div class="tape" id="tape" aria-hidden="true"></div>
    <section class="panel">
      <div class="section-head"><h2>Markets</h2><span class="small muted" id="market-count"></span></div>
      <div class="markets" id="markets-list"></div>
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
      : '<p class="muted">Start trading to get your 1,000 HACK.</p><button class="primary" id="you-connect">Start trading</button>'}
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
  const html = { markets: viewMarkets, leaders: viewLeaders, register: viewRegister, you: viewYou }[S.view]();
  host.innerHTML = html;
  lastKey.markets = null;
  lastKey.rail = null;
  $('#main').classList.toggle('with-rail', S.view === 'markets');
  $('#rail').hidden = S.view !== 'markets';

  if (S.view === 'markets') {
    renderMarketsView();
    renderTape();
    const hs = $('#hero-start');
    if (hs) hs.onclick = (e) => { press(e.currentTarget); connect('burner'); };
    const hp = $('#hero-phantom');
    if (hp) hp.onclick = (e) => { press(e.currentTarget); connect('phantom'); };
  }
  if (S.view === 'leaders') renderBoard($('#board-full'), 25);
  if (S.view === 'register') setupRegister();
  if (S.view === 'you') {
    const c = $('#you-claim');
    if (c) c.onclick = (e) => { press(e.currentTarget); doClaim(e.currentTarget); };
    const w = $('#you-connect');
    if (w) w.onclick = (e) => { press(e.currentTarget); connect('burner'); };
  }
  $$('#view > *').forEach((n, i) => popIn(n, i * 60));
  renderRail();
}

function setView(view) {
  if (S.view === view) return;
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
  if (!S.wallet) { toast('Start trading first — it takes one tap', 'err'); connect('burner'); return; }
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
    S.markets = await chain.fetchMarkets(S.meta);
    if (S.wallet) {
      const [bal, sol] = await Promise.all([
        chain.fetchBalances(S.wallet.publicKey),
        chain.solBalance(S.wallet.publicKey),
      ]);
      S.balances = bal;
      S.sol = sol;
      S.hack = bal.get(chain.HACK.toBase58()) ?? 0;
    }
    S.lastOk = Date.now();
  } catch (e) {
    if (Date.now() - S.lastOk > 20_000) toast(`Solana is slow to answer (${chain.explainError(e)})`, 'err');
  }
  $('#live').classList.toggle('stale', Date.now() - S.lastOk > 15_000);
  renderWallet();
  if (S.view === 'markets') { renderMarketsView(); renderTape(); }
  if (S.view === 'you') renderView();
  renderRail();
  const count = $('#market-count');
  if (count) count.textContent = `${S.markets.filter((m) => !m.missing).length} open · prices from the chain`;
  if (S.sheet) updateQuote();
}

async function pollBoard() {
  try {
    S.board = await (await fetch('/api/leaderboard')).json();
    renderBoard($('#board-mini'), 8);
    renderBoard($('#board-full'), 25);
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
window.addEventListener('resize', () => moveIndicator($('#tab-indicator'), $(`#tabs [data-view="${S.view}"]`)));

(async function boot() {
  renderView();
  moveIndicator($('#tab-indicator'), $('#tabs [data-view="markets"]'));
  try {
    const [config, meta] = await Promise.all([
      fetch('/api/config').then((r) => r.json()),
      fetch('/api/markets').then((r) => r.json()),
    ]);
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
  setInterval(poll, 5000);
  setInterval(pollBoard, 20000);
})();
