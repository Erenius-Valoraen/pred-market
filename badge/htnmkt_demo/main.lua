-- HTN Market DEMO — the badge app as it would look with room to breathe.
--
-- The trading app (badge/htnmkt) gives almost all of the badge's RAM to
-- Bluetooth, which leaves about 5 KB for everything else: ten rows of text
-- and nothing more. This build has no radio, so it can spend that memory on
-- the interface instead: colour, bars, a drawn price chart, a confirmation
-- animation and the LEDs.
--
-- It is a MOCK, and says so on screen. Prices move on a fixed random walk,
-- trades change only what is in this badge's memory, and nothing here
-- touches Solana. The radio build is the one that really trades.

local ui, sys, led, input = badge.ui, badge.sys, badge.led, badge.input
local ms = sys.ms
local floor, min, max = math.floor, math.min, math.max
local rep, format = string.rep, string.format

local W, H = ui.screen_width, ui.screen_height
local INK, PAPER, DIM = 0x14110e, 0xefe9db, 0x8c8577
local GREEN, RED, GOLD = 0x146b3a, 0xb3121f, 0xc8912a

-- The book. Prices are probabilities; shares pay 1 HACK if the outcome happens.
local markets = {
  { sym = 'RDD', name = 'Rubber Duck Debuggers', p = 0.62, hold = 0 },
  { sym = 'LNC', name = 'Late Night Compilers', p = 0.41, hold = 0 },
  { sym = 'SEG', name = 'Segfault Symphony', p = 0.28, hold = 0 },
  { sym = 'KPA', name = 'Kernel Panic Attack', p = 0.55, hold = 0 },
  { sym = 'COF', name = 'Caffeine Overflow', p = 0.17, hold = 0 },
  { sym = 'MRG', name = 'The Merge Conflicts', p = 0.73, hold = 0 },
}
local SPEND = 50
local cash = 1000

-- a deterministic walk, so the demo behaves the same every time
local seed = 7
local function rnd()
  seed = (seed * 1103515245 + 12345) % 2147483648
  return seed / 2147483648
end

for _, m in ipairs(markets) do
  m.hist = {}
  local p = m.p
  for i = 1, 40 do
    p = max(0.05, min(0.95, p + (rnd() - 0.5) * 0.06))
    m.hist[i] = p
  end
  m.p = m.hist[40]
end

local view, cur, flash = 'list', 1, 0
local root, rows, chart, body = nil, {}, nil, {}

local function money(x)
  return format('%d', floor(x + 0.5))
end

local function clear()
  for _, w in ipairs(body) do w:delete() end
  body = {}
  rows = {}
end

