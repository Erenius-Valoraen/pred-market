"""End-to-end test of badge registration against the REAL badge and the REAL
bridge code, over a single USB connection (the harness presses the badge's
buttons AND plays the bridge).

    python tools/test_badge_flow.py [--upload]

Scenarios, in the order that matters:
  1. server unreachable -> badge says "No reply", nobody marked done,
     selection kept for a retry
  2. server up          -> badge says "OK", person marked done

Only ONE contact is ever selected, the resulting pending entry is dismissed,
and the badge's sent-list and receipts are reset afterwards, so no real
attendee ends up registered.
"""
import argparse
import json
import pathlib
import re
import sys
import time
import urllib.request

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from badge_bridge import (Bridge, ACK_PATH, find_badge_port, open_port)  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent
APP = "/littlefs/apps/htnmkt_reg/main.lua"
SENT = "/littlefs/appdata/htnmkt_reg/submitted.txt"
SERVER = "http://localhost:8787"
TOKEN = (ROOT / "data" / "admin-token.txt").read_text().strip()


def cmd(ser, line, wait=0.6):
    ser.reset_input_buffer()
    ser.write((line + "\r\n").encode())
    out, end = b"", time.time() + wait
    while time.time() < end:
        out += ser.read(4096)
    return out.decode("utf-8", "replace")


def screen(ser):
    t = cmd(ser, "uitree", 2.0)
    return [x for x in re.findall(r'text="([^"]*)"', t) if x and x != "LUA ERROR"]


def title(ser):
    s = screen(ser)
    return s[0] if s else "?"


def reopen():
    for _ in range(25):
        port = find_badge_port()
        if port:
            try:
                return open_port(port)
            except Exception:
                pass
        time.sleep(0.7)
    raise SystemExit("badge did not come back")


def api(path, body=None):
    req = urllib.request.Request(f"{SERVER}{path}", method="POST" if body else "GET",
                                 data=json.dumps(body).encode() if body else None,
                                 headers={"authorization": f"Bearer {TOKEN}",
                                          "content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read())


def pump_for(bridge, seconds):
    end = time.time() + seconds
    while time.time() < end:
        bridge.pump()


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}{('  -> ' + detail) if detail else ''}")
    return cond


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--upload", action="store_true", help="upload the current badge app first")
    a = ap.parse_args()

    ser = reopen()
    time.sleep(0.5)
    cmd(ser, "")
    tool = Bridge(ser, SERVER, TOKEN, log=lambda m: print(f"      bridge: {m.strip()}"))

    # Clean slate on the badge.
    tool.put(SENT, "\n")
    tool.put(ACK_PATH, "\n")
    if a.upload:
        src = (ROOT / "badge" / "htnmkt_reg" / "main.lua").read_text().replace("\r\n", "\n")
        print(f"upload app ({len(src)} bytes): {tool.put(APP, src)}")

    # Fresh boot so the launcher starts at its first entry and memory is clean.
    ser.write(b"reboot\r\n")
    ser.close()
    time.sleep(8)
    ser = reopen()
    time.sleep(1.5)
    cmd(ser, "")
    cmd(ser, "press HOME", 1.0)
    for _ in range(30):
        if title(ser) == "Market Register":
            break
        cmd(ser, "press RIGHT", 0.5)
    else:
        raise SystemExit("could not find Market Register in the launcher")
    cmd(ser, "press A", 3.0)

    # Select exactly one person: clear everything, then pick the cursor row.
    cmd(ser, "press B")
    cmd(ser, "press A")
    s = screen(ser)
    picked = next((x for x in s if x.startswith("> [x]")), None)
    ok = check("exactly one person selected", picked is not None and "1 selected" in s[1], s[1])
    name = picked[6:].strip() if picked else "?"

    # --- 1. server unreachable ------------------------------------------
    print("\nscenario 1: server unreachable (bridge pointed at a dead port)")
    down = Bridge(ser, "http://localhost:9", TOKEN, log=lambda m: print(f"      bridge: {m.strip()}"))
    ser.write(b"press START\r\n")
    pump_for(down, 11)                      # longer than the badge's 8 s timeout
    s = screen(ser)
    status = s[-2] if len(s) >= 2 else ""
    ok &= check("badge reports no reply", status.startswith("No reply"), status)
    ok &= check("person NOT marked done", not any("(done)" in x for x in s))
    ok &= check("selection kept for retry", "1 selected" in s[1], s[1])

    # --- 2. server up -----------------------------------------------------
    print("\nscenario 2: server up")
    up = Bridge(ser, SERVER, TOKEN, log=lambda m: print(f"      bridge: {m.strip()}"))
    ser.write(b"press START\r\n")
    pump_for(up, 5)
    s = screen(ser)
    status = s[-2] if len(s) >= 2 else ""
    ok &= check("badge confirms", status.startswith("OK: sent 1"), status)
    ok &= check(f"{name} marked done", any("(done)" in x for x in s))
    pend = api("/api/admin/pending")
    ok &= check("server holds the pending team", any(p["members"][0]["name"] == name for p in pend),
                f"{len(pend)} pending")

    # --- cleanup: leave no real attendee registered -----------------------
    for p in pend:
        api("/api/admin/pending/dismiss", {"rid": p["rid"]})
    up.put(SENT, "\n")
    up.put(ACK_PATH, "\n")
    cmd(ser, "press HOME")
    ser.close()
    print(f"\ncleanup done (dismissed {len(pend)} pending, reset badge lists)")
    print("RESULT:", "ALL PASS" if ok else "FAILURES ABOVE")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
