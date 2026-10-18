# Architecture

andro-bot is three small programs talking over two pipes: a **Swift sensor helper** feeds a
**Python hub** over stdout, and the hub keeps **one WebSocket per tablet** open and pushes state the
moment it changes. The tablet is a plain web app, so any browser on the LAN can be a display.

```
┌──────────────────────────── Mac ─────────────────────────────┐            ┌──────── Tablet (browser) ────────┐
│                                                              │            │                                  │
│  bin/cc-helper events ──┐  JSON lines: app, url, idle,       │            │  app.js   state · views · touch  │
│   NSWorkspace, AppleScript, CGEventTap, host_statistics, IOPS │            │    ├─ bot.js  robot (canvas)     │
│                         │                                    │  WebSocket │    ├─ viz.js  equalizer (canvas) │
│  bin/cc-helper audio  ──┼──► server.py (asyncio hub) ◄──────────────────────►  └─ clock / weather / media UI  │
│   ScreenCaptureKit → FFT│      state · rules · commands      │  JSON +    │                                  │
│   "A<hex>" ~47 fps      │      static files · /art · /api    │  binary    │  Open-Meteo (weather, AQI) ──►   │
│                         │                                    │            │  fetched directly by the tablet  │
│  bin/cc-helper calendar ┘  (one shot, every 5 min)            │            └──────────────────────────────────┘
│                                                              │
│  media-control stream ───► now playing (title, artwork, position)          GET /api/event?e=…  ◄── Claude Code hooks
│  media-control <cmd>  ◄─── play/pause/seek/next              │                                    (or any tool)
│  osascript            ◄──► system volume                     │
└──────────────────────────────────────────────────────────────┘
```

## Components

### `helper/main.swift` → `bin/cc-helper`
One binary, three modes, each writing one line per event to stdout:

| Mode | Source | Output |
|---|---|---|
| `events` | `NSWorkspace` activation notifications (instant app switches), `NSAppleScript` reading the browser's active tab every 0.5 s, `CGEventSource` idle time, a listen-only `CGEventTap` (key/click *counts* only), `host_statistics` CPU, IOKit battery | JSON lines; bare `k` / `c` for a key press / click |
| `audio` (opt-in: `liveAudio`) | `ScreenCaptureKit` system-audio capture → mono → Hann window → 2048-point FFT (Accelerate) → 40 log-spaced bands with tilt, auto-gain and a bass-onset beat detector | `A<hex>`: `[level, beat, band0…band39]` |
| `calendar` | EventKit, next 36 h | one JSON line, then exit |

Native code lives here because these APIs (audio capture, event taps, workspace notifications) aren't
reachable from Python's standard library, and putting them in a separate process means a missing
permission or crash in one sensor never takes the hub down.

### `server.py`: the hub (Python standard library only)
- **asyncio** HTTP server + a hand-rolled minimal **WebSocket** implementation; `TCP_NODELAY` on every socket.
- Supervises `cc-helper events`, `cc-helper audio` and `media-control stream`, restarting each with backoff.
- Holds the single source of truth: `media`, `activity`, `sys`, `idle`, `perm`, `volume`, `claude`, `calendar`, `config`.
- **Rules engine:** front app + active-tab URL → `activity.scene` using the ordered rules in `config.json` (hot-reloaded).
- **Commands** from tablets (`toggle`, `seek`, `skip`, `vol`, …) map to `media-control` / `osascript`; volume writes are coalesced so dragging a slider never queues up.
- Serves `web/`, the current artwork at `/art/<hash>`, and `/api/event` + `/api/state`.

### `web/`: the tablet app
- `app.js`: connection (auto-reconnect, 2 s ping for latency + clock-offset), state, auto view
  selection, banner, clock, weather, calendar, media controls, gestures. One `requestAnimationFrame` loop.
- `bot.js`: the robot. Every visual parameter (eye shape, lids, smile, blush, colour, arm angles,
  head bob, placement) is a damped **spring**; moods and scenes only set spring *targets*, so every
  transition blends smoothly. Scene props (surfboard + waves, headband, 3D glasses + popcorn,
  laptop, headphones, bubbles) fade in by per-scene presence springs. Plain Canvas 2D, no blur or
  shadows, for budget tablet GPUs.
- `viz.js`: equalizer. Fast-attack/slow-release smoothing, falling peak caps, three styles; a
  synthetic groove stands in when no live audio arrives.

## Wire protocol

All tablet ↔ hub traffic is one WebSocket at `/ws`.

| Direction | Message |
|---|---|
| hub → tablet | `{"t":"hello","state":{…},"now":<ms>}` on connect |
| hub → tablet | `{"t":"patch","k":"media","v":{…}}`, sent whenever any one key changes |
| hub → tablet | `{"t":"k"}` key press, `{"t":"c"}` click |
| hub → tablet | binary frame: `[level, beat, 40 × band]` (uint8), ~47/s |
| tablet → hub | `{"t":"cmd","a":"toggle"\|"prev"\|"next"\|"seek"\|"skip"\|"vol"\|"mute","v":…}` |
| tablet ↔ hub | `{"t":"ping","id":n}` → `{"t":"pong","id":n,"now":<ms>}` |

Media position is sent as "elapsed at send time" and extrapolated on the tablet, so the progress
bar moves smoothly without per-second updates.

## Latency design

- Push, never poll: state changes are forwarded as they happen (app switches are OS notifications,
  now-playing is a stream).
- Touch handlers fire on `pointerdown` and update the UI **optimistically**; the hub's echo confirms.
- Spectrum frames are droppable: if a tablet's socket buffer backs up, frames are skipped rather than queued.
- Hub processing overhead is ~0.1 ms per message; end-to-end latency is dominated by Wi‑Fi (typically 3–15 ms).

## View selection (Auto mode)

```
media playing (or paused < 25 s)  → Media view   (bot shrinks to a corner, wears the scene's props)
idle ≥ sleep threshold            → Clock view   (bot sleeps in the corner)
otherwise                         → Bot view     (full-size scene)
```

## Extending

- **New site/app reaction:** add a rule to `config.json` pointing at an existing scene.
- **New scene:** add an entry to `SCENES` (+ optional mood in `MOODS`) and its props/emitters in
  `bot.js`, then a banner case in `renderBanner()` and a background layer in `style.css`.
- **New signal:** emit a JSON line from `cc-helper`, handle it in `Hub.on_events`, `patch()` it to tablets.
- **Other platforms:** only `cc-helper` and the `media-control` / `osascript` calls are macOS-specific;
  the hub protocol and web app are portable.
