// Small UI helpers: the motion, the number rolls, the confetti.
//
// Everything here is plain DOM + Web Animations API, no animation library:
// the page has to load fast on venue wifi, and springs are one cubic-bezier.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const SPRING = 'cubic-bezier(.34,1.56,.64,1)';   // overshoots, then settles
export const EASE = 'cubic-bezier(.22,.61,.36,1)';

export const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const fmt = (x, d = 2) =>
  Number(x).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
export const pct = (p) => `${Math.round(p * 100)}%`;
export const pct1 = (p) => `${(p * 100).toFixed(1)}%`;
export const short = (k) => `${String(k).slice(0, 4)}…${String(k).slice(-4)}`;

/** Build an element from HTML. */
export function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

/** Animate, unless the reader asked for less motion. */
export function animate(node, frames, opts) {
  if (!node || reduced()) return null;
  return node.animate(frames, { fill: 'both', ...opts });
}

/** A quick squish, so every press feels like it did something. */
export function press(node) {
  animate(node, [{ transform: 'scale(1)' }, { transform: 'scale(.94)' }, { transform: 'scale(1)' }],
    { duration: 260, easing: SPRING });
}

export function popIn(node, delay = 0) {
  animate(node, [{ opacity: 0, transform: 'translateY(10px) scale(.97)' }, { opacity: 1, transform: 'none' }],
    { duration: 420, delay, easing: SPRING });
}

/** Stagger a list in: the page assembling itself, not fading in as a block. */
export function stagger(nodes, each = 45) {
  nodes.forEach((n, i) => popIn(n, i * each));
}

/**
 * Roll a number like a fare meter. Keeps the DOM text correct at every step,
 * so a screen reader or a paused animation still reads the true value.
 */
export function rollTo(node, to, { digits = 2, ms = 700, prefix = '', suffix = '' } = {}) {
  const from = Number(node.dataset.value ?? to);
  node.dataset.value = to;
  const write = (v) => { node.textContent = `${prefix}${fmt(v, digits)}${suffix}`; };
  if (reduced() || from === to) return write(to);
  const t0 = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - t0) / ms);
    const eased = 1 - (1 - k) ** 3;
    write(from + (to - from) * eased);
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  if (to !== from) {
    node.classList.remove('tick-up', 'tick-down');
    void node.offsetWidth;
    node.classList.add(to > from ? 'tick-up' : 'tick-down');
  }
}

/** Draw an SVG path for a price history, animated as if it were being drawn. */
export function sparkline(values, { w = 120, h = 34, up = true } = {}) {
  if (!values || values.length < 2) return '';
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * w;
    const y = h - 3 - ((v - lo) / span) * (h - 6);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return `<svg class="spark ${up ? 'up' : 'down'}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
    <polyline points="${pts.join(' ')}" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

/** Toasts: slide up with a bit of overshoot, leave quickly. */
export function toast(message, kind = 'ok', link) {
  const host = $('#toasts');
  const node = el(`<div class="toast ${kind}" role="status">
      <span>${esc(message)}</span>
      ${link ? `<a href="${esc(link)}" target="_blank" rel="noopener">view</a>` : ''}
    </div>`);
  host.append(node);
  animate(node, [{ opacity: 0, transform: 'translateY(16px) scale(.96)' }, { opacity: 1, transform: 'none' }],
    { duration: 420, easing: SPRING });
  setTimeout(() => {
    const out = animate(node, [{ opacity: 1 }, { opacity: 0, transform: 'translateY(8px)' }],
      { duration: 180, easing: EASE });
    if (out) out.onfinish = () => node.remove(); else node.remove();
  }, 4200);
  return node;
}

/**
 * Confetti for a filled trade. Canvas, ~40 pieces, gone in a second: a small
 * reward, not a parade.
 */
export function confetti(origin) {
  if (reduced()) return;
  const canvas = el('<canvas class="confetti" aria-hidden="true"></canvas>');
  document.body.append(canvas);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = innerWidth * dpr;
  canvas.height = innerHeight * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const colors = ['#0FA968', '#E5484D', '#F5C542', '#2E6BFF', '#15181C'];
  const x0 = origin?.x ?? innerWidth / 2;
  const y0 = origin?.y ?? innerHeight / 2;
  const bits = Array.from({ length: 44 }, () => ({
    x: x0, y: y0,
    vx: (Math.random() - 0.5) * 9,
    vy: -Math.random() * 11 - 3,
    r: 3 + Math.random() * 4,
    a: Math.random() * Math.PI,
    va: (Math.random() - 0.5) * 0.4,
    c: colors[(Math.random() * colors.length) | 0],
  }));
  const t0 = performance.now();
  const frame = (t) => {
    const age = t - t0;
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    for (const b of bits) {
      b.vy += 0.42;
      b.x += b.vx;
      b.y += b.vy;
      b.a += b.va;
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.rotate(b.a);
      ctx.globalAlpha = Math.max(0, 1 - age / 1100);
      ctx.fillStyle = b.c;
      ctx.fillRect(-b.r, -b.r * 0.6, b.r * 2, b.r * 1.2);
      ctx.restore();
    }
    if (age < 1100) requestAnimationFrame(frame);
    else canvas.remove();
  };
  requestAnimationFrame(frame);
}

/** Slide the little pill behind whichever tab is active (FLIP). */
export function moveIndicator(indicator, target) {
  if (!indicator || !target) return;
  const p = indicator.parentElement.getBoundingClientRect();
  const r = target.getBoundingClientRect();
  const to = { left: `${r.left - p.left}px`, width: `${r.width}px` };
  if (reduced() || !indicator.style.width) Object.assign(indicator.style, to);
  else {
    const from = { left: indicator.style.left, width: indicator.style.width };
    Object.assign(indicator.style, to);
    animate(indicator, [from, to], { duration: 380, easing: SPRING });
  }
}
