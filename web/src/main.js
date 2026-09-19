import './polyfill.js';
import * as chain from './chainlib.js';
import * as wallets from './wallet.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (x, d = 2) => Number(x).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (p) => `${(p * 100).toFixed(1)}%`;
const short = (k) => `${k.slice(0, 4)}…${k.slice(-4)}`;
const COLORS = ['#14f195', '#ff5c7a', '#7c5cff', '#ffb547', '#4cc9f0', '#f72585', '#b5e48c', '#e0aaff'];

const S = {
  meta: [], markets: [], wallet: null,
  balances: new Map(), sol: 0, hack: 0,
  board: [], sheet: null, busy: false, lastOk: 0,
  activity: [],
};

// ---------------------------------------------------------------- helpers
const byslug = (slug) => S.markets.find((m) => m.slug === slug);
function held(m, i) {
  if (!S.wallet || !m.pubkey) return 0;
  return S.balances.get(chain.outcomeMintPda(m.pubkey, i).toBase58()) ?? 0;
}
function notice(msg) {
  const n = $('notice');
  n.hidden = !msg;
  n.textContent = msg ?? '';
}
function saveActivity() {
  if (!S.wallet) return;
  try { localStorage.setItem(`htnmkt.act.${S.wallet.publicKey.toBase58()}`, JSON.stringify(S.activity.slice(0, 30))); } catch { /* ignore */ }
}
function loadActivity() {
  S.activity = [];
  if (!S.wallet) return;
  try { S.activity = JSON.parse(localStorage.getItem(`htnmkt.act.${S.wallet.publicKey.toBase58()}`) ?? '[]'); } catch { /* ignore */ }
}

// ------------------------------------------------------------------ render
// The page polls every 5s. Re-rendering a region whose content hasn't changed
// would wipe whatever the user is typing (e.g. their name in the claim box)
// and swap buttons out from under their finger. So each region only
// re-renders when a key describing its state actually changes.
const lastKey = {};
function changed(region, key) {
  if (lastKey[region] === key) return false;
  lastKey[region] = key;
  return true;
}

function renderWallet() {
  const el = $('wallet');
  if (!changed('wallet', `${S.wallet?.publicKey.toBase58()}|${S.hack.toFixed(6)}`)) return;
  if (!S.wallet) {
    el.innerHTML = `<button id="w-burner">Burner wallet</button><button id="w-phantom" class="ghost">Phantom</button>`;
    $('w-burner').onclick = () => connect('burner');
    $('w-phantom').onclick = () => connect('phantom');
    return;
  }
  const k = S.wallet.publicKey.toBase58();
  el.innerHTML = `
    <span class="pill"><b>${fmt(S.hack)}</b> HACK</span>
    <a class="pill" href="${chain.explorer('address', k)}" target="_blank" rel="noopener">${S.wallet.kind === 'burner' ? 'burner' : 'phantom'} ${short(k)}</a>
    <button id="w-out" class="ghost" title="Disconnect">&#x23FB;</button>`;
  $('w-out').onclick = async () => { await S.wallet.disconnect(); S.wallet = null; S.balances = new Map(); renderAll(); };
}

function renderOnboard() {
  const el = $('onboard');
  const stage = !S.wallet ? 'connect' : S.hack > 0 ? 'done' : 'claim';
  if (!changed('onboard', stage)) return;
  if (!S.wallet) {
    el.innerHTML = `<div class="onboard">
      <h2>Bet on who wins Hack the North.</h2>
      <p>Every price is set by a Solana program, not by us. Your keys stay on your device.
      A burner wallet takes one tap and needs no install.</p>
      <div class="row"><button class="primary" style="width:auto" id="ob-burner">Start with a burner wallet</button>
      <button id="ob-phantom">Use Phantom</button></div></div>`;
    $('ob-burner').onclick = () => connect('burner');
    $('ob-phantom').onclick = () => connect('phantom');
    return;
  }
  if (S.hack > 0) { el.innerHTML = ''; return; }
  el.innerHTML = `<div class="onboard">
    <h2>Grab your 1,000 HACK</h2>
    <p>Play money, real Solana transactions. One claim per wallet.</p>
    <div class="row"><input id="ob-name" maxlength="32" placeholder="Name for the leaderboard (optional)" />
    <button class="primary" style="width:auto" id="ob-claim">Claim</button></div>
    <p class="status" id="ob-status"></p></div>`;
  $('ob-claim').onclick = claim;
}

