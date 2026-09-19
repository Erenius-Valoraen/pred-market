// Organizer page: register teams, resolve markets. Talks only to the server,
// which does the on-chain work with the operator key.

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const explorer = (kind, id) => `https://explorer.solana.com/${kind}/${id}?cluster=devnet`;
const KEY = 'htnmkt.admin.token';

let token = '';
try { token = localStorage.getItem(KEY) ?? ''; } catch { /* private mode */ }

async function api(path, body) {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

async function unlock() {
  const st = $('auth-status');
  try {
    await api('/api/admin/check');
    try { localStorage.setItem(KEY, token); } catch { /* ignore */ }
    $('auth-panel').hidden = true;
    $('team-form').hidden = false;
    $('list-panel').hidden = false;
    loadList();
  } catch {
    st.className = 'status err';
    st.textContent = token ? 'That token was rejected.' : '';
  }
}

$('token-save').onclick = () => { token = $('token').value.trim(); unlock(); };
$('token').onkeydown = (e) => { if (e.key === 'Enter') $('token-save').onclick(); };

$('team-form').onsubmit = async (e) => {
  e.preventDefault();
  const out = $('team-result');
  const btn = $('team-go');
  btn.disabled = true;
  out.className = 'result';
  out.textContent = 'Creating the market on Solana (about 5-10 seconds)…';
  try {
    const members = $('members').value.split('\n').map((s) => s.trim()).filter(Boolean);
    const r = await api('/api/admin/team', {
      team: $('team').value, project: $('project').value, table: $('table').value, members,
    });
    const m = r.market;
    if (r.duplicate) {
      out.innerHTML = `<span class="status err">Already registered:</span> ${esc(m.question)}`;
    } else {
      out.innerHTML = `<span class="done">Live.</span> ${esc(m.question)}<br>
        <a href="${explorer('address', m.address)}" target="_blank" rel="noopener">market account</a> ·
        <a href="${explorer('tx', m.createSig)}" target="_blank" rel="noopener">creation tx (question locked by hash)</a>`;
      $('team-form').reset();
      $('team').focus();
    }
    loadList();
  } catch (err) {
    out.innerHTML = `<span class="status err">${esc(err.message)}</span>`;
  } finally {
    btn.disabled = false;
  }
};

async function loadList() {
  const markets = await (await fetch('/api/markets')).json();
  const teams = markets.filter((m) => m.kind === 'team').reverse();
  const seeds = markets.filter((m) => m.kind !== 'team');
  const row = (m) => {
    const done = Number.isInteger(m.resolvedWinner);
    const acts = done
      ? `<span class="done">Resolved: ${esc(m.outcomes[m.resolvedWinner])}</span>`
      : m.outcomes.map((o, i) => `<button data-slug="${esc(m.slug)}" data-i="${i}">${esc(o)}</button>`).join('');
    const sub = m.team ? `${esc(m.team.project || '')}${m.team.table ? ` · table ${esc(m.team.table)}` : ''}` : '';
    return `<div class="mk"><div><div class="q">${esc(m.question)}</div>
      ${sub ? `<div class="muted small">${sub}</div>` : ''}</div><div class="acts">${acts}</div></div>`;
  };
  $('list').innerHTML =
    (teams.length ? `<h3 style="margin-top:4px">Teams (${teams.length})</h3>${teams.map(row).join('')}` : '<p class="muted">No teams yet.</p>') +
    `<h3 style="margin-top:14px">Event markets</h3>${seeds.map(row).join('')}`;
  $('list').querySelectorAll('button[data-slug]').forEach((b) => {
    b.onclick = () => resolve(b.dataset.slug, Number(b.dataset.i), markets);
  });
}

async function resolve(slug, winner, markets) {
  const m = markets.find((x) => x.slug === slug);
  // Resolution is permanent and pays out real (play) money on-chain.
  if (!confirm(`Resolve "${m.question}" as ${m.outcomes[winner]}?\n\nThis is final and cannot be undone.`)) return;
  try {
    await api('/api/admin/resolve', { slug, winner });
    loadList();
  } catch (err) {
    alert(`Resolve failed: ${err.message}`);
  }
}

if (token) unlock();
