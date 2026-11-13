# Setup, configuration and deployment

## 1. Components

| Component | What it is | Where it runs |
|---|---|---|
| Room service | `server/` — HTTP API, WebSocket signaling, mediasoup SFU, serves the web client | A Linux server with a public IP |
| Desktop app | `app/` + `app/src-tauri/` — Tauri 2 shell around the React client | Windows 10/11 PCs |
| Web client | The same React client, served by the room service | Any Chromium-based browser (viewers) |
| TURN relay | coturn | Same server or another host |

You and your friends all point the app at the same room service.

## 2. Development machine

- Node.js 22 or newer (the server uses the built-in `node:sqlite`).
- `npm install` at the repository root (npm workspaces). mediasoup downloads a prebuilt worker binary during install;
  if none exists for your platform it compiles one and needs Python 3 and a C++ toolchain.
- Desktop app only: Rust stable; on Windows the MSVC build tools and WebView2 (preinstalled on Windows 10 21H2+ and 11);
  on Linux `libwebkit2gtk-4.1-dev` and friends (Linux builds are for compiling the shell only — WebKitGTK lacks the
  WebRTC features the app needs, so use a Chromium browser there).

```bash
npm run dev:server      # server with reload on :8080
npm run dev:app         # web client with hot reload on :5173 (talks to :8080)
npm run tauri dev       # desktop app
```

## 3. Server configuration

All settings are environment variables.

| Variable | Default | Purpose |
|---|---|---|
| `HOST` / `PORT` | `0.0.0.0` / `8080` | HTTP + WebSocket listener |
| `PUBLIC_URL` | derived from the request | Base of invitation links, e.g. `https://stream.example.com` |
| `DATA_DIR` | `./data` | SQLite database and the generated token secret |
| `JWT_SECRET` | generated into `DATA_DIR/jwt.secret` | Token signing key; set it explicitly to keep sessions across re-deploys |
| `TOKEN_TTL_SEC` | `2592000` (30 days) | Session lifetime |
| `ALLOW_GUESTS` | `true` | Allow joining by invite without an account |
| `AUTH_RATE_LIMIT` | `10` | Auth requests per IP per minute |
| `TLS_CERT` / `TLS_KEY` | – | Serve HTTPS directly (otherwise put a TLS reverse proxy in front) |
| `WEB_DIR` | `app/dist` | Built web client to serve |
| `MAX_ROOM_PARTICIPANTS` | `50` | Cap for group rooms |
| `EMPTY_ROOM_TTL_SEC` | `120` | How long an empty room is kept for reconnects |
| `RTC_ANNOUNCED_ADDRESS` | – | **Public IP or DNS name** clients use to reach the SFU. Required behind NAT / in the cloud |
| `RTC_LISTEN_IP` | `0.0.0.0` | Local bind address for media |
| `RTC_BASE_PORT` | `40000` | First media port; worker *i* uses `RTC_BASE_PORT + i` on UDP **and** TCP |
| `RTC_WORKERS` | CPU cores, max 4 | mediasoup workers (one room runs on one worker) |
| `RTC_MAX_INCOMING_BITRATE` | `100000000` | Ceiling per sharer, bits/s |
| `RTC_INITIAL_OUTGOING_BITRATE` | `6000000` | Starting estimate towards each viewer |
| `STUN_URLS` | `stun:stun.l.google.com:19302` | Comma-separated; used by Direct rooms |
| `TURN_URLS` | – | Comma-separated `turn:` / `turns:` URLs |
| `TURN_SECRET` | – | coturn `static-auth-secret`; enables time-limited TURN credentials |
| `TURN_TTL_SEC` | `21600` | Lifetime of issued TURN credentials |
| `LOG_LEVEL` | `info` | `silent`, `info` |

Firewall: open TCP 443 (or your HTTP port), UDP+TCP `RTC_BASE_PORT … RTC_BASE_PORT+RTC_WORKERS-1`, and for coturn
UDP/TCP 3478 plus its relay port range.

