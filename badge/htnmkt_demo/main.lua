-- HTN Market DEMO — the badge app as it would look with room to breathe.
--
-- The trading build (badge/htnmkt) gives almost all of the badge's RAM to
-- Bluetooth, which leaves about 5 KB for everything else: ten rows of text.
-- This build has no radio, so it spends that memory on the interface: an ink
-- header, odds bars, a drawn price line, payouts, a FILLED stamp, the LEDs.
--
-- It is a MOCK and says DEMO on screen. Prices walk on a fixed seed, trades
-- move only what is in this badge's memory, and nothing here touches Solana.
-- The radio build is the one that really trades.
--
-- Two things this firmware taught us, both the hard way:
--   * its Lua uses 32-BIT integers, so the textbook random-number constants
--     overflow and pin the seed at zero;
--   * deleting and recreating widgets on every redraw runs the app out of
--     memory, so every widget here is built once and only ever updated.

local ui, sys, led, input = badge.ui, badge.sys, badge.led, badge.input
local ms = sys.ms
local floor, min, max = math.floor, math.min, math.max
local format = string.format

local W, H = ui.screen_width, ui.screen_height
local INK, PAPER, DIM = 0x14110e, 0xefe9db, 0x8c8577
local GREEN, RED, GOLD, SEL = 0x146b3a, 0xb3121f, 0xc8912a, 0xe3dcc9
-- Each market gets two lines: the question, then its bar with the holding
-- beside it. Everything that can grow (titles, share counts) gets its own
-- space instead of competing for one row.
local ROW_Y, ROW_H = 34, 34
local BAR_X, BAR_W = 10, 176              -- the bar ends well before the numbers

-- The same questions the live market asks, worded the same way.
local markets = {
  { sym = 'RDD', name = 'Rubber Duck Debuggers',
    q = 'Will Rubber Duck Debuggers win a prize?', p = 0.62, hold = 0 },
  { sym = 'LNC', name = 'Late Night Compilers',
    q = 'Will Late Night Compilers win a prize?', p = 0.41, hold = 0 },
  { sym = 'SEG', name = 'Segfault Symphony',
    q = 'Will Segfault Symphony win a prize?', p = 0.28, hold = 0 },
  { sym = 'HWF', name = 'Hardware finalist',
    q = 'Will a hardware project be named a Finalist?', p = 0.55, hold = 0 },
  { sym = 'BDG', name = 'Badge project wins',
    q = 'Will a project built on the Hacker Badge win any prize?', p = 0.37, hold = 0 },
  { sym = 'QNX', name = 'QNX winner on a Pi',
    q = 'Will the QNX prize winner run on a Raspberry Pi?', p = 0.73, hold = 0 },
}
local SPEND = 50
local cash = 1000

-- Small constants on purpose: 32-bit integers, see the note above.
local seed = 4711
local function rnd()
  seed = (seed * 75 + 74) % 65537
  return seed / 65537
end

for _, m in ipairs(markets) do
  m.hist = {}
  local p = m.p
  for i = 1, 40 do
    p = max(0.12, min(0.9, p + (rnd() - 0.5) * 0.06))
    m.hist[i] = p
  end
  m.p = m.hist[40]
end

local view, cur, flash, nextTick = 'list', 1, 0, 0
local rows, mk, sel, stamp, title = {}, {}, nil, nil, nil

-- One points buffer, filled in place. Building a fresh table of 40 pairs on
-- every redraw ran the badge down to 36 bytes of free heap in a minute.
local PTS = {}
for i = 1, 40 do PTS[i] = { 0, 0 } end

-- Split a question over two lines at a word boundary: no label here is wide
-- enough for "Will a project built on the Hacker Badge win any prize?".
local function wrap(text, n)
  if #text <= n then return text, '' end
  local cut = n
  while cut > 1 and text:sub(cut, cut) ~= ' ' do cut = cut - 1 end
  if cut <= 1 then cut = n end
  return text:sub(1, cut - 1), text:sub(cut + 1)
