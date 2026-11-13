# VISION STREAM — Architecture

This document records what was built, why each technology was chosen, and where the limits are.
Statements about behaviour are backed by tests in this repository unless marked **not verified**.

## 1. System overview

```
┌──────────────────────────── Windows PC (sharer) ───────────────────────────┐
│  VISION STREAM desktop app (Tauri 2)                                        │
│  ┌──────────────── WebView2 (Chromium) ─────────────────┐  ┌─────────────┐ │
│  │ React + TypeScript UI                                │  │ Rust shell  │ │
│  │ getDisplayMedia ─► Windows Graphics Capture          │  │ sysinfo     │ │
│  │ WebRTC encoder  ─► Media Foundation ─► NVENC / QSV…  │◄─┤ NVML (GPU,  │ │
│  │ Opus, AEC/NS/AGC, congestion control, jitter buffers │  │ NVENC load) │ │
│  └───────────────┬──────────────────────┬───────────────┘  └─────────────┘ │
└──────────────────┼──────────────────────┼──────────────────────────────────┘
        WSS (JSON RPC)            DTLS-SRTP media (UDP, TCP fallback)
                   │                      │
┌──────────────────▼──────────────────────▼─────────────────┐
│ Room service (Node.js 22, one process)                    │      ┌────────┐
│  HTTP API: accounts (scrypt + HS256 tokens), health       │      │ coturn │
│  WebSocket signaling: rooms, invites, friends, presence   │      │ STUN / │
│  mediasoup SFU: N workers, 1 UDP+TCP port per worker      │      │ TURN   │
│  SQLite (node:sqlite): users, friendships                 │      └────────┘
│  Static hosting of the web client (invite links)          │
└──────────────────┬────────────────────────────────────────┘
                   │ one forwarded copy per viewer
        ┌──────────▼─────────┐   ┌────────────────────┐
        │ Viewer (desktop)   │   │ Viewer (browser)   │   … up to MAX_ROOM_PARTICIPANTS
        └────────────────────┘   └────────────────────┘
```

Two room types share one signaling protocol (`shared/protocol.ts`):

| | Group room (`sfu`) | Direct room (`p2p`) |
|---|---|---|
| Media path | sharer → SFU → each viewer | sharer ↔ viewer, one `RTCPeerConnection` |
| Sharer upload | **one** stream regardless of viewer count (+20 % with the optional low layer) | one stream |
| Participants | up to 50 (configurable) | 2 |
| Video codecs | AV1, H.264, VP9, VP8 | everything both ends support, **including HEVC** |
| NAT traversal | SFU has a public address; TURN for UDP-blocked clients | STUN, TURN fallback |

## 2. Technology decisions

### Desktop shell: Tauri 2 (chosen) vs C#/.NET

| Criterion | Tauri 2 + WebView2 | C# / .NET (WinUI/WPF) |
|---|---|---|
| Screen capture | Chromium's capturer (Windows Graphics Capture) via `getDisplayMedia` | `Windows.Graphics.Capture` API directly |
| Hardware encode | Chromium's Media Foundation encoders → NVENC / AMF / QuickSync | NVENC SDK through native interop — must be written and maintained |
| WebRTC | Built in: congestion control, FEC/NACK, jitter buffer, AEC, Opus | No production-grade managed stack with hardware encode; requires wrapping native libwebrtc |
| UI | React + TypeScript (as requested) | XAML; React would need a WebView anyway |
| Other platforms | Same code runs in any Chromium browser today (viewers can join from a link) | Windows only |
| Installer size | ~5–10 MB (WebView2 ships with Windows 10/11) | Larger, bundles runtime |

**Decision: Tauri.** The dominant risk in this product is the real-time media stack, and WebView2 already contains a
mature one with hardware encoders wired in. A .NET app would have to rebuild that stack (libwebrtc interop, NVENC
session management, bitrate adaptation) before reaching feature parity.

