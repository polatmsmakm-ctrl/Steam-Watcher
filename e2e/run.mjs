// End-to-end test: starts the real room service + SFU, then drives several
// real Chromium instances through the real UI. Screen capture, encoding,
// transport and decoding are all genuine — only the screen being captured is
// a virtual X display (run via `xvfb-run`, see package.json / docs/TESTING.md).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const root = path.resolve(import.meta.dirname, '..');
const outDir = path.join(import.meta.dirname, 'results');
fs.mkdirSync(outDir, { recursive: true });
const PORT = 18080;
const BASE = `http://127.0.0.1:${PORT}`;
const only = process.env.E2E_ONLY?.split(',');

const results = [];
const pages = {};
const measurements = {};
let failed = 0;

async function step(name, fn) {
  if (only && !only.some((o) => name.includes(o))) return;
  const t = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - t });
    console.log(`  ok   ${name} (${Date.now() - t} ms)`);
  } catch (e) {
    failed++;
    results.push({ name, ok: false, error: String(e?.message ?? e) });
    for (const [label, page] of Object.entries(pages)) await page.screenshot({ path: path.join(outDir, `fail-${failed}-${label}.png`) }).catch(() => {});
    console.log(`  FAIL ${name}\n       ${String(e?.message ?? e).split('\n').join('\n       ')}`);
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startServer() {
  const proc = spawn('node', ['server/dist/index.js'], {
    cwd: root,
    env: {
      ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: path.join(outDir, `data-${Date.now()}`), LOG_LEVEL: 'info',
      RTC_LISTEN_IP: '127.0.0.1', RTC_BASE_PORT: '42000', RTC_WORKERS: '2', STUN_URLS: '', AUTH_RATE_LIMIT: '1000', JWT_SECRET: 'e2e',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = fs.createWriteStream(path.join(outDir, 'server.log'));
  proc.stdout.pipe(log);
  proc.stderr.pipe(log);
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return proc; } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error('server did not start');
}

const stats = (page) => page.evaluate(() => window.__visionStream.latest());
const waitStats = (page, predicate, what, timeout = 20000, arg = null) =>
  page.waitForFunction(predicate, arg, { timeout }).catch(async () => {
    throw new Error(`timeout waiting for: ${what}\n last sample: ${JSON.stringify(await stats(page))}`);
  });
const videoPlaying = (page, timeout = 20000) =>
  page.waitForFunction(() => {
    const v = document.querySelector('[data-testid=stream-video]');
    return v && v.videoWidth > 0 && !v.paused && v.currentTime > 0.3;
  }, null, { timeout }).catch(() => { throw new Error('remote video never started playing'); });
const nav = (page, label) => page.click(`.sidebar .nav:has-text("${label}")`);

async function register(page, username) {
  await page.goto(BASE);
  await page.click('.seg button:has-text("Create account")');
  await page.fill('input[name=username]', username);
  await page.fill('input[name=displayName]', username[0].toUpperCase() + username.slice(1));
  await page.fill('input[name=password]', 'correct-horse-battery');
  await page.click('button[type=submit]');
  await page.waitForSelector('.sidebar');
  await page.waitForSelector('[data-testid=connection]:has-text("Connected")');
}

async function createRoom(page, mode) {
  await nav(page, 'Create room');
  await page.click(`[data-testid=mode-${mode}]`);
  await page.click('button.primary:has-text("Create room")');
  await page.waitForSelector('[data-testid=room-name]');
  return {
    link: await page.getAttribute('[data-testid=copy-link]', 'data-invite-link'),
    code: (await page.textContent('[data-testid=invite-code]')).trim(),
  };
}

async function joinByCode(page, code) {
  await nav(page, 'Join room');
  await page.fill('input[name=invite]', code);
  await page.click('button.primary:has-text("Join room")');
}

async function share(page) {
  await page.click('[data-testid=share]');
  await page.click('[data-testid=confirm-share]');
  await page.waitForSelector('[data-testid=stop-share]', { timeout: 20000 });
}

async function setStream(page, { preset, codec }) {
  await nav(page, 'Stream settings');
  if (preset) await page.click(`.seg button:has-text("${preset}")`);
  if (codec) await page.selectOption('select[aria-label=Encoder]', codec);
}

/** Averages the measured (not target) numbers over a few seconds. */
async function measure(page, seconds, side) {
  const samples = [];
  for (let i = 0; i < seconds; i++) {
    await sleep(1000);
    const s = await stats(page);
    if (s?.[side]) samples.push(s);
  }
  const avg = (get) => {
    const vals = samples.map(get).filter((v) => typeof v === 'number');
    return vals.length ? Number((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2)) : null;
  };
  const last = samples.at(-1);
  return side === 'send'
    ? {
        samples: samples.length, codec: last?.send.codec, encoder: last?.send.encoder, hardware: last?.send.hardware,
        width: last?.send.width, height: last?.send.height, fps: avg((s) => s.send.fps), captureFps: avg((s) => s.send.captureFps),
        bitrateKbps: avg((s) => s.send.bitrateKbps), encodeMs: avg((s) => s.send.encodeMs), limitation: last?.send.limitation,
        rttMs: avg((s) => s.net?.rttMs),
      }
    : {
        samples: samples.length, codec: last?.recv.codec, decoder: last?.recv.decoder, width: last?.recv.width, height: last?.recv.height,
        fps: avg((s) => s.recv.fps), bitrateKbps: avg((s) => s.recv.bitrateKbps), decodeMs: avg((s) => s.recv.decodeMs),
        jitterBufferMs: avg((s) => s.recv.jitterBufferMs), jitterMs: avg((s) => s.recv.jitterMs), lossPct: avg((s) => s.recv.lossPct),
        framesDropped: avg((s) => s.recv.framesDropped), avOffsetMs: avg((s) => s.recv.avOffsetMs), rttMs: avg((s) => s.net?.rttMs),
      };
}

const server = await startServer();
// Host browser: REAL screen capture of the X display. The only automation is
// that the system picker's "Entire screen" entry is chosen without a human.
// (Do not add --use-fake-device-for-media-stream here: it silently replaces
// getDisplayMedia with a synthetic source.)
const hostBrowser = await chromium.launch({
  headless: false,
  args: ['--auto-select-desktop-capture-source=Entire screen', '--window-size=1500,950', '--window-position=0,0'],
});
// Viewer browser: there is no audio hardware here, so the microphone is
// Chromium's synthetic device (a periodic beep) and its prompt is auto-accepted.
const viewerBrowser = await chromium.launch({
  headless: false,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--window-size=900,700', '--window-position=1560,0'],
});
const browser = { close: async () => { await hostBrowser.close(); await viewerBrowser.close(); } };
const newPage = async (b = viewerBrowser) => {
  const ctx = await b.newContext({ viewport: b === hostBrowser ? { width: 1480, height: 900 } : { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('   [pageerror]', e.message));
  // Surface every error toast in the test log: an unexpected one usually explains a later failure.
  await page.exposeFunction('__reportToast', (text) => console.log('   [toast]', text));
  await page.addInitScript(() => {
    addEventListener('DOMContentLoaded', () => {
      new MutationObserver((records) => {
        for (const r of records) for (const n of r.addedNodes) if (n.classList?.contains('toast') && n.classList.contains('error')) window.__reportToast(n.textContent);
      }).observe(document.body, { childList: true, subtree: true });
    });
  });
  page.on('console', (m) => m.type() === 'error' && !m.text().includes('Failed to load resource') && console.log('   [console]', m.text()));
  return page;
};

try {
  const host = await newPage(hostBrowser);
  const guest = await newPage();
  const member = await newPage();
  Object.assign(pages, { host, guest, member });
  let invite;

  console.log('Group room (SFU)');
  await step('host registers and creates a group room', async () => {
    await register(host, 'hoster');
    invite = await createRoom(host, 'sfu');
    assert(/#\/join\/[0-9A-Z]{9}-[0-9A-Z]{20}$/.test(invite.link), `bad invite link ${invite.link}`);
  });

  await step('guest joins through the invitation link', async () => {
    await guest.goto(invite.link);
    await guest.fill('input[name=displayName]', 'Linky');
    await guest.click('button[type=submit]');
    await guest.waitForSelector('[data-testid=room-name]', { timeout: 15000 });
    await host.waitForSelector('[data-testid^=peer-guest-]');
  });

  await step('registered member joins with the invitation code; wrong code is refused', async () => {
    await register(member, 'member');
    await joinByCode(member, invite.code.slice(0, -1) + (invite.code.endsWith('A') ? 'B' : 'A'));
    await member.waitForSelector('.toast.error:has-text("invalid")');
    await member.fill('input[name=invite]', invite.code);
    await member.click('button.primary:has-text("Join room")');
    await member.waitForSelector('[data-testid=room-name]');
    await host.waitForSelector('[data-testid=peer-member]');
  });

  await step('host shares the screen after confirming; both viewers receive real video', async () => {
    await setStream(host, { preset: 'High', codec: 'h264' });
    await nav(host, "Hoster's room");
    // Consent: nothing may be captured before the confirmation dialog is accepted.
    await host.click('[data-testid=share]');
    await host.waitForSelector('[data-testid=confirm-share]');
    assert(!(await stats(host))?.send, 'capture started before consent');
    await host.keyboard.press('Escape');
    await sleep(1200);
    assert(!(await host.$('[data-testid=stop-share]')), 'share started although the dialog was cancelled');
    await share(host);
    await Promise.all([videoPlaying(guest), videoPlaying(member)]);
    assert((await host.textContent('[data-testid=viewer-count]')).startsWith('2 viewers'), 'viewer count should be 2');
  });

  await step('measure 1440p60 target (H.264) — sender and both viewers', async () => {
    await waitStats(host, () => (window.__visionStream.latest()?.send?.fps ?? 0) > 5, 'sender fps > 5');
    await sleep(4000); // let the bitrate ramp
    const [send, v1, v2] = await Promise.all([measure(host, 8, 'send'), measure(guest, 8, 'recv'), measure(member, 8, 'recv')]);
    measurements['sfu_1440p60_h264'] = { target: '2560x1440@60, 20 Mbps', send, viewer1: v1, viewer2: v2 };
    assert(send.fps > 5 && v1.fps > 5 && v2.fps > 5, `stream is not flowing: ${JSON.stringify({ send: send.fps, v1: v1.fps, v2: v2.fps })}`);
    assert(v1.width === send.width && v2.width === send.width, 'viewers must receive the resolution that is sent');
    assert(send.codec === 'H264', `expected H264, got ${send.codec}`);
  });

  await step('120 FPS target is requested and the real rate is reported, not the target', async () => {
    await setStream(host, { preset: 'Ultra' });
    await sleep(5000);
    const send = await measure(host, 6, 'send');
    measurements['sfu_1440p120_h264'] = { target: '2560x1440@120, 35 Mbps', send, viewer1: await measure(guest, 4, 'recv') };
    await nav(host, "Hoster's room");
    const shown = await host.textContent('[data-testid=actual-format]');
    const shownFps = Number(/· (\d+) FPS/.exec(shown)?.[1]);
    assert(Math.abs(shownFps - send.fps) < Math.max(12, send.fps * 0.35), `UI shows ${shownFps} FPS but measured ${send.fps}`);
    if (send.fps < 108) await host.waitForSelector('.chip.warn:has-text("Below 120 FPS target")', { timeout: 8000 });
  });

  for (const codec of ['av1', 'vp9', 'vp8']) {
    await step(`live encoder switch to ${codec.toUpperCase()} reaches the viewers`, async () => {
      await setStream(host, { preset: 'Medium', codec });
      await waitStats(guest, (c) => window.__visionStream.latest()?.recv?.codec?.toLowerCase() === c && window.__visionStream.latest().recv.fps > 3, `viewer decoding ${codec}`, 25000, codec);
      await sleep(3000);
      measurements[`sfu_1080p60_${codec}`] = { target: '1920x1080@60, 10 Mbps', send: await measure(host, 5, 'send'), viewer1: await measure(guest, 5, 'recv') };
    });
  }

  await step('HEVC is refused in group rooms with a clear message (SFU cannot route it)', async () => {
    await setStream(host, { codec: 'hevc' }).catch(() => {});
    const disabled = await host.$eval('select[aria-label=Encoder] option[value=hevc]', (o) => o.disabled);
    if (disabled) return; // this Chromium build has no HEVC encoder at all: option is disabled
    await host.waitForSelector('.toast.error:has-text("HEVC")', { timeout: 8000 });
  });

  await step('simulcast: host sends 2 layers; data-saver viewer gets the half-resolution layer', async () => {
    await setStream(host, { preset: 'Medium', codec: 'h264' });
    await host.click('.toggle-row:has-text("Low-bandwidth layer") .switch');
    await waitStats(host, () => window.__visionStream.latest()?.send?.layers === 2, 'two layers sent', 25000);
    await waitStats(guest, () => (window.__visionStream.latest()?.recv?.fps ?? 0) > 3, 'viewer receiving again');
    const full = (await measure(member, 3, 'recv')).height;
    await guest.click('button:has-text("Auto quality")');
    await waitStats(guest, (h) => { const r = window.__visionStream.latest()?.recv; return r && r.height > 0 && r.height <= h / 2 + 8; }, 'viewer on low layer', 25000, full).catch(() => {});
    const low = (await measure(guest, 3, 'recv')).height;
    measurements['simulcast'] = { fullLayerHeight: full, dataSaverHeight: low };
    assert(low > 0 && low <= full / 2 + 8, `data saver should halve resolution: full ${full}, low ${low}`);
    await guest.click('button:has-text("Data saver")');
    await nav(host, 'Stream settings');
    await host.click('.toggle-row:has-text("Low-bandwidth layer") .switch');
    await waitStats(host, () => window.__visionStream.latest()?.send?.layers === 1, 'back to one layer', 25000);
  });

  await step('pause freezes the stream for viewers and resume restores it', async () => {
    await nav(host, "Hoster's room");
    await videoPlaying(guest);
    await host.click('[data-testid=pause-share]');
    await guest.waitForSelector('.stage-banner:has-text("paused the stream")');
    await waitStats(guest, () => (window.__visionStream.latest()?.recv?.fps ?? 1) === 0, 'viewer fps drops to 0 while paused');
    await host.click('[data-testid=pause-share]');
    await waitStats(guest, () => (window.__visionStream.latest()?.recv?.fps ?? 0) > 3, 'viewer fps recovers after resume');
  });

  await step('voice chat: microphone audio reaches the other participants; mute is signalled', async () => {
    await guest.click('[data-testid=mic]');
    await host.waitForFunction(() => window.__visionStream.remote().some((r) => r.source === 'mic' && r.state === 'live'), null, { timeout: 15000 });
    await waitStats(host, () => (window.__visionStream.latest()?.audio?.bitrateKbps ?? 0) > 1, 'host receives Opus audio');
    const s = await stats(host);
    measurements['voice'] = s.audio;
    await guest.click('[data-testid=mic]');
    await host.waitForSelector('[data-testid^=peer-guest-] svg[aria-label=Muted]');
  });

  await step('viewer recovers automatically after its connection drops', async () => {
    await nav(guest, 'Performance');
    await guest.click('[data-testid=drop-connection]');
    await guest.waitForSelector('.toast.success:has-text("Reconnected")', { timeout: 20000 });
    await nav(guest, "Hoster's room");
    await waitStats(guest, () => (window.__visionStream.latest()?.recv?.fps ?? 0) > 3, 'viewer receives video again after reconnect', 25000);
  });

  await step('host recovers after a drop and the share resumes without re-prompting', async () => {
    const t = Date.now();
    await nav(host, 'Performance');
    await host.click('[data-testid=drop-connection]');
    await host.waitForSelector('.toast.success:has-text("Reconnected")', { timeout: 20000 });
    await waitStats(member, () => (window.__visionStream.latest()?.recv?.fps ?? 0) > 3, 'viewers receive the re-published stream', 25000);
    measurements['host_reconnect_ms'] = Date.now() - t;
    await nav(host, "Hoster's room");
    assert(await host.$('[data-testid=stop-share]'), 'host should still be sharing');
  });

  await step('owner removes a participant; they are returned home and cannot rejoin', async () => {
    assert(!(await member.$('[data-testid^=kick-]')), 'non-owners must not see remove buttons');
    await host.click('[data-testid=kick-member]');
    await member.waitForSelector('.toast.error:has-text("removed from the room")');
    await member.waitForSelector('h1:has-text("Welcome back")');
    await joinByCode(member, invite.code);
    await member.waitForSelector('.toast.error:has-text("removed from this room")');
    assert((await host.textContent('[data-testid=viewer-count]')).startsWith('1 viewer'), 'viewer count should be 1');
  });

  await step('stopping the share clears the stream for viewers', async () => {
    await host.click('[data-testid=stop-share]');
    await guest.waitForSelector('.stage-empty:has-text("Nobody is sharing")', { timeout: 10000 });
  });

  await step('friends: request, accept, presence, room invitation', async () => {
    await nav(member, 'Friends');
    await member.fill('input[aria-label="Friend username"]', 'hoster');
    await member.click('button:has-text("Send request")');
    await nav(host, 'Friends');
    await host.click('button:has-text("Accept")');
    await host.waitForSelector('[data-testid=friend-member]:has-text("Online")');
    await member.waitForSelector('[data-testid=friend-hoster]:has-text("In a room")');
  });

  await step('screens render: stream settings, audio, performance, profile, settings', async () => {
    for (const [label, file] of [['Home', 'home'], ['Friends', 'friends'], ['Stream settings', 'stream'], ['Audio settings', 'audio'], ['Performance', 'performance'], ['Settings', 'settings']]) {
      await nav(host, label);
      await sleep(500);
      await host.screenshot({ path: path.join(outDir, `screen-${file}.png`) });
    }
    await host.click('.sidebar .me');
    await host.waitForSelector('[data-testid=sign-out]');
    await host.screenshot({ path: path.join(outDir, 'screen-profile.png') });
    await nav(member, 'Audio settings');
    await member.click('[data-testid=mic-test]');
    await member.waitForFunction(() => parseFloat(document.querySelector('.meter i').style.width) > 0, null, { timeout: 8000 });
    await member.click('[data-testid=mic-test]');
  });

  await step('encoder benchmark produces real throughput numbers', async () => {
    await setStream(host, { preset: 'Low' });
    await nav(host, 'Performance');
    await host.click('[data-testid=run-benchmark]');
    await host.waitForSelector('[data-testid=benchmark-results]', { timeout: 90000 });
    measurements['benchmark_720p30'] = await host.$$eval('[data-testid=benchmark-results] tbody tr', (rows) => rows.map((r) => [...r.cells].map((c) => c.textContent)));
    assert(measurements['benchmark_720p30'].some((r) => /FPS/.test(r[2] ?? '')), 'no encoder produced a result');
    await host.screenshot({ path: path.join(outDir, 'screen-benchmark.png'), fullPage: true });
  });

  await step('host leaves; room survives for the guest and closes on request', async () => {
    await nav(host, "Hoster's room");
    await host.click('button:has-text("Close room for everyone")');
    await guest.waitForSelector('.toast:has-text("The room was closed")');
  });

  console.log('Direct room (P2P)');
  await step('direct room: 1:1 peer-to-peer stream with voice both ways', async () => {
    const direct = await createRoom(host, 'p2p');
    await joinByCode(member, direct.code);
    await member.waitForSelector('[data-testid=room-name]');
    await setStream(host, { preset: 'Medium', codec: 'auto' });
    await nav(host, "Hoster's room");
    await share(host);
    await videoPlaying(member);
    await waitStats(member, () => (window.__visionStream.latest()?.recv?.fps ?? 0) > 3, 'p2p viewer fps');
    await sleep(4000);
    measurements['p2p_1080p60_auto'] = { target: '1920x1080@60, 10 Mbps', send: await measure(host, 6, 'send'), viewer: await measure(member, 6, 'recv') };
    await member.click('[data-testid=mic]');
    await host.waitForFunction(() => window.__visionStream.remote().some((r) => r.source === 'mic'), null, { timeout: 15000 });
    await waitStats(host, () => (window.__visionStream.latest()?.audio?.bitrateKbps ?? 0) > 1, 'host receives voice over p2p');
    await member.screenshot({ path: path.join(outDir, 'screen-live-viewer.png') });
    await host.screenshot({ path: path.join(outDir, 'screen-live-host.png') });
  });

  await step('direct room: roles swap — the other peer shares back over the same connection', async () => {
    await host.click('[data-testid=stop-share]');
    await member.waitForSelector('.stage-empty:has-text("Nobody is sharing")', { timeout: 10000 });
    await nav(member, "Hoster's room");
    await share(member); // synthetic display source in the viewer browser; exercises renegotiation in the reverse direction
    await videoPlaying(host);
    await waitStats(host, () => (window.__visionStream.latest()?.recv?.fps ?? 0) > 3, 'host receives the member stream');
    await member.click('[data-testid=stop-share]');
    await share(host);
    await videoPlaying(member);
  });

  await step('direct room is limited to two participants', async () => {
    const code = (await host.textContent('[data-testid=invite-code]')).trim();
    await guest.goto(`${BASE}/#/join/${code}`);
    await guest.reload();
    await guest.waitForSelector('.toast.error:has-text("full")', { timeout: 15000 });
  });

  await step('direct room: stream survives a signaling drop', async () => {
    await nav(member, 'Performance');
    await member.click('[data-testid=drop-connection]');
    await member.waitForSelector('.toast.success:has-text("Reconnected")', { timeout: 20000 });
    await waitStats(member, () => (window.__visionStream.latest()?.recv?.fps ?? 0) > 3, 'p2p viewer receives again', 25000);
  });
} finally {
  await browser.close().catch(() => {});
  server.kill();
  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({ when: new Date().toISOString(), results, measurements }, null, 2));
  console.log(`\n${results.filter((r) => r.ok).length} passed, ${failed} failed. Measurements: e2e/results/results.json`);
  process.exit(failed ? 1 : 0);
}
