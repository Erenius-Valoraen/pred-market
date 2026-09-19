"""Badge -> market server bridge.

The organizer badge (running Market Register) is plugged in over USB. When the
organizer presses START it writes registration frames with badge.sys.log,
which appear on the badge's serial console:

    I (123) lua: [htnmkt_reg] HTNREG1 BEGIN <rid> <count>
    I (123) lua: [htnmkt_reg] HTNREG1 M <rid> <index> <badge_id> <name...>
    I (123) lua: [htnmkt_reg] HTNREG1 END <rid>

This bridge reassembles a registration and forwards it ONLY when every member
line arrived, then posts it to the server as a *pending* team for an organizer
to name and confirm on the admin page.

    python tools/badge_bridge.py [--port COM3] [--server http://localhost:8787]

Serial lessons from this badge: DTR/RTS must stay False (asserting DTR resets
the ESP32-C3), and it re-enumerates after a reboot, so reconnect on errors.
"""
import argparse
import json
import pathlib
import re
import sys
import time
import urllib.error
import urllib.request

import serial
import serial.tools.list_ports

ROOT = pathlib.Path(__file__).resolve().parent.parent
FRAME = re.compile(r"HTNREG1 (BEGIN|M|END) (.*)$")


def find_badge_port():
    """The badge is an ESP32-C3 with native USB (VID 303A)."""
    for p in serial.tools.list_ports.comports():
        if p.vid == 0x303A:
            return p.device
    return None


def post(server, token, path, body):
    req = urllib.request.Request(
        f"{server}{path}",
        data=json.dumps(body).encode(),
        headers={"content-type": "application/json", "authorization": f"Bearer {token}"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read())


class Assembler:
    """Collect BEGIN / M... / END into complete registrations."""

    def __init__(self):
        self.open = {}   # rid -> {"count": n, "members": {index: {...}}}

    def feed(self, kind, rest):
        if kind == "BEGIN":
            rid, count = rest.split(" ", 1)
            self.open[rid] = {"count": int(count), "members": {}}
            return None
        if kind == "M":
            parts = rest.split(" ", 3)
            if len(parts) < 4:
                return None
            rid, idx, badge_id, name = parts
            if rid in self.open:
                self.open[rid]["members"][int(idx)] = {"badgeId": badge_id, "name": name.strip()}
            return None
        if kind == "END":
            rid = rest.strip()
            reg = self.open.pop(rid, None)
            if reg is None:
                return None
            if len(reg["members"]) != reg["count"]:
                # A line was lost on the wire. Never forward a partial team.
                print(f"  ! registration {rid} incomplete "
                      f"({len(reg['members'])}/{reg['count']} members) - press START again")
                return None
            members = [reg["members"][i] for i in sorted(reg["members"])]
            return {"rid": rid, "members": members}
        return None


def open_port(port):
    s = serial.Serial()
    s.port, s.baudrate, s.timeout = port, 115200, 0.3
    s.dtr = False
    s.rts = False
    s.open()
    s.dtr = False
    s.rts = False
    return s


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", default=None)
    ap.add_argument("--server", default="http://localhost:8787")
    ap.add_argument("--token-file", default=str(ROOT / "data" / "admin-token.txt"))
    ap.add_argument("--replay", default=None,
                    help="feed a captured serial log file instead of a live badge")
    a = ap.parse_args()

    token = pathlib.Path(a.token_file).read_text().strip()
    asm = Assembler()

    if a.replay:
        sent = 0
        for line in pathlib.Path(a.replay).read_text("utf-8", "replace").splitlines():
            m = FRAME.search(line.strip())
            done = asm.feed(m.group(1), m.group(2)) if m else None
            if done:
                res = post(a.server, token, "/api/admin/pending", done)
                sent += 1
                names = ', '.join(x['name'] for x in done['members'])
                print(f"  -> {'already queued' if res.get('duplicate') else 'pending team'}: {names}")
        print(f"replayed {sent} registration(s)")
        return

    print(f"badge bridge -> {a.server}   (Ctrl+C to stop)")

    while True:
        port = a.port or find_badge_port()
        if not port:
            print("  waiting for the badge to be plugged in...")
            time.sleep(3)
            continue
        try:
            ser = open_port(port)
            print(f"  listening on {port}")
            buf = b""
            while True:
                chunk = ser.read(512)
                if not chunk:
                    continue
                buf += chunk
                *lines, buf = buf.split(b"\n")
                for raw in lines:
                    line = raw.decode("utf-8", "replace").strip()
                    m = FRAME.search(line)
                    if not m:
                        continue
                    done = asm.feed(m.group(1), m.group(2))
                    if done:
                        names = ", ".join(x["name"] for x in done["members"])
                        try:
                            res = post(a.server, token, "/api/admin/pending", done)
                            print(f"  -> {'already queued' if res.get('duplicate') else 'pending team'}: {names}")
                        except (urllib.error.URLError, OSError) as e:
                            print(f"  ! could not reach server ({e}); press START again")
        except (serial.SerialException, OSError) as e:
            print(f"  serial dropped ({e}); reconnecting...")
            time.sleep(2)
        except KeyboardInterrupt:
            print("\nbye")
            sys.exit(0)


if __name__ == "__main__":
    main()
