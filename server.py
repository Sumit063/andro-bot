#!/usr/bin/env python3
"""Tab Command Center — the Mac-side hub.

Serves the tablet web app and keeps one WebSocket open per tablet, pushing live
state the moment it changes:
  * now playing + controls      (media-control)
  * front app / tab / idle / keys / CPU / battery   (bin/cc-helper events)
  * system-audio spectrum       (bin/cc-helper audio)
  * calendar                    (bin/cc-helper calendar)
  * Claude Code hook events     (GET /api/event?e=thinking|done|attention)

Standard library only.
"""
import asyncio
import base64
import hashlib
import json
import mimetypes
import os
import shutil
import socket
import struct
import sys
import time
from asyncio.subprocess import DEVNULL, PIPE
from urllib.parse import parse_qs, urlsplit

ROOT = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(ROOT, "web")
HELPER = os.path.join(ROOT, "bin", "cc-helper")
CONFIG_PATH = os.path.join(ROOT, "config.json")
if not os.path.exists(CONFIG_PATH):  # first run: fall back to the shipped example
    CONFIG_PATH = os.path.join(ROOT, "config.example.json")
PORT = int(os.environ.get("CC_PORT", "8765"))
MEDIA_CONTROL = shutil.which("media-control") or "/opt/homebrew/bin/media-control"
WS_GUID = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

BROWSERS = {
    "com.google.Chrome", "com.google.Chrome.canary", "com.brave.Browser", "com.microsoft.edgemac",
    "company.thebrowser.Browser", "com.vivaldi.Vivaldi", "com.apple.Safari",
}
APP_NAMES = {
    "com.google.Chrome": "Chrome", "com.apple.Safari": "Safari", "com.brave.Browser": "Brave",
    "company.thebrowser.Browser": "Arc", "com.microsoft.edgemac": "Edge", "com.spotify.client": "Spotify",
    "com.apple.Music": "Music", "com.apple.TV": "TV", "com.apple.podcasts": "Podcasts",
    "org.videolan.vlc": "VLC", "com.colliderli.iina": "IINA",
}
CLAUDE_STATES = {"thinking", "done", "attention", "idle"}

mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("application/manifest+json", ".webmanifest")
mimetypes.add_type("font/woff2", ".woff2")


def log(*args):
    print(time.strftime("%H:%M:%S"), *args, file=sys.stderr, flush=True)


def now_ms():
    return int(time.time() * 1000)


def pretty_host(host):
    parts = [p for p in host.split(".") if p not in ("www", "m", "open", "app", "web")]
    return parts[0].capitalize() if parts else host


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


async def run(*args, timeout=5.0):
    try:
        proc = await asyncio.create_subprocess_exec(*args, stdout=PIPE, stderr=DEVNULL)
    except OSError as e:
        log("cannot run", args[0], e)
        return ""
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout)
        return out.decode("utf-8", "replace")
    except asyncio.TimeoutError:
        proc.kill()
        return ""


# ---------------------------------------------------------------- WebSocket

def ws_frame(opcode, payload):
    n = len(payload)
    if n < 126:
        head = struct.pack("!BB", 0x80 | opcode, n)
    elif n < 65536:
        head = struct.pack("!BBH", 0x80 | opcode, 126, n)
    else:
        head = struct.pack("!BBQ", 0x80 | opcode, 127, n)
    return head + payload


async def ws_read(reader):
    b1, b2 = await reader.readexactly(2)
    opcode, n = b1 & 0x0F, b2 & 0x7F
    if n == 126:
        (n,) = struct.unpack("!H", await reader.readexactly(2))
    elif n == 127:
        (n,) = struct.unpack("!Q", await reader.readexactly(8))
    if n > 1 << 20:
        raise ConnectionError("frame too large")
    mask = await reader.readexactly(4) if b2 & 0x80 else None
    data = await reader.readexactly(n)
    if mask:
        data = bytes(b ^ mask[i & 3] for i, b in enumerate(data))
    return opcode, data


class Client:
    def __init__(self, writer):
        self.writer = writer

    def _send(self, frame, droppable=False):
        t = self.writer.transport
        if t.is_closing():
            return
        if droppable and t.get_write_buffer_size() > 32 * 1024:
            return  # tablet is behind; skip a spectrum frame rather than add lag
        self.writer.write(frame)

    def text(self, obj):
        self._send(ws_frame(1, json.dumps(obj, separators=(",", ":")).encode()))

    def binary(self, data):
        self._send(ws_frame(2, data), droppable=True)