**The trade-off, stated plainly:** the app does not drive Windows Graphics Capture or the NVENC SDK itself — WebView2
does. The app *chooses* the codec, resolution, frame rate, bitrate and degradation policy, and *reports* which encoder
is really in use (`encoderImplementation` / `powerEfficientEncoder` from WebRTC stats, plus NVENC load from NVML).
It cannot force a specific encoder session, tune NVENC presets, or keep frames on the GPU beyond what Chromium does
(Chromium passes capture textures to hardware encoders zero-copy when both sides support it, otherwise it maps them).
If measurements on target hardware show this is the bottleneck, the Rust side is the place for a native
WGC → D3D11 texture → NVENC pipeline feeding WebRTC as pre-encoded frames; that is a substantial follow-up project,
not part of this delivery.

### SFU: mediasoup (chosen) vs LiveKit

| Criterion | mediasoup 3.32 | LiveKit |
|---|---|---|
| Form | Node.js library — embeds in the room service | Separate Go server + its own protocol/SDKs |
| Control | Full control of rooms, auth, signaling | Rooms/auth via LiveKit tokens and server API |
| Codecs | AV1, H.264, VP9, VP8 — **no H.265** (verified against the installed version) | Advertises H.265 support in recent versions |
| Simulcast / layers | Yes | Yes (plus dynacast, adaptive stream) |
| Built-in TURN | No (coturn alongside) | Yes |
| Verified here | Yes — runs in the test suite | No — could not be run in the build environment |

**Decision: mediasoup**, because it could be integrated and tested end-to-end in the same process as the room
service. The cost is HEVC in group rooms; that gap is covered by Direct rooms, where no SFU is involved. If group HEVC
becomes a requirement, `MediaTransport` (`app/src/media/transport.ts`) is the seam: a LiveKit-backed implementation
can be added without touching the UI or the session logic.

### Why "Auto" does not always pick AV1

Software AV1/HEVC encoding cannot hold 1440p at high frame rates. *Auto* therefore probes for hardware encoders at
the selected resolution and frame rate (WebCodecs `isConfigSupported` with `prefer-hardware`) and picks
AV1 → HEVC → H.264 among codecs that have one; with no hardware encoder it uses H.264 software.
On an RTX 40-series (AV1 NVENC) that yields AV1; on older NVIDIA cards, HEVC in Direct rooms or H.264 in Group rooms.

## 3. Media pipeline

**Capture.** `getDisplayMedia` with `width/height/frameRate` as `ideal`+`max` constraints. Chromium accepts up to
120 fps for display capture; the source is downscaled when larger than the target and never upscaled. Capture cannot
start without the system picker, which is the platform's own consent step; the app adds its own confirmation before
that (see §5).

**Encode.** One encoder per share. Optional second half-resolution 30 fps layer (H.264/VP8, Group rooms) for viewers
on slow links. `degradationPreference` selects what gives way under CPU or bandwidth pressure
(`maintain-framerate` = dynamic resolution, the default for motion).

**Transport.** WebRTC with transport-wide congestion control. Start bitrate is raised to 60 % of the target
(`x-google-start-bitrate`) so streams do not begin at 300 kbps. All media is DTLS-SRTP encrypted.

**Fan-out.** The SFU forwards RTP; it never decodes, transcodes or stores media. Viewers that cannot keep up are
moved to the low layer automatically (when enabled) or can pin it themselves ("Data saver").

**Playback.** Screen video and system audio are placed in one stream so the browser lip-syncs them.
`jitterBufferTarget` implements the latency modes (0 ms / adaptive / 150 ms). Hardware decode is used when
available and reported (`powerEfficientDecoder`).

**Recovery.** Media path drop → ICE restart (keeps DTLS state). Signaling drop → exponential-backoff reconnect,
re-authenticate, rejoin the room and re-publish the tracks that are still live — the sharer is not asked to pick a
screen again. If a live encoder change is rejected, the previous encoder setup is restored.

## 4. Measurement

Everything on the Performance screen comes from `RTCPeerConnection.getStats()` (per-second deltas), from the OS
(`sysinfo`) or from NVML. Nothing is simulated; a metric that is unavailable shows "—". The UI always displays the
*measured* resolution and frame rate on the stream, and flags when the frame rate is below 90 % of the target.