end

local function pctText(p) return format('%d%%', floor(p * 100 + 0.5)) end
local function money(x) return format('%d', floor(x + 0.5)) end
local function pays(p) return format('pays %.2fx', 1 / max(0.03, p)) end

local function label(root, text, x, y, color, size)
  local l = ui.label(root, text)
  l:set_pos(x, y)
  l:set_color(color or INK)
  if size then l:set_font_size(size) end
  return l
end

local function box(root, x, y, w, h, color)
  local b = ui.box(root, w, h)
  b:set_pos(x, y)
  b:set_color(color)
  return b
end

local function showList(on)
  sel:hidden(not on)
  for i = 1, #rows do
    for _, w in pairs(rows[i]) do w:hidden(not on) end
  end
end

local function showMarket(on)
  for k, w in pairs(mk) do
    if k ~= 'cash' and k ~= 'hint' then w:hidden(not on) end
  end
end

function redraw()
  mk.cash:set_text(money(cash) .. ' HACK')
  if view == 'list' then
    showMarket(false)
    showList(true)
    title:hidden(false)
    sel:set_pos(4, ROW_Y + (cur - 1) * ROW_H - 4)
    for i, m in ipairs(markets) do
      local r = rows[i]
      r.name:set_color(i == cur and INK or 0x4a443c)
      r.bar:set_size(max(2, floor(BAR_W * m.p)), 5)
      r.bar:set_color(i == cur and GOLD or GREEN)
      r.pct:set_text(pctText(m.p))
      r.hold:set_text(m.hold > 0 and (money(m.hold) .. ' sh') or '')
    end
    mk.hint:set_text('A open   UP/DOWN move')
  else
    showList(false)
    showMarket(true)
    title:hidden(true)            -- the symbol takes the header instead
    local m = markets[cur]
    mk.sym:set_text('$' .. m.sym)
    local l1, l2 = wrap(m.q, 37)
    mk.q1:set_text(l1)
    mk.q2:set_text(l2)
    mk.big:set_text(pctText(m.p))
    mk.yesPct:set_text(pctText(m.p))
    mk.noPct:set_text(pctText(1 - m.p))
    mk.yesPays:set_text(pays(m.p))
    mk.noPays:set_text(pays(1 - m.p))
    mk.pos:set_text(m.hold > 0
      and format('you hold %s shares - worth %s HACK', money(m.hold), money(m.hold * m.p))
      or 'no position yet')

    local n = #m.hist
    local lo, hi = 1, 0
    for i = 1, n do lo = min(lo, m.hist[i]) hi = max(hi, m.hist[i]) end
    local span = max(0.08, hi - lo)
    for i = 1, n do
      local p = PTS[i]
      p[1] = 132 + floor((i - 1) / (n - 1) * (W - 152))
      p[2] = 124 - floor((m.hist[i] - lo) / span * 36)
    end
    mk.chart:set_points(PTS)
    mk.chart:set_color(m.p >= m.hist[1] and GREEN or RED)
    mk.hint:set_text('A buy 50   START sell all   B back')
  end
end

