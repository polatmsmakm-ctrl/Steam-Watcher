import { DownloadCloud, PlugZap, RotateCcw } from 'lucide-react';
import { useEffect, useState } from 'react';
import * as api from '../lib/api.ts';
import { appVersion, isTauri, openExternal } from '../lib/platform.ts';
import { session } from '../session.ts';
import { DEFAULT_SETTINGS, useApp, type LatencyMode } from '../store.ts';
import { Field, Segmented, ToggleRow, useAction } from '../ui.tsx';

const UPDATE_REPO = (import.meta.env.VITE_UPDATE_REPO as string | undefined) ?? 'polatmsmakm-ctrl/Steam-Watcher';

/** 1 if a > b, -1 if a < b, comparing dotted numeric versions. */
function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

export function AppSettingsView() {
  const settings = useApp((s) => s.settings);
  const update = useApp((s) => s.updateSettings);
  const inRoom = useApp((s) => Boolean(s.room));
  const [serverUrl, setServerUrl] = useState(settings.serverUrl);
  const [version, setVersion] = useState('');
  const [updateInfo, setUpdateInfo] = useState<{ text: string; url?: string } | null>(null);
  const [busy, run] = useAction();

  useEffect(() => void appVersion().then(setVersion), []);

  const testServer = () => run(async () => {
    const h = await api.health(serverUrl).catch(() => {
      throw new Error(`No VISION STREAM server answered at ${serverUrl}`);
    });
    if (!h.ok) throw new Error('Server reported a problem');
  }, 'Server is reachable');

  const applyServer = () => run(async () => {
    await api.health(serverUrl).catch(() => {
      throw new Error(`No VISION STREAM server answered at ${serverUrl}`);
    });
    update({ serverUrl });
    session.signOut(); // accounts belong to a server
  }, 'Server changed — sign in again');

  const checkUpdates = () => run(async () => {
    const res = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, { headers: { accept: 'application/vnd.github+json' } }).catch(() => null);
    if (!res) throw new Error('Could not reach the update server');
    if (res.status === 404) return setUpdateInfo({ text: 'No published releases were found.' });
    if (!res.ok) throw new Error(`Update check failed (${res.status})`);
    const release = (await res.json()) as { tag_name: string; html_url: string };
    setUpdateInfo(compareVersions(release.tag_name, version) > 0
      ? { text: `Version ${release.tag_name.replace(/^v/, '')} is available.`, url: release.html_url }
      : { text: `You are up to date (${version}).` });
  });

  return (
    <div className="page">
      <div className="page-head"><div><h1>Settings</h1><p>Application preferences</p></div></div>
      <div className="stack">
        <div className="card stack">
          <div><h2>Server</h2><p className="muted small">Rooms, friends and accounts live on this server. Changing it signs you out.</p></div>
          <Field label="Server address">
            <input className="input mono" value={serverUrl} onChange={(e) => setServerUrl(e.target.value.trim())} aria-label="Server address" />
          </Field>
          <div className="row">
            <button className="btn" disabled={busy || !serverUrl} onClick={testServer}><PlugZap /> Test connection</button>
            <button className="btn primary" disabled={busy || !serverUrl || serverUrl === settings.serverUrl} onClick={applyServer}>Apply and sign out</button>
          </div>
          {serverUrl.startsWith('http://') && !/\/\/(localhost|127\.|192\.168\.|10\.)/.test(serverUrl) && (
            <div className="notice"><PlugZap /><span>This address is not HTTPS. Your password and room signaling would travel unencrypted — use an https:// address outside your own network.</span></div>
          )}
        </div>

        <div className="card">
          <h2>Playback and privacy</h2>
          <p>How incoming streams are buffered and routed</p>
          <Field label="Latency mode" hint="Ultra-low plays frames as soon as they arrive; Smooth adds a 150 ms buffer that hides network jitter.">
            <Segmented<LatencyMode> label="Latency mode" value={settings.app.latencyMode}
              onChange={(latencyMode) => { update({ app: { latencyMode } }); setTimeout(() => session.applyLatencyMode()); }}
              options={[{ value: 'ultra', label: 'Ultra-low latency' }, { value: 'balanced', label: 'Balanced' }, { value: 'smooth', label: 'Smooth' }]} />
          </Field>
          <div style={{ marginTop: 12 }}>
            <ToggleRow title="Statistics overlay" hint="Show live numbers on top of the stream" on={settings.app.statsOverlay} onChange={(statsOverlay) => update({ app: { statsOverlay } })} />
            <ToggleRow title="Relay-only connections" hint="Route all media through the server's TURN relay so other participants never see your IP address. Adds latency; needs a TURN server. Applies to the next room you join."
              on={settings.app.relayOnly} onChange={(relayOnly) => update({ app: { relayOnly } })} />
            <ToggleRow title="Reduce motion" hint="Turn off interface animations" on={settings.app.reducedMotion} onChange={(reducedMotion) => update({ app: { reducedMotion } })} />
          </div>
        </div>

        <div className="card stack">
          <div><h2>About</h2><p className="muted small">VISION STREAM {version} · {isTauri ? 'Desktop app' : 'Web client'}</p></div>
          <div className="row wrap">
            <button className="btn" disabled={busy} onClick={checkUpdates} data-testid="check-updates"><DownloadCloud /> Check for updates</button>
            {updateInfo && <span className="muted">{updateInfo.text}</span>}
            {updateInfo?.url && <button className="btn primary sm" onClick={() => void openExternal(updateInfo.url!)}>Download</button>}
          </div>
          <div>
            <button className="btn ghost" disabled={inRoom} title={inRoom ? 'Leave the room first' : undefined}
              onClick={() => { update({ stream: DEFAULT_SETTINGS.stream, audio: DEFAULT_SETTINGS.audio, app: DEFAULT_SETTINGS.app }); }}>
              <RotateCcw /> Reset streaming, audio and playback settings
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
