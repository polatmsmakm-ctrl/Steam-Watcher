# Testing and measured results

## Running the tests

```bash
npm run typecheck     # TypeScript, server + client
npm test              # 13 server integration tests (real HTTP/WebSocket, real mediasoup worker, in-memory DB)
npm run build
npm run test:e2e      # 27 end-to-end scenarios
(cd app/src-tauri && cargo check)                                   # desktop shell
(cd app/src-tauri && cargo check --target x86_64-pc-windows-msvc)   # Windows type-check from Linux
```

`npm run test:e2e` needs Playwright with Chromium, `xvfb-run`, and optionally `coturn` (the two TURN scenarios are
skipped without it). It starts the built server and three browser processes on a virtual 2560×1440 display:

- **Host browser** — performs a *real* screen capture of that display. The only automation is that the system
  picker's "Entire screen" entry is selected automatically.
- **Viewer browser** — two viewers. There is no audio hardware in the test machine, so its microphone is Chromium's
  synthetic device.
- **Motion window** — a canvas animation, so the captured desktop contains continuous motion to encode.

Results and screenshots are written to `e2e/results/`.

### What the end-to-end suite verifies

| Area | Scenarios |
|---|---|
| Rooms | create group room; guest joins by link; member joins by code; wrong code refused; owner removes a participant, who is sent home and cannot rejoin; room close; direct room limited to 2 |
| Consent | nothing is captured before the confirmation dialog is accepted; cancelling does not start a share |
| Streaming | two viewers receive the stream at the resolution sent; 120 FPS target requested and the *measured* rate shown; live switch between H.264, AV1, VP9, VP8; HEVC refused in group rooms with an explanation; simulcast low layer and viewer "data saver"; pause/resume; stop |
| Audio | voice reaches other participants (Opus); mute state shown; audio/video offset measured |
| Resilience | viewer reconnects after a dropped connection; host reconnects and the share resumes without a new prompt; direct room survives a signaling drop; roles swap in a direct room |
| Network | TURN relay path for direct rooms and for SFU viewers, with time-limited credentials against a real coturn |
| UI | every screen renders; friends request/accept/presence; microphone test meter; encoder benchmark |

## Measured results in the build environment

Environment: Linux VM, **4 vCPUs, no GPU**, software encoders only (OpenH264, libaom, libvpx), loopback network,
with the server, three Chromium processes and the encoder all sharing those 4 cores. These numbers show that the
pipeline works and that reporting is truthful; **they are not representative of a gaming PC with NVENC.**

| Scenario (target) | Sent | Encoder | FPS sent | Encode ms/frame | Bitrate | Viewer FPS | Viewer decode ms | Jitter buffer | Loss |
|---|---|---|---|---|---|---|---|---|---|
| Group, 1440p60 / 20 Mbps, H.264, 2 viewers | 2560×1440 | OpenH264 (software) | 34 | 25.4 | 6.2 Mbps | 34 / 34 | 7.8 | 17 ms | 0 % |
| Group, **1440p120** / 35 Mbps, H.264 | 2560×1440 | OpenH264 (software) | **44** | 18.1 | 6.3 Mbps | 46 | 4.7 | 9 ms | 0 % |
| Group, 1080p60 / 10 Mbps, AV1 | 1920×1080 | libaom (software) | 34 | 24.7 | 5.0 Mbps | 31 | 9.9 | 23 ms | 0 % |
| Group, 1080p60 / 10 Mbps, VP9 | 1920×1080 | libvpx (software) | 32 | 21.9 | 9.0 Mbps | 31 | 15.3 | 12 ms | 0 % |
| Group, 1080p60 / 10 Mbps, VP8 | 1920×1080 | libvpx (software) | 23 | 42.0 | 5.5 Mbps | 24 | 11.0 | 37 ms | 0 % |
| Direct (P2P), 1080p60 / 10 Mbps, Auto→H.264 | 1920×1080 | OpenH264 (software) | 40 | 11.9 | 8.5 Mbps | 45 | 3.5 | 13 ms | 0 % |
| Direct via TURN relay, 1080p60 | 1920×1080 | OpenH264 (software) | – | – | 9.0 Mbps recv | 45 | 3.5 | 18 ms | 0 % |

Other measurements from the same run:

- **120 FPS:** capture delivered ~47 FPS and the encoder ~44 FPS. The app displayed the measured rate and the
  "Below 120 FPS target" warning. 120 FPS was **not achieved** here and nothing in the app claimed otherwise.
- **Simulcast:** full layer 1080p, data-saver viewer received 540p.
- **Host reconnection:** 2.6 s from a forced signaling drop until viewers received the re-published stream.
- **Audio/video offset:** +31 ms (video ahead), measured on a synthetic source with audio.
- **Voice:** ~30 kbps Opus, 0 % loss, 0 % concealment.
- **Encoder benchmark (720p30 target, software only):** H.264 116 FPS, VP9 83 FPS, AV1 72 FPS, VP8 51 FPS;
  no hardware encoder found, HEVC unavailable — reported as such.
- **Round-trip time** on loopback was 0–8 ms; this says nothing about internet latency.

Rows vary by ±15 % between runs because everything competes for the same four cores.

## Not covered here — validate on real hardware

None of the following could be exercised in the build environment. Each has a concrete check.

| # | Item | How to check | Pass looks like |
|---|---|---|---|
| 1 | Installer | Download the `vision-stream-windows-installer` artifact from the CI run, install on Windows 10/11 | App starts, sign-in screen appears |
| 2 | Screen picker in WebView2 | Share screen → confirm | Windows/WebView2 picker lists screens and windows; preview appears after choosing |
| 3 | Monitor / window selection | Pick a second monitor, then a single window | The chosen surface is what viewers see; label on the stage matches |
| 4 | NVENC is used | Share at High, open *Stream settings* | "Active encoder" names a platform encoder (on Windows typically containing `MediaFoundation`) rather than OpenH264/libaom/libvpx, and "Hardware accelerated: Yes"; *Performance* shows NVENC utilisation > 0 |
| 5 | AV1 / HEVC | *Stream settings* table; RTX 40-series for AV1 encode | Hardware badge for the codec; Auto selects it; viewers decode it |
| 6 | 1440p60 | High preset on a 1440p display | FPS sent ≈ 60, encode < 16 ms, limitation "none" |
| 7 | 1440p120 | Ultra preset on a ≥120 Hz display with a game running | FPS captured and sent ≈ 120, encode < 8 ms. If lower, the app says so — record the real number |
| 8 | Encoder benchmark | *Performance → Run benchmark* at Ultra | Hardware rows show ≥ 120 FPS "Sustained" |
| 9 | System audio + lip-sync | Share with system audio, play a video | Viewers hear it; "Audio / video offset" within ±80 ms |
| 10 | Two PCs over the internet | Deploy the server, connect from two networks | Stream plays; RTT, loss and jitter are plausible for the link |
| 11 | TURN on a restrictive network | Join from a network that blocks UDP, or enable *Relay-only* | "TURN relay: Yes" and the stream plays |
| 12 | Long-duration stability | 2-hour stream, then *Performance → CSV* | No upward drift in app memory, dropped frames or A/V offset |
| 13 | Multi-viewer load | 10+ viewers in a group room | Sender upload unchanged; server CPU per worker (`/api/health`) below one core |
| 14 | Microphone processing | Voice chat with speakers on | No echo; noise suppression audible when toggled |

Known risk if item 2 fails: Tauri would need a small permission handler for WebView2's screen-capture request;
the capture code itself would not change.
