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

-- The questions this market actually asks, worded as they are on the site.
local markets = {
  { sym = 'HWF', name = 'Two+ hardware finalists',
    q = 'Will two or more Finalists be hardware projects?', p = 0.66, hold = 0 },
  { sym = 'DPC', name = '300+ projects submitted',
    q = 'Will 300 or more projects be submitted on Devpost?', p = 0.41, hold = 0 },
  { sym = 'AIB', name = 'Best Overall is an AI build',
    q = 'Will the Best Overall winner be an AI project?', p = 0.28, hold = 0 },
  { sym = 'BDG', name = 'Badge prize uses radio',
    q = "Will the Hacker Badge prize go to a project that uses the badge's radio?", p = 0.47, hold = 0 },
  { sym = 'QNX', name = 'QNX winner runs on a Pi',
    q = 'Will the QNX prize winner run on a Raspberry Pi?', p = 0.37, hold = 0 },
  { sym = 'SLO', name = 'Solo hacker in the top 5',
    q = 'Will a solo hacker finish in the top five?', p = 0.19, hold = 0 },
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
local send = { on = false, step = 0, at = 0 }   -- the tap-to-pay animation
local rows, mk, sel, stamp, title = {}, {}, nil, nil, nil
local pay = {}                                   -- widgets for tap-to-pay
local COINS = 4

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

local function showPay(on)
  pay.panel:hidden(not on)
  pay.title:hidden(not on)
  pay.msg:hidden(not on)
  pay.me:hidden(not on)
  pay.you:hidden(not on)
  pay.amount:hidden(not on)
  for i = 1, COINS do pay[i]:hidden(true) end
end

local function showMarket(on)
  for k, w in pairs(mk) do
    if k ~= 'cash' and k ~= 'hint' then w:hidden(not on) end
  end
end

function redraw()
  mk.cash:set_text(money(cash) .. ' HACK')
  if send.on then return end
  if view == 'list' then
    showMarket(false)
    showList(true)
    showPay(false)
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
    mk.hint:set_text('A open   START tap-to-pay   UP/DOWN move')
  else
    showList(false)
    showMarket(true)
    showPay(false)
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

  -- Tap to pay, built once and hidden: a panel, two badges, coins between.
  pay.panel = box(root, 16, 52, W - 32, 136, 0xf7f3e8)
  pay.panel:set_border(INK, 2)
  pay.title = label(root, 'TAP TO PAY', 34, 64, INK)
  pay.msg = label(root, '', 34, 92, DIM, 'small')
  pay.me = box(root, 36, 120, 44, 30, INK)
  pay.you = box(root, W - 84, 120, 44, 30, 0xb9b1a0)
  pay.amount = label(root, '', 34, 158, GREEN, 'small')
  for i = 1, COINS do
    pay[i] = box(root, 0, 0, 10, 10, GOLD)
  end

  stamp = label(root, '', 0, 0, GREEN)
  stamp:set_font_size('large')
  stamp:align('center', 0, -6)
  stamp:hidden(true)
  showPay(false)

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

-- Tap to pay, as a little film: find the badge, coins hop across, it lands.
-- The radio build does this for real over Bluetooth; here it is staged so it
-- cannot fail in front of anyone.
local function startSend()
  if cash < SPEND then showStamp('NO FUNDS', false) return end
  send.on, send.step, send.at = true, 1, ms()
  showList(false)
  showMarket(false)
  title:hidden(true)
  stamp:hidden(true)
  showPay(true)
  pay.msg:set_text('looking for a badge nearby...')
  pay.amount:set_text('')
  led.set_all(40, 30, 0)
  led.show()
end

local function stepSend()
  local t = ms() - send.at
  if send.step == 1 and t > 1100 then
    send.step, send.at = 2, ms()
    pay.msg:set_text('found: badge E8:F6 - sending ' .. SPEND .. ' HACK')
    led.set_all(70, 55, 0)
    led.show()
  elseif send.step == 2 then
    -- coins hop from our badge to theirs, staggered
    local span = W - 84 - 36
    local done = true
    for i = 1, COINS do
      local k = (t - (i - 1) * 260) / 900
      if k < 0 then
        pay[i]:hidden(true)
        done = false
      elseif k < 1 then
        done = false
        pay[i]:hidden(false)
        local x = 44 + floor(span * k)
        local hop = floor(26 * (k - k * k) * 4)     -- a low arc
        pay[i]:set_pos(x, 128 - hop)
      else
        pay[i]:hidden(true)
      end
    end
    if done and t > 1500 then
      send.step, send.at = 3, ms()
      pay.you:set_color(GREEN)
      pay.msg:set_text('delivered')
      pay.amount:set_text('-' .. SPEND .. ' HACK   ->   their badge')
      cash = cash - SPEND
      mk.cash:set_text(money(cash) .. ' HACK')
      showStamp('SENT', true)
    end
  elseif send.step == 3 and t > 2200 then
    send.on, send.step = false, 0
    pay.you:set_color(0xb9b1a0)
    showPay(false)
    stamp:hidden(true)
    led.clear()
    led.show()
    redraw()
  end
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
  if send.on then stepSend() return end
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
  if kind ~= input.KIND.PRESSED or send.on then return end
  local B = input.BUTTON
  local n = #markets
  if b == B.UP then cur = cur > 1 and cur - 1 or n
  elseif b == B.DOWN then cur = cur < n and cur + 1 or 1
  elseif b == B.A then
    if view == 'list' then view = 'market' else trade(true) return end
  elseif b == B.B then view = 'list'
  elseif b == B.START then
    if view == 'market' then trade(false) else startSend() end
    return
  end
  redraw()
end

function on_exit()
  led.clear()
  led.show()
end
