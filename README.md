# VISION STREAM

Low-latency screen sharing for friends: a Windows desktop app (Tauri 2 + React), a room/signaling server with a
built-in SFU (Node.js + mediasoup), and a web client that lets invited viewers join from a browser.

- Share a screen or a window at up to 1440p / 120 FPS **targets**, with AV1 / HEVC / H.264 (plus VP9 / VP8) and
  hardware encoding when the PC has it — the app always shows the resolution, frame rate and encoder it is *actually* achieving.
- Private rooms with invitation codes and links, owner controls (lock, remove, rotate invite, close), friends and presence.
- Group rooms through an SFU (one upload, any number of viewers) and Direct 1:1 rooms peer-to-peer.
- Voice chat (Opus, echo cancellation, noise suppression), per-person volume, system-audio sharing with lip-sync.
- Automatic recovery from network drops, STUN/TURN, optional relay-only mode.
- A Performance dashboard with live measured statistics, CSV/JSON export and an on-device encoder benchmark.

## Status — read this first

This was built and tested in a **Linux container with no GPU and no Windows machine**. What that means:

| Area | State |
|---|---|
| Room service, signaling, auth, friends, rooms | **Tested** — 13 integration tests |
| SFU + P2P streaming, codec switching, simulcast, pause, voice, reconnection, kick/ban, TURN relay | **Tested** end to end with real Chromium instances capturing a real (virtual) display — 27 scenarios |
| All 10 screens and their controls | **Tested** through the UI in the web client (same code the desktop app loads) |
| Desktop shell (Rust) | **Compiles** for Linux and type-checks for `x86_64-pc-windows-msvc`; **never run on Windows** |
| Windows installer (NSIS) | Built by GitHub Actions (`.github/workflows/ci.yml`); **not installed or run by a human yet** |
| Windows Graphics Capture, NVENC, hardware AV1/HEVC, system-audio capture on Windows | **Not verified** — they are provided by WebView2 and can only be confirmed on a Windows PC with an NVIDIA GPU |
| 1440p at 120 FPS | **Not demonstrated.** The test VM (4 vCPU, software encoders) reached ~44 FPS at 1440p; the app reported exactly that |
| Docker image / compose stack | Written; image build could not complete in the sandbox (no registry access from the build container) |
| Two physical computers over the internet | **Not tested** — all tests ran on one machine over loopback |

`docs/TESTING.md` has the measured numbers and a checklist for validating the unverified items on real hardware.

## Quick start (development)

Requirements: Node.js 22+. For the desktop app also Rust (stable) and, on Windows, the "Desktop development with C++" build tools.

```bash
npm install
npm run build            # web client + server bundle
npm start                # server on http://localhost:8080 (serves the web client too)
```

Open http://localhost:8080 in two Chromium-based browser profiles, create an account in each, create a room in one
and paste the invitation into the other.

Desktop app (on Windows):

```bash
npm run dev:server       # terminal 1
npm run tauri dev        # terminal 2
npm run tauri build      # produces app/src-tauri/target/release/bundle/nsis/VISION STREAM_0.1.0_x64-setup.exe
```

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — design, technology evaluation, security model, limits
- [`docs/SETUP.md`](docs/SETUP.md) — installation, configuration reference, production deployment, releases and updates
- [`docs/TESTING.md`](docs/TESTING.md) — how to run the tests, measured results, hardware validation checklist

## Tests

```bash
npm run typecheck
npm test                 # server integration tests
npm run test:e2e         # needs Chromium + Playwright, Xvfb; coturn optional (relay scenarios)
```
