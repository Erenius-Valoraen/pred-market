"""The laptop IS the gateway: talk to badges with the laptop's own Bluetooth.

A badge Lua app's radio frame is a plain BLE advertisement: manufacturer
data with company id 0xFFFF whose bytes are b"LUA1" + payload (<= 44 bytes).
Found by scanning a badge from this laptop (see docs in the repo README).
So this process:

  * scans (bleak / WinRT) for badge frames starting "HMK" -> POSTs them to
    the market server (/api/admin/badge/rx), which answers with screen lines;
  * advertises those lines as 20-byte frames "M<tag><cell><text>" through
    Windows' BLE advertisement publisher; badges running HTN Market pick up
    the ones addressed to them.

Measured on hardware: a badge hears a given advertisement only ~1-3 times a
second and ignores payloads over 44 bytes. Extended adverts (44 bytes) don't
add up when run in parallel; legacy ones (20 bytes) do, ~10 frames/s with 8
at once. Hence short frames, several broadcasts at once, fixed airtime per
frame, and background re-sends so a missed frame fills in by itself.

    python tools/radio_node.py [--server http://localhost:8787]
"""
import argparse
import asyncio
import collections
import json
import pathlib
import time
import urllib.error
import urllib.request

from bleak import BleakScanner
from winrt.windows.devices.bluetooth.advertisement import (
    BluetoothLEAdvertisement, BluetoothLEAdvertisementPublisher, BluetoothLEManufacturerData)
from winrt.windows.storage.streams import DataWriter

ROOT = pathlib.Path(__file__).resolve().parent.parent
COMPANY = 0xFFFF
PREFIX = b"LUA1"
SLOTS = 8            # concurrent legacy adverts (measured: ~1.5 receptions/s each, they add up)
REFRESH_SLOTS = int(__import__("os").environ.get("REFRESH_SLOTS", 2))   # leave the radio time to listen
AIRTIME = 2.4        # seconds a new frame is advertised (~95% chance a nearby badge hears it)
REFRESH = 1.2        # airtime for background re-sends of a badge's current screen
ACTIVE_FOR = 180     # keep refreshing a badge's screen this long after it last spoke
OUTBOX_EVERY = 0.25


def badge_mac(addr):
    """Windows reports the address byte-reversed relative to badge.radio.mac()."""
    return ":".join(reversed(addr.upper().split(":")))


def post(server, token, path, body, timeout=5):
    req = urllib.request.Request(
        f"{server}{path}", data=json.dumps(body).encode(), method="POST",
        headers={"content-type": "application/json", "authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def publisher(payload: bytes):
    """A legacy advert: 20 bytes of payload max, but many can run at once."""
    adv = BluetoothLEAdvertisement()
    w = DataWriter()
    w.write_bytes(PREFIX + payload)
    adv.manufacturer_data.append(BluetoothLEManufacturerData(COMPANY, w.detach_buffer()))
    return BluetoothLEAdvertisementPublisher(adv)


class Airwaves:
    """What goes on air. Key = frame[:7] ("M" + tag + cell): newer text wins.

    New frames get AIRTIME in a free slot, newest first, and may bump a slot
    that is only doing a background refresh. When nothing is new, slots cycle
    through every active badge's current frames (REFRESH each), so a part a
    badge missed fills in on its own.
    """

    def __init__(self):
        self.new = collections.OrderedDict()     # key -> frame, waiting for first airing
        self.current = {}                        # key -> latest frame (what the badge should show)
        self.active = {}                         # tag -> last time that badge spoke
        self.slots = [None] * SLOTS              # (key, publisher, ends_at, is_refresh)
        self.cursor = 0

    def add(self, frame):
        key = frame[:7]
        self.current[key] = frame
        self.new.pop(key, None)
        self.new[key] = frame
        self.new.move_to_end(key, last=False)    # newest first

    def heard(self, tag):
        self.active[tag] = time.monotonic()

    def _refresh_pick(self, busy):
        now = time.monotonic()
        keys = [k for k in self.current if now - self.active.get(k[1:6], 0) < ACTIVE_FOR and k not in busy]
        if not keys:
            return None
        self.cursor = (self.cursor + 1) % len(keys)
        return keys[self.cursor]

    def tick(self):
        now = time.monotonic()
        for i, s in enumerate(self.slots):
            if not s:
                continue
            key, pub, ends, refresh = s
            if now >= ends or (refresh and self.new):
                pub.stop()
                self.slots[i] = None
        busy = {s[0] for s in self.slots if s}
        for i, s in enumerate(self.slots):
            if s:
                continue
            key = next((k for k in self.new if k not in busy), None)
            refresh = key is None
            if refresh:
                if sum(1 for x in self.slots if x and x[3]) >= REFRESH_SLOTS:
                    continue
                key = self._refresh_pick(busy)
                if key is None:
                    continue
            else:
                del self.new[key]
            pub = publisher(self.current[key].encode()[:20])
            pub.start()
            self.slots[i] = (key, pub, now + (REFRESH if refresh else AIRTIME), refresh)
            busy.add(key)

    def stop(self):
        for s in self.slots:
            if s:
                s[1].stop()


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--server", default="http://localhost:8787")
    ap.add_argument("--token-file", default=str(ROOT / "data" / "admin-token.txt"))
    a = ap.parse_args()
    token = pathlib.Path(a.token_file).read_text().strip()
    air = Airwaves()
    inbox = asyncio.Queue()
    last = {}                                  # mac -> last accepted payload
    loop = asyncio.get_running_loop()

    def on_adv(dev, ad):
        data = ad.manufacturer_data.get(COMPANY)
        if not data or not data.startswith(PREFIX + b"HMK"):
            return
        mac = badge_mac(dev.address)
        payload = bytes(data[4:]).decode("utf-8", "replace")
        # A badge keeps advertising its last frame until it sends another, so
        # we hear each one many times. Retries carry a new try digit.
        if last.get(mac) == payload:
            return
        last[mac] = payload
        air.heard(mac.replace(":", "")[-5:])
        loop.call_soon_threadsafe(inbox.put_nowait, (mac, ad.rssi, payload))

    async def uplinks():
        while True:
            mac, rssi, payload = await inbox.get()
            try:
                res = await asyncio.to_thread(post, a.server, token, "/api/admin/badge/rx",
                                              {"mac": mac, "rssi": rssi, "payload": payload})
                frames = res.get("frames", [])
                for f in reversed(frames):          # keep row order: row 0 airs first
                    air.add(f)
                print(f"  {time.strftime('%H:%M:%S')}.{int(time.time()*1000)%1000:03d} <- {mac[-8:]} {payload!r}"
                      f"  -> {len(frames)} frame(s)")
            except (urllib.error.URLError, OSError) as e:
                print(f"  ! server unreachable ({e})")

    async def outbox():
        while True:
            await asyncio.sleep(OUTBOX_EVERY)
            try:
                res = await asyncio.to_thread(post, a.server, token, "/api/admin/badge/outbox", {})
                for f in reversed(res.get("frames", [])):
                    air.add(f)
            except (urllib.error.URLError, OSError):
                pass

    async def transmit():
        while True:
            air.tick()
            await asyncio.sleep(0.05)

    scanner = BleakScanner(on_adv, scanning_mode="active")
    await scanner.start()
    print(f"radio node up: scanning + advertising, server {a.server}  (Ctrl+C to stop)")
    try:
        await asyncio.gather(uplinks(), outbox(), transmit())
    finally:
        air.stop()
        await scanner.stop()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nbye")
