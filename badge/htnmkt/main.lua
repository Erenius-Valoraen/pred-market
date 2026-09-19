-- HTN Market: trade the hackathon's prediction markets from your badge.
--
-- A thin radio terminal: the markets, your wallet and the screen layout live
-- on the market laptop, which talks to badges with its own Bluetooth. This
-- app shows the text it is sent and sends back button presses. Kept tiny on
-- purpose: Bluetooth needs almost all of the badge's RAM, and every compiled
-- line of Lua costs some.
--
-- Uplink   (badge -> laptop): "HMK" seq try button  e.g. HMK304 (button number)
--                              "HMK" seq try "H" name   on open
--   try = retry counter, so a retry differs from the advert still on air.
-- Downlink (laptop -> badge): "M" tag cell text        (<= 20 bytes)
--   tag = last 5 hex digits of this badge's radio address; cell = char
--   48 + 3*row + part; a row's text is its 3 parts joined. Short frames fit a
--   legacy advert, which lets the laptop run many broadcasts at once.
--   cell "~" = ack: text is the seq of the press the laptop received; we
--   keep resending a press until its ack arrives.

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

local rows, parts, on, me, seq, key, tries, at = {}, {}, false, nil, 0, nil, 0, 0
local heard = false   -- frames arrived since the last full GC

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
  key, tries, at = k, 0, 0
end

function on_tick()
  -- Every received frame (ours or not) leaves garbage strings behind, and a
  -- busy venue means many frames. A full GC of this small heap takes a few ms;
  -- letting garbage pile up instead crashed the badge (Lua peak 24 KB).
  if heard then heard = false cg('collect') else cg('step', 1) end
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
    me = "M" .. sub((gsub(radio.mac(), ":", "")), -5)
    radio.on_recv(function(_, _, p)
      heard = true
      if sub(p, 1, 6) == me then
        local c = byte(p, 7) - 48
        if c == 78 then                              -- "~" ack
          if byte(p, 8) - 48 == seq then key = nil end
          return
        end
        local b = c - c % 3
        local r = rows[b // 3 + 1]
        if r then
          parts[c] = sub(p, 8)
          r:set_text((parts[b] or "") .. (parts[b + 1] or "") .. (parts[b + 2] or ""))
        end
      end
    end)
    rows[1]:set_text("HTN Market - finding the market")
    tx("H" .. sub(nm, 1, 30))
  end
  -- (Re)send the last press until the laptop answers; frames can be lost.
  if key and now >= at then
    if tries > 5 then
      key = nil
      rows[10]:set_text("No reply - get closer to the market laptop")
      return
    end
    radio.send("HMK" .. seq .. tries .. key)
    tries, at = tries + 1, now + 2000
  end
end

function on_button(b, kind)
  if on and kind == P then tx(b) end
end

function on_exit()
  if on then radio.on_recv(nil) radio.disable() end
end