local function keep(w)
  body[#body + 1] = w
  return w
end

local function label(text, x, y, color, size)
  local l = keep(ui.label(root, text))
  l:set_pos(x, y)
  l:set_color(color or INK)
  if size then l:set_font_size(size) end
  return l
end

local function box(x, y, w, h, color)
  local b = keep(ui.box(root, w, h))
  b:set_pos(x, y)
  b:set_color(color)
  return b
end

-- ------------------------------------------------------------------ views
local function drawList()
  clear()
  box(0, 0, W, 30, INK)
  label('HTN MARKET', 10, 7, PAPER)
  label('DEMO', W - 116, 9, GOLD, 'small')
  label(money(cash) .. ' HACK', W - 76, 9, PAPER, 'small')

  for i, m in ipairs(markets) do
    local y = 36 + (i - 1) * 31
    local sel = i == cur
    if sel then box(4, y - 3, W - 8, 30, 0xe3dcc9) end
    label(m.sym, 10, y, sel and INK or DIM, 'small')
    label(m.name, 52, y - 1, INK)
    -- the odds bar
    box(10, y + 18, W - 92, 5, 0xd8d0bf)
    box(10, y + 18, floor((W - 92) * m.p), 5, sel and GOLD or GREEN)
    label(format('%d%%', floor(m.p * 100 + 0.5)), W - 66, y - 1, sel and INK or DIM)
    if m.hold > 0 then label('x' .. money(m.hold), W - 132, y + 3, GREEN, 'small') end
  end
  label('A open   UP/DOWN move', 10, H - 20, DIM, 'small')
end

local function drawMarket()
  clear()
  local m = markets[cur]
  box(0, 0, W, 30, INK)
  label('$' .. m.sym, 10, 7, GOLD)
  label(m.name, 70, 9, PAPER, 'small')
  label(money(cash) .. ' HACK', W - 76, 9, PAPER, 'small')

  label('CHANCE', 12, 38, DIM, 'small')
  local big = label(format('%d%%', floor(m.p * 100 + 0.5)), 10, 52, INK)
  big:set_font_size('large')

  -- price line, drawn from the history
  local pts = {}
  local n = #m.hist
  local lo, hi = 1, 0
  for i = 1, n do lo = min(lo, m.hist[i]) hi = max(hi, m.hist[i]) end
  local span = max(0.08, hi - lo)
  for i = 1, n do
    pts[i] = { 120 + floor((i - 1) / (n - 1) * (W - 140)), 96 - floor((m.hist[i] - lo) / span * 46) }
  end
  chart = keep(ui.line(root, pts))
  chart:set_color(m.p >= m.hist[1] and GREEN or RED)

  -- the two sides
  local yesW = floor((W - 24) * 0.5) - 4
  box(12, 112, yesW, 44, 0xddebe0)
  label('YES', 22, 118, GREEN, 'small')
  label(format('%d%%', floor(m.p * 100 + 0.5)), 22, 132, GREEN)
  box(W - 12 - yesW, 112, yesW, 44, 0xf6e2e2)
  label('NO', W - 2 - yesW, 118, RED, 'small')
  label(format('%d%%', floor((1 - m.p) * 100 + 0.5)), W - 2 - yesW, 132, RED)

  label(format('pays %.2fx', 1 / max(0.02, m.p)), 22, 160, DIM, 'small')
  label(format('pays %.2fx', 1 / max(0.02, 1 - m.p)), W - 2 - yesW, 160, DIM, 'small')

  if m.hold > 0 then
    label(format('you hold %s YES, worth %s', money(m.hold), money(m.hold * m.p)), 12, 182, INK, 'small')
  else
    label('no position yet', 12, 182, DIM, 'small')
  end
  label('A buy 50   START sell all   B back', 10, H - 20, DIM, 'small')
end

local function draw()
  if view == 'list' then drawList() else drawMarket() end
end

-- ------------------------------------------------------------- the trade
local function stamp(text, good)
  local s = keep(ui.label(root, text))
  s:set_font_size('large')
  s:set_color(good and GREEN or RED)
  s:align('center', 0, -10)
  led.set_all(good and 0 or 90, good and 80 or 0, 0)
  led.show()
  flash = ms() + 900
end

local function trade(buy)
  local m = markets[cur]
  if buy then
    if cash < SPEND then stamp('NO FUNDS', false) return end
    -- a light version of the real curve: buying moves the price up
    local shares = SPEND / max(0.05, m.p)
    cash = cash - SPEND
    m.hold = m.hold + shares
    m.p = min(0.97, m.p + SPEND / 900)
  else
    if m.hold <= 0 then stamp('NOTHING TO SELL', false) return end
    cash = cash + m.hold * m.p
    m.p = max(0.03, m.p - m.hold * m.p / 900)
    m.hold = 0
  end
  m.hist[#m.hist + 1] = m.p
  if #m.hist > 40 then table.remove(m.hist, 1) end
  draw()
  stamp(buy and 'FILLED' or 'SOLD', true)
end

-- ----------------------------------------------------------- lifecycle
function on_enter(r)
  root = r
  draw()
end

local nextTick = 0
function on_tick()
  local now = ms()
  if flash > 0 and now >= flash then
    flash = 0
    led.clear()
    led.show()
    draw()
  end
  -- the room keeps trading while you look at it
  if now >= nextTick then
    nextTick = now + 2600
    local m = markets[1 + floor(rnd() * #markets)]
    m.p = max(0.04, min(0.96, m.p + (rnd() - 0.5) * 0.04))
    m.hist[#m.hist + 1] = m.p
    if #m.hist > 40 then table.remove(m.hist, 1) end
    if flash == 0 then draw() end
  end
end

function on_button(b, kind)
  if kind ~= input.KIND.PRESSED then return end
  local B = input.BUTTON
  if view == 'list' then
    if b == B.UP then cur = cur > 1 and cur - 1 or #markets draw()
    elseif b == B.DOWN then cur = cur < #markets and cur + 1 or 1 draw()
    elseif b == B.A then view = 'market' draw() end
  else
    if b == B.B then view = 'list' draw()
    elseif b == B.A then trade(true)
    elseif b == B.START then trade(false)
    elseif b == B.UP or b == B.DOWN then
      cur = b == B.UP and (cur > 1 and cur - 1 or #markets) or (cur < #markets and cur + 1 or 1)
      draw()
    end
  end
end

function on_exit()
  led.clear()
  led.show()
end
