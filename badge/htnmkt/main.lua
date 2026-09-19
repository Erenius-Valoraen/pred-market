-- HTN Market: trade the hackathon's prediction markets from your badge.
--
-- A thin radio terminal: the markets, your wallet and the screen layout live
-- on the laptop behind the gateway badge. This app shows the lines it is
-- sent and sends back button presses. Kept tiny on purpose: Bluetooth needs
-- almost all of the badge's RAM, and every compiled line of Lua costs some.
--
-- Uplink   (badge -> gateway): "HMK" seq button   e.g. HMK34  (button number)
--                               "HMK" seq "H" name   on open
-- Downlink (gateway -> badge): "HMD" tag row text e.g. HMD29D3F42 Aurora 42%
--   tag = last 6 hex digits of this badge's radio address, row "0".."9".

local ui, radio, ms = badge.ui.label, badge.radio, badge.sys.ms
local sub, byte, gsub = string.sub, string.byte, string.gsub
local P = badge.input.KIND.PRESSED
local nm = badge.me.name() or ""   -- shown on the leaderboard
local pairs, cg, G = pairs, collectgarbage, _G

-- Free RAM for Bluetooth: empty every library table we don't hold a local to.
for _, t in pairs({ badge, string, table, math, utf8 }) do
  for k in pairs(t) do t[k] = nil end
end
for k in pairs(G) do G[k] = nil end
cg('collect')

local rows, on, me, seq, pend, tries, at = {}, false, nil, 0, nil, 0, 0

function on_enter(root)
  for r = 1, 10 do
    local l = ui(root, "")
    l:style({ text_font = 14 })
    l:set_pos(6, 2 + (r - 1) * 23)
    rows[r] = l
  end
  rows[1]:set_text("HTN Market - starting radio")
  at = ms() + 400
end

local function tx(k)
  seq = (seq + 1) % 10
  pend, tries, at = "HMK" .. seq .. k, 0, 0
end

function on_tick()
  cg('step', 1)
  local now = ms()
  if not on then
    if now < at then return end
    cg('collect')
    on = radio.enable()
    if not on then
      rows[1]:set_text("Radio failed - HOME, then reopen")
      at = now + 1e9
      return
    end
    me = "HMD" .. sub((gsub(radio.mac(), ":", "")), -6)
    radio.on_recv(function(_, _, p)
      if sub(p, 1, 9) == me then
        local r = rows[byte(p, 10) - 47]
        if r then r:set_text(sub(p, 11)) pend = nil end
      end
    end)
    tx("H" .. sub(nm, 1, 30))
  end
  -- (Re)send the last press until the laptop answers; frames can be lost.
  if pend and now >= at then
    tries = tries + 1
    if tries > 4 then
      pend = nil
      rows[10]:set_text("No reply - get closer to the market booth")
      return
    end
    at = now + 1500
    radio.send(pend)
  end
end

function on_button(b, kind)
  if on and kind == P then tx(b) end
end

function on_exit()
  if on then radio.on_recv(nil) radio.disable() end
end