# ---------------------------------------------------------------- Hub

class Hub:
    def __init__(self):
        self.clients = set()
        self.config = {}
        self.config_mtime = 0
        self.media_raw = None
        self.media_key = None
        self.art = None  # (mime, bytes, hash)
        self.art_task = None
        self.front = {"name": "", "bundle": ""}
        self.url = {"bundle": "", "url": "", "title": ""}
        self.activity = {"scene": "default", "label": "", "app": "", "host": "", "title": "", "since": now_ms()}
        self.sys = {"cpu": None, "batt": None}
        self.idle = 0
        self.perm = {"media": None, "audio": None, "keys": None, "url": None, "calendar": None}
        self.volume = None
        self.vol_target = None
        self.vol_busy = False
        self.vol_quiet_until = 0
        self.claude = {"state": "idle", "since": now_ms()}
        self.calendar = None
        self.audio_proc = None

    # ---- state plumbing
    def snapshot(self):
        return {
            "media": self.media_view(), "activity": self.activity, "sys": self.sys, "idle": self.idle,
            "perm": self.perm, "volume": self.volume, "claude": self.claude, "calendar": self.calendar,
            "config": self.public_config(),
        }

    def public_config(self):
        return {k: self.config.get(k) for k in ("name", "location", "clock24", "idle", "dpr")}

    def broadcast(self, obj):
        for c in list(self.clients):
            c.text(obj)

    def patch(self, key, value):
        self.broadcast({"t": "patch", "k": key, "v": value})

    def set_perm(self, key, ok):
        if self.perm.get(key) != ok:
            self.perm[key] = ok
            self.patch("perm", self.perm)

    # ---- config
    def load_config(self):
        try:
            mtime = os.path.getmtime(CONFIG_PATH)
            if mtime == self.config_mtime:
                return False
            with open(CONFIG_PATH) as f:
                self.config = json.load(f)
            self.config_mtime = mtime
            log("config loaded:", len(self.config.get("rules", [])), "rules")
            return True
        except (OSError, ValueError) as e:
            log("config error:", e)
            self.config_mtime = os.path.getmtime(CONFIG_PATH) if os.path.exists(CONFIG_PATH) else 0
            return False

    @staticmethod
    def web_version():
        return max((os.path.getmtime(os.path.join(d, f)) for d, _, fs in os.walk(WEB) for f in fs), default=0)

    async def config_loop(self):
        web_v = self.web_version()
        while True:
            await asyncio.sleep(2)
            v = self.web_version()
            if v != web_v:  # app files edited → tablets reload themselves
                web_v = v
                self.broadcast({"t": "reload"})
            if self.load_config():
                self.patch("config", self.public_config())
                self.recompute_activity()
                if not self.live_audio() and self.audio_proc and self.audio_proc.returncode is None:
                    self.audio_proc.terminate()  # stop screen capture immediately

    # ---- activity (what the bot reacts to)
    def recompute_activity(self):
        name, bundle = self.front["name"], self.front["bundle"]
        url = title = host = ""
        if bundle in BROWSERS and self.url.get("bundle") == bundle:
            url, title = self.url.get("url", ""), self.url.get("title", "")
            host = (urlsplit(url).hostname or "").lower()
        scene, label = "default", name
        for rule in self.config.get("rules", []):
            if host and (any(host == s or host.endswith("." + s) for s in rule.get("sites", []))
                         or any(u in url for u in rule.get("urls", []))):
                scene, label = rule.get("scene", "default"), rule.get("label") or pretty_host(host)
                break
            if name in rule.get("apps", []) or bundle in rule.get("apps", []):
                scene, label = rule.get("scene", "default"), rule.get("label") or name
                break
        prev = self.activity
        since = prev["since"] if (scene, label) == (prev["scene"], prev["label"]) else now_ms()
        act = {"scene": scene, "label": label, "app": name, "host": host, "title": title[:140], "since": since}
        if act != prev:
            self.activity = act
            self.patch("activity", act)

    # ---- now playing
    def media_view(self):
        p = self.media_raw
        if not p:
            return None
        dur = (p.get("durationMicros") or 0) / 1e6
        el = (p.get("elapsedTimeMicros") or 0) / 1e6
        playing = bool(p.get("playing"))
        rate = p.get("playbackRate") or 1.0
        ts = p.get("timestampEpochMicros")
        if playing and ts:
            el += max(0.0, time.time() - ts / 1e6) * rate
        if dur:
            el = min(el, dur)
        bundle = p.get("parentApplicationBundleIdentifier") or p.get("bundleIdentifier") or ""
        return {
            "title": p.get("title") or "", "artist": p.get("artist") or "", "album": p.get("album") or "",
            "app": APP_NAMES.get(bundle, bundle.split(".")[-1].capitalize() if bundle else ""),
            "playing": playing, "duration": round(dur, 2), "elapsed": round(el, 2),
            "rate": rate if playing else 0, "art": "/art/" + self.art[2] if self.art else None,
        }

    def on_media(self, line):
        try:
            obj = json.loads(line)
        except ValueError:
            return
        p = obj.get("payload", obj) if isinstance(obj, dict) else None
        if not p or not p.get("title"):
            if self.media_raw is not None:
                self.media_raw = self.media_key = self.art = None
                self.patch("media", None)
            return
        key = (p.get("title"), p.get("artist"), p.get("bundleIdentifier"))
        self.media_raw = p
        if key != self.media_key:
            self.media_key = key
            self.art = None
            if self.art_task:
                self.art_task.cancel()
            self.art_task = asyncio.ensure_future(self.fetch_art(key))
        self.patch("media", self.media_view())

    async def fetch_art(self, key):
        # Browsers often publish artwork a moment after the title, so look a few times.
        for delay in (0.15, 1.5, 4.0):
            await asyncio.sleep(delay)
            if self.media_key != key:
                return
            try:
                j = json.loads(await run(MEDIA_CONTROL, "get") or "null")
            except ValueError:
                continue
            data = (j or {}).get("artworkData")
            if not data:
                continue
            raw = base64.b64decode(data)
            h = hashlib.sha1(raw).hexdigest()[:12]
            if not self.art or self.art[2] != h:
                self.art = (j.get("artworkMimeType") or "image/jpeg", raw, h)
                self.patch("media", self.media_view())

    async def media_loop(self):
        while True:
            if not os.path.exists(MEDIA_CONTROL):
                self.set_perm("media", False)
                log("media-control not found — brew install media-control")
                await asyncio.sleep(30)
                continue
            proc = await asyncio.create_subprocess_exec(
                MEDIA_CONTROL, "stream", "--no-diff", "--no-artwork", "--micros", stdout=PIPE, stderr=DEVNULL)
            self.set_perm("media", True)
            async for line in proc.stdout:
                self.on_media(line)
            await proc.wait()
            await asyncio.sleep(2)

    # ---- commands from the tablet
    async def command(self, msg):
        a, v = msg.get("a"), msg.get("v")
        simple = {"toggle": "toggle-play-pause", "play": "play", "pause": "pause",
                  "next": "next-track", "prev": "previous-track"}
        try:
            if a in simple:
                await run(MEDIA_CONTROL, simple[a])
            elif a == "seek":
                await run(MEDIA_CONTROL, "seek", "%.2f" % max(0.0, float(v)))
            elif a == "skip":
                m = self.media_view()
                if m:
                    await run(MEDIA_CONTROL, "seek", "%.2f" % max(0.0, m["elapsed"] + float(v)))
            elif a == "vol":
                self.set_volume(int(v))
            elif a == "mute":
                await run("osascript", "-e", "set volume output muted %s" % ("true" if v else "false"))
                await self.read_volume()
        except (TypeError, ValueError):
            pass

    # ---- system volume
    async def read_volume(self):
        out = await run("osascript", "-e", "set s to get volume settings",
                        "-e", 'return (output volume of s as text) & "," & (output muted of s as text)')
        try:
            level, muted = out.strip().split(",")
            vol = {"level": int(level), "muted": muted == "true"}
        except ValueError:
            return
        if vol != self.volume and time.time() > self.vol_quiet_until:
            self.volume = vol
            self.patch("volume", vol)

    async def volume_loop(self):
        while True:
            if not self.vol_busy:
                await self.read_volume()
            await asyncio.sleep(3)

    def set_volume(self, level):
        self.vol_target = max(0, min(100, level))
        self.volume = {"level": self.vol_target, "muted": False}
        self.vol_quiet_until = time.time() + 2
        if not self.vol_busy:
            asyncio.ensure_future(self._apply_volume())

    async def _apply_volume(self):
        self.vol_busy = True
        try:
            while self.vol_target is not None:  # coalesce: only ever apply the latest value
                v, self.vol_target = self.vol_target, None
                await run("osascript", "-e", "set volume output volume %d without output muted" % v)
        finally:
            self.vol_busy = False

    # ---- helper processes
    def on_events(self, line):
        if line == "k":
            self.broadcast({"t": "k"})
            return
        if line == "c":
            self.broadcast({"t": "c"})
            return
        try:
            m = json.loads(line)
        except ValueError:
            return
        t = m.get("t")
        if t == "app":
            self.front = {"name": m.get("name", ""), "bundle": m.get("bundle", "")}
            self.recompute_activity()
        elif t == "url":
            self.url = {"bundle": m.get("bundle", ""), "url": m.get("url", ""), "title": m.get("title", "")}
            self.set_perm("url", not m.get("err"))
            self.recompute_activity()
        elif t == "idle":
            if m["s"] != self.idle:
                self.idle = m["s"]
                self.patch("idle", self.idle)
        elif t == "cpu":
            self.sys["cpu"] = m["v"]
            self.patch("sys", self.sys)
        elif t == "batt":
            self.sys["batt"] = {"pct": m["pct"], "charging": m["charging"], "plugged": m["plugged"]}
            self.patch("sys", self.sys)
        elif t == "keys":
            self.set_perm("keys", bool(m.get("ok")))

    def on_audio(self, line):
        if line.startswith("A"):
            try:
                data = bytes.fromhex(line[1:])
            except ValueError:
                return
            for c in list(self.clients):
                c.binary(data)
            return
        try:
            m = json.loads(line)
        except ValueError:
            return
        if m.get("t") == "audio":
            self.set_perm("audio", bool(m.get("ok")))
            if not m.get("ok"):
                log("audio:", m.get("err"))

    def live_audio(self):
        # Live audio uses ScreenCaptureKit: it shows the "screen is being recorded" indicator and makes
        # DRM video (Netflix, Prime, Hotstar…) go black, so it is opt-in.
        return bool(self.config.get("liveAudio", False))

    async def helper_loop(self, mode, handler):
        backoff = 2
        while True:
            if mode == "audio" and not self.live_audio():
                self.set_perm("audio", None)
                await asyncio.sleep(2)
                continue
            if not os.path.exists(HELPER):
                log("helper missing — run helper/build.sh")
                await asyncio.sleep(30)
                continue
            started = time.time()
            proc = await asyncio.create_subprocess_exec(HELPER, mode, stdout=PIPE, stderr=DEVNULL)
            if mode == "audio":
                self.audio_proc = proc
            async for raw in proc.stdout:
                handler(raw.decode("utf-8", "replace").strip())
            await proc.wait()
            backoff = 2 if time.time() - started > 30 else min(backoff * 2, 60)
            await asyncio.sleep(backoff)

    async def calendar_loop(self):
        while True:
            ok = False
            if self.config.get("calendar", True) and os.path.exists(HELPER):
                out = await run(HELPER, "calendar", timeout=25)
                try:
                    m = json.loads(out.strip().splitlines()[-1]) if out.strip() else {}
                except ValueError:
                    m = {}
                ok = bool(m.get("ok"))
                self.set_perm("calendar", ok)
                if ok and m.get("events") != self.calendar:
                    self.calendar = m.get("events")
                    self.patch("calendar", self.calendar)
            await asyncio.sleep(300 if ok else 1800)

    # ---- HTTP / WS
    async def handle(self, reader, writer):
        sock = writer.get_extra_info("socket")
        if sock is not None:
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        try:
            head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 10)
            lines = head.decode("latin-1").split("\r\n")
            method, target, _ = lines[0].split(" ", 2)
        except (asyncio.IncompleteReadError, asyncio.LimitOverrunError, asyncio.TimeoutError,
                ConnectionError, ValueError):
            writer.close()
            return
        headers = {}
        for l in lines[1:]:
            if ":" in l:
                k, v = l.split(":", 1)
                headers[k.strip().lower()] = v.strip()
        parts = urlsplit(target)
        try:
            if parts.path == "/ws" and headers.get("upgrade", "").lower() == "websocket":
                await self.ws_session(reader, writer, headers)
            else:
                await self.http(method, parts.path, parse_qs(parts.query), headers, reader, writer)
        except (ConnectionError, asyncio.IncompleteReadError):
            pass
        finally:
            writer.close()

    async def respond(self, writer, status, body=b"", ctype="text/plain; charset=utf-8", extra=()):
        head = ["HTTP/1.1 " + status, "Content-Type: " + ctype, "Content-Length: %d" % len(body),
                "Connection: close"] + list(extra)
        writer.write(("\r\n".join(head) + "\r\n\r\n").encode() + body)
        await writer.drain()

    async def http(self, method, path, query, headers, reader, writer):
        if method == "POST" and headers.get("content-length"):
            await reader.readexactly(min(int(headers["content-length"]), 1 << 16))
        if path == "/api/event":
            e = (query.get("e") or [""])[0]
            if e in CLAUDE_STATES:
                self.claude = {"state": e, "since": now_ms()}
                self.patch("claude", self.claude)
            return await self.respond(writer, "200 OK", b"ok")
        if path == "/api/state":
            body = json.dumps(self.snapshot(), indent=2).encode()
            return await self.respond(writer, "200 OK", body, "application/json")
        if path.startswith("/art/"):
            if self.art and path[5:] == self.art[2]:
                return await self.respond(writer, "200 OK", self.art[1], self.art[0],
                                          ["Cache-Control: max-age=86400"])
            return await self.respond(writer, "404 Not Found", b"no art")
        rel = "index.html" if path in ("", "/") else path.lstrip("/")
        fs = os.path.normpath(os.path.join(WEB, rel))
        if not fs.startswith(WEB + os.sep) or not os.path.isfile(fs):
            return await self.respond(writer, "404 Not Found", b"not found")
        st = os.stat(fs)
        etag = '"%x-%x"' % (st.st_mtime_ns, st.st_size)
        if headers.get("if-none-match") == etag:
            return await self.respond(writer, "304 Not Modified", extra=["ETag: " + etag])
        with open(fs, "rb") as f:
            body = f.read()
        ctype = mimetypes.guess_type(fs)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype.endswith(("json", "javascript")):
            ctype += "; charset=utf-8"
        await self.respond(writer, "200 OK", body, ctype, ["ETag: " + etag, "Cache-Control: no-cache"])

    async def ws_session(self, reader, writer, headers):
        key = headers.get("sec-websocket-key", "").encode()
        accept = base64.b64encode(hashlib.sha1(key + WS_GUID).digest()).decode()
        writer.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                      "Sec-WebSocket-Accept: %s\r\n\r\n" % accept).encode())
        client = Client(writer)
        self.clients.add(client)
        peer = writer.get_extra_info("peername")
        log("tablet connected", peer[0] if peer else "?", "(%d open)" % len(self.clients))
        client.text({"t": "hello", "state": self.snapshot(), "now": now_ms()})
        try:
            while True:
                op, data = await ws_read(reader)
                if op == 8:
                    break
                if op == 9:
                    writer.write(ws_frame(10, data))
                    continue
                if op != 1:
                    continue
                try:
                    msg = json.loads(data)
                except ValueError:
                    continue
                t = msg.get("t")
                if t == "ping":
                    client.text({"t": "pong", "id": msg.get("id"), "now": now_ms()})
                elif t == "cmd":
                    asyncio.ensure_future(self.command(msg))
        finally:
            self.clients.discard(client)
            log("tablet disconnected (%d open)" % len(self.clients))


async def main():
    hub = Hub()
    hub.load_config()
    server = await asyncio.start_server(hub.handle, "0.0.0.0", PORT)
    for coro in (hub.media_loop(), hub.helper_loop("events", hub.on_events),
                 hub.helper_loop("audio", hub.on_audio), hub.calendar_loop(),
                 hub.volume_loop(), hub.config_loop()):
        asyncio.ensure_future(coro)
    log("Command Center running → open  http://%s:%d  on the tablet" % (lan_ip(), PORT))
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