function renderMarkets() {
  const el = $('markets');
  const key = S.markets.map((m) => m.missing ? 'x'
    : `${m.status}${m.winner}:${m.prices.map((p) => p.toFixed(4)).join(',')}:` +
      m.outcomes.map((_, i) => held(m, i).toFixed(6)).join(',')).join('|');
  if (!changed('markets', key)) return;
  if (!S.markets.length) { el.innerHTML = '<p class="muted">No markets yet.</p>'; return; }
  el.innerHTML = S.markets.map((m) => {
    if (m.missing) return '';
    const resolved = m.status === 'resolved';
    const rows = m.outcomes.map((o, i) => {
      const h = held(m, i);
      const color = m.outcomes.length === 2 ? (i === 0 ? COLORS[0] : COLORS[1]) : COLORS[i % COLORS.length];
      const cls = resolved ? (i === m.winner ? 'won' : 'lost') : '';
      return `<button class="outcome ${cls}" data-slug="${esc(m.slug)}" data-i="${i}" ${resolved ? 'disabled' : ''}>
        <span class="name">${esc(o)}</span><span class="pct">${pct(m.prices[i])}</span>
        <span class="bar"><span style="width:${(m.prices[i] * 100).toFixed(2)}%;background:${color}"></span></span>
        ${h > 0 ? `<span class="held">you hold ${fmt(h, 3)} shares</span>` : ''}
      </button>`;
    }).join('');
    const win = resolved ? held(m, m.winner) : 0;
    const t = m.team;
    const teamLine = t ? [t.project, t.table && `table ${t.table}`,
      t.members?.length && `${t.members.length} member${t.members.length > 1 ? 's' : ''}`]
      .filter(Boolean).map(esc).join(' · ') : '';
    return `<article class="market">
      ${resolved ? `<span class="badge">RESOLVED: ${esc(m.outcomes[m.winner])}</span>`
        : t ? '<span class="badge team">TEAM</span>' : ''}
      <h4>${esc(m.question)}</h4>
      ${teamLine ? `<p class="resolves">${teamLine}</p>` : ''}
      ${m.resolves ? `<p class="resolves">Resolves: ${esc(m.resolves)}</p>` : ''}
      ${m.createSig ? `<p class="resolves"><a href="${chain.explorer('tx', m.createSig)}" target="_blank" rel="noopener"
        title="The creation transaction contains a SHA-256 hash of this question and its outcomes">question locked on-chain &#10003;</a></p>` : ''}
      ${rows}
      ${win > 0 ? `<button class="primary" data-redeem="${esc(m.slug)}">Redeem ${fmt(win, 2)} HACK</button>` : ''}
    </article>`;
  }).join('');
  el.querySelectorAll('.outcome:not([disabled])').forEach((b) => {
    b.onclick = () => openSheet(b.dataset.slug, Number(b.dataset.i));
  });
  el.querySelectorAll('[data-redeem]').forEach((b) => { b.onclick = () => redeem(b.dataset.redeem); });
}

function renderBook() {
  const el = $('book');
  if (!S.wallet) { el.innerHTML = '<p class="muted">Connect a wallet to trade.</p>'; return; }
  let value = 0;
  const lines = [];
  for (const m of S.markets) {
    if (m.missing) continue;
    m.outcomes.forEach((o, i) => {
      const h = held(m, i);
      if (h <= 0) return;
      const v = m.status === 'resolved' ? (i === m.winner ? h : 0) : h * m.prices[i];
      value += v;
      lines.push(`<div class="kv"><span>${esc(o)} <span class="muted small">· ${esc(m.slug)}</span></span><span>${fmt(v)}</span></div>`);
    });
  }
  el.innerHTML = `
    <div class="kv"><span>Cash</span><span>${fmt(S.hack)}</span></div>
    <div class="kv"><span>Positions</span><span>${fmt(value)}</span></div>
    <div class="kv"><span><b>Net worth</b></span><span><b>${fmt(S.hack + value)}</b></span></div>
    ${lines.length ? `<hr style="border:0;border-top:1px solid var(--line);margin:10px 0">${lines.join('')}` : ''}
    <p class="muted small" style="margin:10px 0 0">SOL for fees: <span class="num">${S.sol.toFixed(4)}</span>
    ${S.wallet.kind === 'burner' ? '<br>Burner key lives in this browser only. Clearing site data loses it.' : ''}</p>`;
}

function renderBoard() {
  const el = $('board');
  if (!S.board.length) { el.innerHTML = '<li class="muted">No traders yet. Be first.</li>'; return; }
  const me = S.wallet?.publicKey.toBase58();
  el.innerHTML = S.board.slice(0, 12).map((r, i) => `
    <li class="${r.wallet === me ? 'me' : ''}"><span class="rank">${i + 1}</span>
    <span>${esc(r.name)}</span><span class="num">${fmt(r.netWorth, 0)}</span></li>`).join('');
}

function renderActivity() {
  const el = $('activity');
  if (!S.activity.length) { el.innerHTML = '<li class="muted">No trades yet.</li>'; return; }
  el.innerHTML = S.activity.slice(0, 8).map((a) =>
    `<li>${esc(a.text)} · <a href="${chain.explorer('tx', a.sig)}" target="_blank" rel="noopener">tx</a></li>`).join('');
}

function renderAll() {
  renderWallet(); renderOnboard(); renderMarkets(); renderBook(); renderBoard(); renderActivity();
}

// ----------------------------------------------------------------- polling
async function poll() {
  try {
    S.markets = await chain.fetchMarkets(S.meta);
    if (S.wallet) {
      const [bal, sol] = await Promise.all([chain.fetchBalances(S.wallet.publicKey), chain.solBalance(S.wallet.publicKey)]);
      S.balances = bal;
      S.sol = sol;
      S.hack = bal.get(chain.HACK.toBase58()) ?? 0;
    }
    S.lastOk = Date.now();
    notice(null);
  } catch (e) {
    notice(`Having trouble reaching Solana (${chain.explainError(e)}). Retrying…`);
  }
  $('live').classList.toggle('stale', Date.now() - S.lastOk > 15_000);
  renderAll();
  if (S.sheet) updateQuote();
}

async function pollBoard() {
  try { S.board = await (await fetch('/api/leaderboard')).json(); renderBoard(); } catch { /* ignore */ }
  // Teams are registered throughout the event; pick up new markets without a
  // page refresh. Team markets are listed after the event-wide ones.
  try {
    const meta = await (await fetch('/api/markets')).json();
    meta.sort((a, b) => (a.kind === 'team') - (b.kind === 'team'));
    if (meta.length !== S.meta.length) { S.meta = meta; await poll(); }
  } catch { /* ignore */ }
}

// ----------------------------------------------------------------- wallet
async function connect(kind) {
  try {
    S.wallet = kind === 'phantom' ? await wallets.connectPhantom() : wallets.connectBurner();
    loadActivity();
    renderAll();
    await poll();
  } catch (e) {
    notice(chain.explainError(e));
  }
}

async function claim() {
  const st = $('ob-status');
  st.className = 'status';
  st.textContent = 'Minting your HACK on Solana…';
  $('ob-claim').disabled = true;
  try {
    const res = await fetch('/api/faucet', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ wallet: S.wallet.publicKey.toBase58(), name: $('ob-name').value }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? 'faucet failed');
    if (body.already) { st.textContent = 'This wallet already claimed.'; }
    await poll();
    pollBoard();
  } catch (e) {
    st.className = 'status err';
    st.textContent = e.message;
    $('ob-claim').disabled = false;
  }
}

// ------------------------------------------------------------ trade sheet
function openSheet(slug, i, mode = 'buy') {
  if (!S.wallet) { notice('Connect a wallet first.'); return; }
  S.sheet = { slug, i, mode };
  const m = byslug(slug);
  $('sheet-q').textContent = m.question;
  $('sheet-title').textContent = m.outcomes[i];
  $('amount').value = '';
  $('status').textContent = '';
  $('status').className = 'status';
  renderSheetControls();
  $('sheet').hidden = false;
  $('amount').focus();
}

function renderSheetControls() {
  const { slug, i, mode } = S.sheet;
  const m = byslug(slug);
  const h = held(m, i);
  $('sheet-tabs').innerHTML = `<button data-mode="buy" class="${mode === 'buy' ? 'on' : ''}">Buy</button>` +
    (h > 0 ? `<button data-mode="sell" class="${mode === 'sell' ? 'on' : ''}">Sell</button>` : '');
  $('sheet-tabs').querySelectorAll('button').forEach((b) => {
    b.onclick = () => { S.sheet.mode = b.dataset.mode; $('amount').value = ''; renderSheetControls(); };
  });
  $('amount-label').textContent = mode === 'buy' ? 'Spend (HACK)' : `Sell shares (you hold ${fmt(h, 3)})`;
  const chips = mode === 'buy' ? [10, 50, 100, 250] : [0.25, 0.5, 1];
  $('chips').innerHTML = chips.map((c) =>
    `<button data-c="${c}">${mode === 'buy' ? c : c === 1 ? 'All' : `${c * 100}%`}</button>`).join('');
  $('chips').querySelectorAll('button').forEach((b) => {
    b.onclick = () => {
      const c = Number(b.dataset.c);
      $('amount').value = mode === 'buy' ? Math.min(c, Math.floor(S.hack)) : (h * c).toFixed(6);
      updateQuote();
    };
  });
  $('go').textContent = mode === 'buy' ? 'Buy' : 'Sell';
  updateQuote();
}

function updateQuote() {
  const { slug, i, mode } = S.sheet;
  const m = byslug(slug);
  const amt = Number($('amount').value);
  const q = $('quote');
  const go = $('go');
  const now = m.prices[i];
  if (!(amt > 0)) {
    q.innerHTML = `<dt>Current price</dt><dd>${pct(now)}</dd>`;
    go.disabled = true;
    return;
  }
  if (mode === 'buy') {
    const shares = chain.quoteBuy(m, i, amt);
    const after = chain.priceAfterBuy(m, i, shares);
    const profit = shares - amt;
    q.innerHTML = `
      <dt>You get</dt><dd>${fmt(shares, 3)} shares</dd>
      <dt>Avg price</dt><dd>${pct(amt / shares)}</dd>
      <dt>Price moves</dt><dd>${pct(now)} → ${pct(after)}</dd>
      <dt>If it happens</dt><dd class="up">${fmt(shares)} HACK (+${fmt(profit)})</dd>
      <dt>If it doesn't</dt><dd class="down">0 HACK (−${fmt(amt)})</dd>`;
    go.disabled = S.busy || amt > S.hack;
    if (amt > S.hack) q.innerHTML += `<dt class="down">Not enough HACK</dt><dd></dd>`;
  } else {
    const h = held(m, i);
    const refund = chain.quoteSell(m, i, Math.min(amt, h));
    q.innerHTML = `<dt>You receive</dt><dd>${fmt(refund)} HACK</dd><dt>Avg price</dt><dd>${pct(refund / amt)}</dd>`;
    go.disabled = S.busy || amt > h + 1e-9;
  }
}

async function execute() {
  const { slug, i, mode } = S.sheet;
  const m = byslug(slug);
  const amt = Number($('amount').value);
  const st = $('status');
  S.busy = true;
  $('go').disabled = true;
  st.className = 'status';
  st.textContent = S.wallet.kind === 'phantom' ? 'Approve in Phantom…' : 'Signing and sending…';
  try {
    let sig, text;
    if (mode === 'buy') {
      const shares = chain.quoteBuy(m, i, amt);
      // Slippage guard: the PROGRAM rejects the fill if others moved the price
      // by more than 3% before our transaction landed.
      sig = await chain.sendWithWallet(S.wallet, chain.buyIxs(S.wallet.publicKey, m.pubkey, i, amt, shares * 0.97));
      text = `Bought ${fmt(shares, 2)} ${m.outcomes[i]} for ${fmt(amt)}`;
    } else {
      const refund = chain.quoteSell(m, i, amt);
      sig = await chain.sendWithWallet(S.wallet, chain.sellIxs(S.wallet.publicKey, m.pubkey, i, amt, refund * 0.97));
      text = `Sold ${fmt(amt, 2)} ${m.outcomes[i]} for ${fmt(refund)}`;
    }
    S.activity.unshift({ text, sig, t: Date.now() });
    saveActivity();
    st.className = 'status ok';
    st.innerHTML = `Done. <a href="${chain.explorer('tx', sig)}" target="_blank" rel="noopener">View on Solana Explorer</a>`;
    $('amount').value = '';
    await poll();
    pollBoard();
  } catch (e) {
    st.className = 'status err';
    st.textContent = chain.explainError(e);
  } finally {
    S.busy = false;
    if (S.sheet) updateQuote();
  }
}

async function redeem(slug) {
  const m = byslug(slug);
  try {
    notice('Redeeming…');
    const sig = await chain.sendWithWallet(S.wallet, chain.redeemIxs(S.wallet.publicKey, m.pubkey, m.winner));
    S.activity.unshift({ text: `Redeemed ${m.outcomes[m.winner]}`, sig, t: Date.now() });
    saveActivity();
    notice(null);
    await poll();
  } catch (e) {
    notice(chain.explainError(e));
  }
}

// -------------------------------------------------------------------- boot
$('sheet-close').onclick = () => { S.sheet = null; $('sheet').hidden = true; };
$('sheet').onclick = (e) => { if (e.target === $('sheet')) $('sheet-close').onclick(); };
$('amount').oninput = updateQuote;
$('go').onclick = execute;
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.sheet) $('sheet-close').onclick(); });

(async function boot() {
  try {
    const [config, meta] = await Promise.all([
      fetch('/api/config').then((r) => r.json()),
      fetch('/api/markets').then((r) => r.json()),
    ]);
    chain.init(config);
    S.meta = meta.sort((a, b) => (a.kind === 'team') - (b.kind === 'team'));
    const prog = $('prog');
    prog.textContent = short(config.programId);
    prog.href = chain.explorer('address', config.programId);
    S.wallet = await wallets.restore();
    loadActivity();
  } catch (e) {
    notice(`Could not load market data: ${e.message}`);
  }
  renderAll();
  await poll();
  pollBoard();
  setInterval(poll, 5000);
  setInterval(pollBoard, 20000);
})();
