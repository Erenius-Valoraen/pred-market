-- HTN Market: trade the hackathon's prediction markets from your badge.
--
-- The market laptop writes the screen: ten rows of text sent over Bluetooth.
-- The CURSOR lives here, so UP/DOWN highlight the next row instantly and cost
-- no radio at all; the row number only travels when you actually do something
-- with it. Bluetooth needs almost all of the badge's RAM, so this file stays
-- small: every compiled line costs memory the radio then cannot have.
--
-- Uplink   (badge -> laptop): "HMK" seq try key
--   key = "A" row   open / buy on the highlighted row      "B" back
--         "S" row   sell everything on the highlighted row
--         "N"/"P"   no room to move: next / previous page
--         "L"/"R"   smaller / bigger trade size
--         "H" name  opened the app
--   try = retry counter, so a retry differs from the advert still on air.
-- Downlink (laptop -> badge): "M" tag cell text  (<= 20 bytes)
--   tag = last 5 hex digits of this badge's radio address; cell = char
--   48 + 3*row + part, so each row arrives as up to 3 parts of 13 chars.
--   cell "~" = ack of press <seq>: we resend a press until it is acked.

local ui, radio, ms = badge.ui.label, badge.radio, badge.sys.ms
local sub, byte, gsub = string.sub, string.byte, string.gsub
local nm = badge.me.name() or ""   -- shown on the leaderboard
local pairs, cg, G = pairs, collectgarbage, _G

-- Free RAM for Bluetooth: empty every library table we don't hold a local to.
for _, t in pairs({ badge, string, table, math, utf8 }) do
  for k in pairs(t) do t[k] = nil end
end
for k in pairs(G) do G[k] = nil end
cg('collect')

local rows, parts, text = {}, {}, {}
local cur = 1                       -- highlighted row, 1..7 (0 is the header)
local on, me, seq, key, tries, at, heard = false, nil, 0, nil, 0, 0, false

local function hl(r)
  rows[cur + 1]:set_color(0x93a0b4)
  cur = r
  rows[cur + 1]:set_color(0x6fd3ff)
end

function on_enter(root)
  for r = 1, 10 do
    local l = ui(root, "")
    l:style({ text_font = 14 })
    l:set_pos(8, 2 + (r - 1) * 23)
    l:set_color(0x93a0b4)
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
  -- letting garbage pile up instead crashed the badge.
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
        if c == 78 then                                    -- "~": ack
          if byte(p, 8) - 48 == seq then key = nil end
          return
        end
        local b, r = c - c % 3, rows[c // 3 + 1]
        if r then
          parts[c] = sub(p, 8)
          text[c // 3] = (parts[b] or "") .. (parts[b + 1] or "") .. (parts[b + 2] or "")
          r:set_text(text[c // 3])
        end
      end
    end)
    rows[1]:set_text("HTN Market - finding the market")
    hl(1)
    tx("H" .. sub(nm, 1, 30))
  end
  -- (Re)send the last press until the laptop answers; frames can be lost.
  if key and now >= at then
    if tries > 5 then
      key = nil
      rows[9]:set_text("No reply - get closer to the laptop")
      return
    end
    radio.send("HMK" .. seq .. tries .. key)
    tries, at = tries + 1, now + 2000
  end
end

function on_button(b, kind)
  if not on or kind ~= 0 then return end                   -- 0 = pressed
  if b == 6 or b == 3 then                                 -- UP / DOWN
    local step = b == 6 and -1 or 1
    for r = cur + step, b == 6 and 1 or 7, step do         -- skip blank rows
      if (text[r] or "") ~= "" then hl(r) return end
    end
    tx(b == 6 and "P" or "N")                              -- edge: ask to page
  elseif b == 0 then tx("A" .. cur)
  elseif b == 8 then tx("S" .. cur)
  elseif b == 1 then tx("B")
  elseif b == 4 then tx("L")
  elseif b == 5 then tx("R")
  end
end

function on_exit()
  if on then radio.on_recv(nil) radio.disable() end
end