## 4. Production deployment

### With Docker Compose (service + Caddy HTTPS + coturn)

```bash
cd deploy
cp .env.example .env      # set DOMAIN, PUBLIC_IP, TURN_SECRET
docker compose up -d --build
```

The stack uses host networking (Linux). Caddy obtains a certificate for `DOMAIN` and proxies HTTPS/WSS to the service.
Note: this stack has been written carefully but **has not been run end to end** — verify it on your server before relying on it.

### Without Docker

```bash
npm ci && npm run build
PUBLIC_URL=https://stream.example.com RTC_ANNOUNCED_ADDRESS=203.0.113.10 \
TURN_URLS=turn:stream.example.com:3478 TURN_SECRET=… node server/dist/index.js
```

Put nginx/Caddy in front for TLS (WebSocket upgrade on `/ws` must be proxied), or set `TLS_CERT`/`TLS_KEY`.
Browsers only allow screen capture and microphones on HTTPS origins (or `localhost`), so TLS is not optional for the web client.

coturn (the configuration the test suite runs against, plus an external IP):

```
listening-port=3478
external-ip=203.0.113.10
realm=stream.example.com
use-auth-secret
static-auth-secret=<same value as TURN_SECRET>
```

Back up `DATA_DIR` (accounts, friendships, token secret).

## 5. Desktop app

### Pointing the app at your server

The server address is on the sign-in screen (*Server*) and under *Settings → Server*. To ship builds preconfigured,
build with `VITE_DEFAULT_SERVER=https://stream.example.com`.

### Building the installer

On Windows:

```bash
npm ci --workspace app
npm run tauri --workspace app -- build
```

Output: `app/src-tauri/target/release/bundle/nsis/VISION STREAM_<version>_x64-setup.exe` — a per-user NSIS installer
that downloads the WebView2 runtime if the PC lacks it.

CI does the same on every push (`windows-installer` job) and uploads the installer as a workflow artifact.

The installer is **not code-signed**; Windows SmartScreen will warn on first run until you sign it with your own
certificate (`bundle.windows.certificateThumbprint` / `signCommand` in `tauri.conf.json`).

### Releases and updates

1. Bump `version` in `app/package.json`, `app/src-tauri/tauri.conf.json` and `app/src-tauri/Cargo.toml`.
2. Tag and push: `git tag v0.2.0 && git push origin v0.2.0`. CI builds the installer and attaches it to a GitHub release.
3. In the app, *Settings → Check for updates* compares the running version with the latest GitHub release of
   `VITE_UPDATE_REPO` (default: this repository) and opens the download page when a newer one exists.

This is an update *check* with a manual download. Silent in-place updating (Tauri's updater plugin) needs a signing
key pair that only you should hold, so it is not wired in; `tauri signer generate` and `plugins.updater` in
`tauri.conf.json` are the next step if you want it. The check needs the repository's releases to be publicly readable.

### What the desktop app adds over the browser client

- CPU / RAM / GPU / NVENC utilisation on the Performance screen (through `sysinfo` and NVML).
- WebView2 launch flags that enable HEVC over WebRTC and allow streams to resume with sound after a reconnect.
- A window, taskbar presence and installer.

## 6. Using the app

1. Create an account (or continue as guest when you were sent a link).
2. *Create room* → choose **Group** (many viewers, via the server) or **Direct** (one viewer, peer-to-peer).
3. Send the invitation code or link; friends on your list can be invited with one click.
4. *Share screen* → confirm → pick the screen or window in the system picker.
5. *Stream settings* changes resolution, frame rate, bitrate and encoder live; *Performance* shows what is really achieved.

Recommended starting points on an NVIDIA GPU: **High** (1440p60, 20 Mbps). Move to **Ultra** (1440p120, 35 Mbps) only
if the Performance screen shows encode time under ~8 ms per frame and "captured" FPS near 120 — which also requires
the shared display to run at 120 Hz or more.
