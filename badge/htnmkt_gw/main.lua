-- HTN Market gateway: the one badge plugged into the laptop.
--
-- Radio -> laptop: every "HM" frame heard from a player badge is logged to
-- USB serial as  "HMU <mac> <rssi> <payload>".
-- Laptop -> radio: the laptop writes frames (one per line) into
-- appdata/out.txt with the console `put`, then bumps the integer config
-- value htnmkt_gw.v. We notice the change, read the file once and
-- broadcast the frames, a few per tick.
--
-- Memory is the whole game here. Bluetooth needs ~50 KB of the ~57 KB a
-- Lua app can free, so before enabling it we keep local references to the
-- few functions we use and empty every other library table, then run the
-- garbage collector every tick.

local sys, radio, fs = badge.sys, badge.radio, badge.fs
local log, ms, stats = sys.log, sys.ms, sys.stats
local cfg = badge.config_get
local ui = badge.ui.label
local find, sub = string.find, string.sub
local tostring, pairs, collectgarbage, G = tostring, pairs, collectgarbage, _G

for _, t in pairs({ badge, string, table, math, utf8 }) do
  for k in pairs(t) do t[k] = nil end
end
for k in pairs(G) do G[k] = nil end
collectgarbage('collect')

local SLUG = "htnmkt_gw"   -- must match manifest slug (config is per app)
local OUT = "appdata/out.txt"
local on, seen_v, buf, pos = false, 0, nil, 1
local status, t_on = nil, 0
local heard, sent = 0, 0

function on_enter(root)
  status = ui(root, "HTN Market gateway: starting radio")
  status:align("center", 0, 0)
  t_on = ms() + 600
end

local function recv(mac, rssi, p)
  if sub(p, 1, 2) == "HM" then
    heard = heard + 1
    log("HMU " .. mac .. " " .. rssi .. " " .. p)
  end
end

function on_tick()
  collectgarbage('step', 1)
  if not on then
    if t_on > 0 and ms() >= t_on then
      t_on = 0
      collectgarbage('collect')
      on = radio.enable()
      if on then
        radio.on_recv(recv)
        seen_v = cfg(SLUG, "v") or 0      -- ignore a batch left from last run
        log("HMG up " .. radio.mac() .. " free=" .. stats().free_heap)
        status:set_text("Gateway live - keep plugged in")
      else
        log("HMG radio failed")
        status:set_text("Radio failed - reboot badge")
      end
    end
    return
  end

  -- New batch from the laptop?
  if not buf then
    local v = cfg(SLUG, "v")
    if v and v ~= seen_v then
      seen_v = v
      buf, pos = fs.read(OUT), 1
      if not buf then log("HMG read failed v=" .. v) end
    end
    return
  end

  -- Broadcast at most 2 frames per tick.
  for _ = 1, 2 do
    local e = find(buf, "\n", pos, true)
    if not e then buf = nil log("HMG done v=" .. seen_v .. " sent=" .. sent) return end
    local f = sub(buf, pos, e - 1)
    pos = e + 1
    if #f > 0 then
      if radio.send(f) then sent = sent + 1 else log("HMG send failed") end
    end
  end
end

function on_exit()
  if on then radio.on_recv(nil) radio.disable() end
end
