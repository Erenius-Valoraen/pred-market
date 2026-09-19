"""Badge -> market server bridge, with receipts back to the badge.

The organizer badge (running Market Register) is plugged in over USB. When the
organizer presses START it writes registration frames with badge.sys.log,
which appear on the badge's serial console:

    I (123) lua: [htnmkt_reg] HTNREG1 BEGIN <rid> <count>
    I (123) lua: [htnmkt_reg] HTNREG1 M <rid> <index> <badge_id> <name...>
    I (123) lua: [htnmkt_reg] HTNREG1 END <rid>

The bridge reassembles a registration, forwards it ONLY when every member
line arrived, and only once the server has ACCEPTED it writes a receipt back
onto the badge (appdata/acks.txt, via the console's `put` command). The badge
marks people registered only when it sees that receipt, so a stopped server
or bridge shows up on the badge instead of silently losing a team.

    python tools/badge_bridge.py [--port COM3] [--server http://localhost:8787]
    python tools/badge_bridge.py --replay capture.log   (no badge needed)

Serial lessons from this badge: DTR/RTS must stay False (asserting DTR resets
the ESP32-C3); `put` commands must end in a bare CR (a trailing LF becomes
data byte 1); it re-enumerates after a reboot, so reconnect on errors.
"""
import argparse
import collections
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
ACK_PATH = "/littlefs/appdata/htnmkt_reg/acks.txt"


def find_badge_port():
    """The badge is an ESP32-C3 with native USB (VID 303A)."""
    for p in serial.tools.list_ports.comports():
        if p.vid == 0x303A:
            return p.device
    return None


def open_port(port):
    s = serial.Serial()
    s.port, s.baudrate, s.timeout = port, 115200, 0.2
    s.dtr = False
    s.rts = False
    s.open()
    s.dtr = False
    s.rts = False
    return s


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
            parts = rest.split(" ", 1)
            if len(parts) == 2 and parts[1].strip().isdigit():
                self.open[parts[0]] = {"count": int(parts[1]), "members": {}}
            return None
        if kind == "M":
            parts = rest.split(" ", 3)
            if len(parts) == 4 and parts[1].isdigit() and parts[0] in self.open:
                self.open[parts[0]]["members"][int(parts[1])] = {
                    "badgeId": parts[2], "name": parts[3].strip()}
            return None
        if kind == "END":
            rid = rest.strip()
            reg = self.open.pop(rid, None)
            if reg is None:
                return None
            if len(reg["members"]) != reg["count"]:
                # A line was lost on the wire. Never forward a partial team;
                # no receipt goes back, so the badge reports it and keeps the
                # selection for a retry.
                print(f"  ! registration {rid} incomplete "
                      f"({len(reg['members'])}/{reg['count']}) - not forwarded")
                return None
            return {"rid": rid, "members": [reg["members"][i] for i in sorted(reg["members"])]}
        return None


class Bridge:
    def __init__(self, ser, server, token, log=print):
        self.ser = ser
        self.server = server
        self.token = token
        self.log = log
        self.asm = Assembler()
        self.buf = b""
        self.acked = collections.deque(maxlen=20)   # recent receipts

    # ------------------------------------------------------------- serial
    def _read_until(self, marker, timeout):
        """Read until `marker` appears. Everything read is kept in self.buf so
        a registration arriving mid-handshake is still processed afterwards."""
        got = b""
        end = time.time() + timeout
        while time.time() < end:
            chunk = self.ser.read(256)
            if chunk:
                got += chunk
                if marker in got:
                    break
        self.buf += got
        return marker in got

    def put(self, path, data):
        """Write a file on the badge through its console `put` command."""
        raw = data.encode()
        self.ser.write(f"put {path} {len(raw)}\r".encode())   # bare CR, no LF
        if not self._read_until(b"READY", 4):
            return False
        for i in range(0, len(raw), 32):
            self.ser.write(raw[i:i + 32])
            time.sleep(0.02)
        return self._read_until(b"OK", 4)

    def ack(self, rid):
        self.acked.append(rid)
        if self.put(ACK_PATH, "\n".join(self.acked) + "\n"):
            self.log(f"  <- receipt written to badge ({rid})")
        else:
            self.log(f"  ! could not write receipt for {rid}; badge will time out and let you retry")

    # ------------------------------------------------------------ frames
    def handle(self, done):
        names = ", ".join(x["name"] for x in done["members"])
        try:
            res = post(self.server, self.token, "/api/admin/pending", done)
        except (urllib.error.URLError, OSError) as e:
            # No receipt: the badge will say "No reply" and keep the selection.
            self.log(f"  ! server unreachable ({e}); badge will ask to retry")
            return
        self.log(f"  -> {'already queued' if res.get('duplicate') else 'pending team'}: {names}")
        self.ack(done["rid"])

    def pump(self):
        chunk = self.ser.read(512)
        if chunk:
            self.buf += chunk
        while b"\n" in self.buf:
            raw, self.buf = self.buf.split(b"\n", 1)
            m = FRAME.search(raw.decode("utf-8", "replace").strip())
            if m:
                done = self.asm.feed(m.group(1), m.group(2))
                if done:
                    self.handle(done)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", default=None)
    ap.add_argument("--server", default="http://localhost:8787")
    ap.add_argument("--token-file", default=str(ROOT / "data" / "admin-token.txt"))
    ap.add_argument("--replay", default=None,
                    help="feed a captured serial log file instead of a live badge")
    a = ap.parse_args()
    token = pathlib.Path(a.token_file).read_text().strip()

    if a.replay:
        asm = Assembler()
        sent = 0
        for line in pathlib.Path(a.replay).read_text("utf-8", "replace").splitlines():
            m = FRAME.search(line.strip())
            done = asm.feed(m.group(1), m.group(2)) if m else None
            if done:
                res = post(a.server, token, "/api/admin/pending", done)
                sent += 1
                names = ", ".join(x["name"] for x in done["members"])
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
            bridge = Bridge(open_port(port), a.server, token)
            print(f"  listening on {port}")
            while True:
                bridge.pump()
        except (serial.SerialException, OSError) as e:
            print(f"  serial dropped ({e}); reconnecting...")
            time.sleep(2)
        except KeyboardInterrupt:
            print("\nbye")
            sys.exit(0)


if __name__ == "__main__":
    main()
