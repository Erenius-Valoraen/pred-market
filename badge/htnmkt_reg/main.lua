-- HTN Market: organizer badge. Register a team by bumping badges.
--
-- Flow: team members bump this badge in the Connect app (that stores their
-- verified name + badge id as contacts). Open this app: everyone not yet
-- registered is pre-selected. START sends them over USB serial via
-- badge.sys.log; the laptop bridge forwards them to the market server, where
-- an organizer names the team and opens its market.
--
-- Controls: Up/Down move, A toggle person, B clear, START send, HOME exit.
--
-- Wire format (one log line each, parsed by tools/badge_bridge.py):
--   HTNREG1 BEGIN <rid> <count>
--   HTNREG1 M <rid> <index> <badge_id> <name...>
--   HTNREG1 END <rid>

local ROWS = 7
local SUBMITTED_FILE = "appdata/submitted.txt"

local contacts = {}     -- array of { id = badge_id, name = display name }
local total, loaded = 0, 0
local submitted = {}    -- badge_id -> true (already sent in an earlier team)
local selected = {}     -- badge_id -> true
local cursor, top = 1, 1
local rows = {}
local l_head, l_status
local flash_until = 0
local me = nil

local function clean(s, max)
  s = string.gsub(tostring(s or "?"), "%c", " ")
  if #s > max then s = string.sub(s, 1, max) end
  return s
end

local function leds(r, g, b)
  badge.led.set_all(r, g, b)
  badge.led.show()
end

local function load_submitted()
  local s = badge.fs.read(SUBMITTED_FILE)
  if s then
    for id in string.gmatch(s, "[^\n]+") do submitted[id] = true end
  end
end

local function count_selected()
  local n = 0
  for _ in pairs(selected) do n = n + 1 end
  return n
end

local function redraw()
  if cursor < top then top = cursor end
  if cursor > top + ROWS - 1 then top = cursor - ROWS + 1 end
  for r = 1, ROWS do
    local i = top + r - 1
    local c = contacts[i]
    local t = ""
    if c then
      t = (i == cursor and "> " or "  ") .. (selected[c.id] and "[x] " or "[ ] ") .. clean(c.name, 20)
      if submitted[c.id] then t = t .. " (done)" end
    end
    rows[r]:set_text(t)
  end
  local extra = ""
  if loaded < total then extra = "  loading " .. loaded .. "/" .. total end
  l_head:set_text(count_selected() .. " selected / " .. #contacts .. " bumped" .. extra)
end

local function send_team()
  local picked = {}
  for _, c in ipairs(contacts) do
    if selected[c.id] then picked[#picked + 1] = c end
  end
  if #picked == 0 then
    l_status:set_text("Pick at least one person with A")
    return
  end
  local rid = tostring(badge.sys.ms()) .. "-" .. tostring(badge.sys.random(99999))
  badge.sys.log("HTNREG1 BEGIN " .. rid .. " " .. #picked)
  local ids = {}
  for i, c in ipairs(picked) do
    badge.sys.log("HTNREG1 M " .. rid .. " " .. i .. " " .. c.id .. " " .. c.name)
    submitted[c.id] = true
    ids[#ids + 1] = c.id
  end
  badge.sys.log("HTNREG1 END " .. rid)
  -- One flash write for the whole team, not one per person.
  badge.fs.append(SUBMITTED_FILE, table.concat(ids, "\n") .. "\n")
  selected = {}
  l_status:set_text("Sent " .. #picked .. " - name the team on the admin page")
  flash_until = badge.sys.ms() + 700
  leds(0, 110, 30)
  redraw()
end

function on_enter(root)
  me = badge.me.badge_id()

  local title = badge.ui.label(root, "Register a team")
  title:align("top_mid", 0, 6)

  l_head = badge.ui.label(root, "Reading contacts...")
  l_head:style({ text_font = 14 })
  l_head:align("top_mid", 0, 30)

  for r = 1, ROWS do
    local l = badge.ui.label(root, "")
    l:style({ text_font = 14 })
    l:set_pos(12, 52 + (r - 1) * 20)
    rows[r] = l
  end

  l_status = badge.ui.label(root, "Bump team badges in Connect first")
  l_status:style({ text_font = 14 })
  l_status:align("bottom_mid", 0, -26)

  local hint = badge.ui.label(root, "Up/Dn move  A pick  B clear  START send")
  hint:style({ text_font = 14 })
  hint:align("bottom_mid", 0, -6)

  load_submitted()
  total = badge.contacts.count() or 0
  leds(12, 0, 30)
  redraw()
end

function on_tick()
  local now = badge.sys.ms()
  if flash_until > 0 and now >= flash_until then
    flash_until = 0
    leds(12, 0, 30)
  end
  -- Load contacts a few per tick so a long contact list never blocks the UI.
  if loaded < total then
    local stop = math.min(total, loaded + 8)
    for i = loaded + 1, stop do
      local c = badge.contacts.get(i)
      if c and c.badge_id and c.badge_id ~= me then
        local item = { id = c.badge_id, name = clean(c.name, 32) }
        contacts[#contacts + 1] = item
        if not submitted[item.id] then selected[item.id] = true end
      end
    end
    loaded = stop
    redraw()
  end
end

function on_button(button, kind)
  if kind ~= badge.input.KIND.PRESSED then return end
  local B = badge.input.BUTTON
  if button == B.UP then
    if cursor > 1 then cursor = cursor - 1 end
    redraw()
  elseif button == B.DOWN then
    if cursor < #contacts then cursor = cursor + 1 end
    redraw()
  elseif button == B.A then
    local c = contacts[cursor]
    if c then
      if selected[c.id] then selected[c.id] = nil else selected[c.id] = true end
      redraw()
    end
  elseif button == B.B then
    selected = {}
    redraw()
  elseif button == B.START then
    send_team()
  end
end

function on_exit()
  badge.led.clear()
  badge.led.show()
end