| Metric | Source |
|---|---|
| FPS sent / captured / received | `framesEncoded`, media-source `frames`, `framesDecoded` |
| Encode / decode time | `totalEncodeTime / framesEncoded`, `totalDecodeTime / framesDecoded` |
| Bitrate | `bytesSent` / `bytesReceived` |
| Network latency | ICE candidate-pair `currentRoundTripTime` |
| Packet loss, jitter | `packetsLost`, `jitter`, remote-inbound reports |
| Dropped frames | `framesDropped`; sender: captured − encoded |
| Encoder / decoder, hardware or not | `encoderImplementation`, `powerEfficientEncoder` (and decoder equivalents) |
| Audio/video offset | difference of `estimatedPlayoutTimestamp` between the video and its audio |
| CPU, RAM, app memory | `sysinfo` (desktop app) |
| GPU load, NVENC load, VRAM, temperature | NVML (desktop app, NVIDIA only) |

The encoder benchmark pushes synthetic moving frames through each platform encoder with WebCodecs at the selected
format and reports true throughput — a direct answer to "can this PC encode 1440p120?".

## 5. Security and privacy

- **Consent.** Sharing needs (1) a click, (2) the in-app confirmation naming the room and audience, (3) the system
  picker. The session code has a single entry point for capture and it is only reachable from that dialog. A test
  asserts that nothing is captured when the dialog is cancelled.
- **Accounts.** Passwords hashed with scrypt (N=16384, per-user salt). Sessions are HS256 tokens; the signing secret is
  generated on first start and stored with mode 0600. Login timing does not reveal whether a username exists.
  Auth endpoints are rate limited per IP.
- **Rooms.** A room is reachable only with its invitation: 9-character room id + 20-character secret (≈100 bits),
  compared in constant time. "No such room" and "wrong secret" are indistinguishable. Owners can lock the room,
  rotate the invitation, remove participants (removed users are banned from that room) and close the room.
  Invitation links carry the secret in the URL fragment, which browsers do not send to servers.
- **Transport.** Media is always DTLS-SRTP. Signaling and the API must be served over HTTPS/WSS in production
  (reverse proxy or `TLS_CERT`/`TLS_KEY`); the app warns when a non-local `http://` server is configured.
- **Server-side media.** Group rooms terminate SRTP at the SFU (it needs RTP headers to route), so the server operator
  could technically access media. It is never written to disk. Direct rooms are end-to-end between the two PCs.
  End-to-end encryption through the SFU (insertable streams) is **not implemented**.
- **IP privacy.** Direct rooms reveal each peer's IP address to the other, as any P2P connection does. "Relay-only
  connections" forces all media through TURN.
- **TURN.** Credentials are per-user, time-limited HMACs (coturn `use-auth-secret`), never a shared static password.
- **Desktop shell.** A Content-Security-Policy restricts scripts to the bundled app; the only native command exposed
  to the page is `system_metrics`.

## 6. Scaling and limits

- A room lives on one mediasoup worker (one CPU core). Forwarding a 20–35 Mbps stream to tens of viewers is well
  within one core; hundreds of viewers per room would need `pipeToRouter` across workers — not implemented.
- Server egress is `viewers × stream bitrate`. Ten viewers of a 35 Mbps Ultra stream need 350 Mbps of uplink.
- Rooms, presence and invitations are in memory: a server restart closes all rooms (accounts and friends persist),
  and the service is single-instance.
- Friends are username-based; there is no account recovery or e-mail verification.

## 7. Repository layout

```
shared/protocol.ts      wire protocol types (server + client)
server/                 room service, signaling, SFU, tests
app/src/                React client: lib/ (signaling, platform), media/ (capture, transports, stats, benchmark),
                        session.ts (orchestration), store.ts (state), views/ (10 screens)
app/src-tauri/          Tauri shell (Rust): system + GPU metrics, window, installer config
e2e/                    end-to-end tests driving real Chromium instances
deploy/                 Dockerfile, docker-compose (service + Caddy + coturn)
.github/workflows/      CI: tests on Linux, NSIS installer on Windows
```
