-- HTN prediction market: register your team by tapping badges.
-- Controls: Up/Down scroll contacts, A broadcast register, B rescan, HOME exit.

local PREFIX = "HTNM1:"
local MAXPAY = 44

local radio_ok = false
local sent, recvd, dropped_seen = 0, 0, 0
local next_send, led_until, led_mode = 0, 0, "idle"
local idx, n_contacts = 1, 0
local me_id, me_name = "?", "?"
local l_me, l_team, l_status, l_peer

local function leds(r, g, b)
  badge.led.set_all(r, g, b)
  badge.led.show()
end

local function contact_text()
  if n_contacts == 0 then
    return "No bumps yet\nOpen Connect and bump a badge"
  end
  if idx < 1 then idx = n_contacts end
  if idx > n_contacts then idx = 1 end
  local c = badge.contacts.get(idx)
  if not c then
    return idx .. "/" .. n_contacts .. "  (unavailable)"
  end
  return idx .. "/" .. n_contacts .. "   " .. (c.name or "?")
end

local function refresh_team()
  n_contacts = badge.contacts.count() or 0
  l_team:set_text(contact_text())
end

-- 44-byte radio ceiling: prefix + opcode + badge id, truncated defensively.
local function register_frame()
  local body = PREFIX .. "R" .. me_id
  if #body > MAXPAY then body = string.sub(body, 1, MAXPAY) end
  return body
end

function on_enter(root)
  -- Enable Bluetooth FIRST. BLE needs a large contiguous block of system RAM;
  -- building the UI first fragments the heap (largest block fell to 24 KB)
  -- and enable() then fails.
  local s0 = badge.sys.stats()
  radio_ok = badge.radio.enable()
  local s1 = badge.sys.stats()
  badge.sys.log("radio.enable=" .. tostring(radio_ok) ..
                " free_before=" .. tostring(s0.free_heap) ..
                " free_after=" .. tostring(s1.free_heap))

  me_id = badge.me.badge_id() or "unprovisioned"
  me_name = badge.me.name() or "Unknown"

  local title = badge.ui.label(root, "HTN Market - Register")
  title:align("top_mid", 0, 10)

  l_me = badge.ui.label(root, me_name .. "\n" .. me_id)
  l_me:style({text_font = 14, text_align = "center"})
  l_me:align("top_mid", 0, 40)

  l_team = badge.ui.label(root, "Reading contacts...")
  l_team:style({text_font = 18, text_align = "center"})
  l_team:align("center", 0, -6)

  l_peer = badge.ui.label(root, "No frames received")
  l_peer:style({text_font = 14, text_align = "center"})
  l_peer:align("center", 0, 34)

  l_status = badge.ui.label(root, "Starting radio...")
  l_status:style({text_font = 14})
  l_status:align("bottom_mid", 0, -34)

  local hint = badge.ui.label(root, "Up/Down team   A register   B rescan")
  hint:style({text_font = 14})
  hint:align("bottom_mid", 0, -12)

  refresh_team()

  if radio_ok then
    l_status:set_text("Radio ready - press A")
    badge.radio.on_recv(function(mac, rssi, payload)
      if not payload then return end
      if string.sub(payload, 1, #PREFIX) ~= PREFIX then return end
      recvd = recvd + 1
      l_peer:set_text(string.format("%s  %d dBm  (%d)", mac, rssi, recvd))
      led_mode, led_until = "rx", badge.sys.ms() + 250
    end)
  else
    l_status:set_text("Radio unavailable")
  end

  -- Crash-proof diagnostics, readable over serial:
  --   cat /littlefs/appdata/htnmkt_reg/probe.txt
  badge.fs.write("appdata/probe.txt",
    "id=" .. me_id ..
    "\nname=" .. me_name ..
    "\ncontacts=" .. n_contacts ..
    "\nradio=" .. tostring(radio_ok) ..
    "\nmac=" .. tostring(badge.radio.mac()) ..
    "\nframe_len=" .. #register_frame() ..
    "\nfw=" .. tostring(badge.sys.version()) .. "\n")

  badge.sys.log("register: id=" .. me_id .. " contacts=" .. n_contacts ..
                " radio=" .. tostring(radio_ok))

  leds(0, 0, 40)
end

function on_tick()
  local now = badge.sys.ms()
  if led_until > 0 and now >= led_until then
    led_until, led_mode = 0, "idle"
    leds(0, 0, 40)
  elseif led_mode == "tx" then
    leds(0, 90, 0)
  elseif led_mode == "rx" then
    leds(0, 80, 90)
  end
  if radio_ok then
    local d = badge.radio.dropped()
    if d and d ~= dropped_seen then
      dropped_seen = d
      badge.sys.log("radio dropped=" .. d)
    end
  end
end

function on_button(button, kind)
  if kind ~= badge.input.KIND.PRESSED then return end
  local B = badge.input.BUTTON
  if button == B.UP then
    idx = idx - 1
    l_team:set_text(contact_text())
  elseif button == B.DOWN then
    idx = idx + 1
    l_team:set_text(contact_text())
  elseif button == B.B then
    refresh_team()
    l_status:set_text("Rescanned contacts")
  elseif button == B.A then
    if not radio_ok then
      l_status:set_text("Radio unavailable")
      return
    end
    local now = badge.sys.ms()
    if now < next_send then
      l_status:set_text("Wait a moment, then A")
      return
    end
    next_send = now + 1000
    if badge.radio.send(register_frame()) then
      sent = sent + 1
      l_status:set_text("Registered (queued) x" .. sent)
      led_mode, led_until = "tx", now + 250
    else
      l_status:set_text("Send failed - retry with A")
    end
  end
end

function on_exit()
  if radio_ok then
    badge.radio.on_recv(nil)
    badge.radio.disable()
  end
  badge.led.clear()
  badge.led.show()
end