function on_enter(root)
  box(root, 0, 0, W, 30, INK)
  title = label(root, 'HTN MARKET', 10, 7, PAPER)
  label(root, 'DEMO', 152, 10, GOLD, 'small')   -- clear of both titles
  mk.cash = label(root, '', W - 88, 9, PAPER, 'small')

  sel = box(root, 4, ROW_Y - 4, W - 8, ROW_H - 2, SEL)
  for i = 1, #markets do
    local y = ROW_Y + (i - 1) * ROW_H
    rows[i] = {
      name = label(root, markets[i].name, 10, y, INK),
      barBg = box(root, BAR_X, y + 22, BAR_W, 6, 0xd8d0bf),
      bar = box(root, BAR_X, y + 22, 2, 6, GREEN),
      hold = label(root, '', BAR_X + BAR_W + 8, y + 18, GREEN, 'small'),
      pct = label(root, '', W - 62, y + 2, INK),
    }
  end

  mk.sym = label(root, '', 10, 7, GOLD)
  mk.q1 = label(root, '', 12, 36, INK, 'small')
  mk.q2 = label(root, '', 12, 52, INK, 'small')
  mk.chanceLbl = label(root, 'CHANCE', 12, 72, DIM, 'small')
  mk.big = label(root, '', 10, 84, INK)
  mk.big:set_font_size('large')
  mk.chart = ui.line(root, { { 0, 0 }, { 1, 1 } })
  mk.chart:set_color(GREEN)
  mk.yesBox = box(root, 12, 136, floor(W / 2) - 18, 46, 0xddebe0)
  mk.yesLbl = label(root, 'YES', 22, 142, GREEN, 'small')
  mk.yesPct = label(root, '', 22, 156, GREEN)
  mk.yesPays = label(root, '', 22, 186, DIM, 'small')
  mk.noBox = box(root, floor(W / 2) + 6, 136, floor(W / 2) - 18, 46, 0xf6e2e2)
  mk.noLbl = label(root, 'NO', floor(W / 2) + 16, 142, RED, 'small')
  mk.noPct = label(root, '', floor(W / 2) + 16, 156, RED)
  mk.noPays = label(root, '', floor(W / 2) + 16, 186, DIM, 'small')
  mk.pos = label(root, '', 12, 206, INK, 'small')
  mk.hint = label(root, '', 10, H - 20, DIM, 'small')

  stamp = label(root, '', 0, 0, GREEN)
  stamp:set_font_size('large')
  stamp:align('center', 0, -6)
  stamp:hidden(true)

  redraw()
end

local function showStamp(text, good)
  stamp:set_text(text)
  stamp:set_color(good and GREEN or RED)
  stamp:align('center', 0, -6)
  stamp:hidden(false)
  stamp:bring_to_front()
  led.set_all(good and 0 or 90, good and 80 or 0, 0)
  led.show()
  flash = ms() + 900
end

local function push(m, p)
  m.p = p
  m.hist[#m.hist + 1] = p
  if #m.hist > 40 then table.remove(m.hist, 1) end
end

local function trade(buy)
  local m = markets[cur]
  if buy then
    if cash < SPEND then showStamp('NO FUNDS', false) return end
    cash = cash - SPEND
    m.hold = m.hold + SPEND / max(0.08, m.p)
    push(m, min(0.95, m.p + SPEND / 900))
  else
    if m.hold <= 0 then showStamp('NOTHING TO SELL', false) return end
    cash = cash + m.hold * m.p
    push(m, max(0.05, m.p - m.hold * m.p / 900))
    m.hold = 0
  end
  redraw()
  showStamp(buy and 'FILLED' or 'SOLD', true)
end

function on_tick()
  collectgarbage('step', 2)
  local now = ms()
  if flash > 0 and now >= flash then
    flash = 0
    stamp:hidden(true)
    led.clear()
    led.show()
  end
  -- the room keeps trading while you look at it
  if now >= nextTick then
    nextTick = now + 2600
    local m = markets[1 + floor(rnd() * #markets)]
    push(m, max(0.1, min(0.93, m.p + (rnd() - 0.5) * 0.04)))
    redraw()
  end
end

function on_button(b, kind)
  if kind ~= input.KIND.PRESSED then return end
  local B = input.BUTTON
  local n = #markets
  if b == B.UP then cur = cur > 1 and cur - 1 or n
  elseif b == B.DOWN then cur = cur < n and cur + 1 or 1
  elseif b == B.A then
    if view == 'list' then view = 'market' else trade(true) return end
  elseif b == B.B then view = 'list'
  elseif b == B.START then
    if view == 'market' then trade(false) end
    return
  end
  redraw()
end

function on_exit()
  led.clear()
  led.show()
end
