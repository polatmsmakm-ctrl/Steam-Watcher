import {
  Activity, Copy, Crown, Link2, Lock, LogOut, Maximize, Mic, MicOff, MonitorOff, MonitorUp, Pause, Play, RefreshCw, Send, ShieldAlert, UserX,
  Volume2, VolumeX, XCircle,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { PeerInfo } from '../../../shared/protocol.ts';
import { session } from '../session.ts';
import { CODEC_LABEL } from '../media/codecs.ts';
import { resolutionLabel } from '../media/presets.ts';
import type { SurfacePreference } from '../media/capture.ts';
import { useApp } from '../store.ts';
import { Avatar, copyText, fmt, fmtMbps, Modal, Segmented, Switch, ToggleRow, useAction } from '../ui.tsx';

function StreamVideo({ video, audio, muted, volume, sinkId }: { video: MediaStreamTrack; audio?: MediaStreamTrack; muted: boolean; volume: number; sinkId: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current!;
    // One MediaStream for picture + sound: the browser keeps them lip-synced.
    el.srcObject = new MediaStream(audio ? [video, audio] : [video]);
    el.play().catch(() => {});
    return () => void (el.srcObject = null);
  }, [video, audio]);
  useEffect(() => {
    const el = ref.current!;
    el.muted = muted;
    el.volume = volume;
  }, [muted, volume]);
  useEffect(() => {
    const el = ref.current as (HTMLVideoElement & { setSinkId?: (id: string) => Promise<void> }) | null;
    el?.setSinkId?.(sinkId).catch(() => {});
  }, [sinkId]);
  return <video ref={ref} autoPlay playsInline data-testid="stream-video" />;
}

function VoiceAudio({ track, volume, sinkId }: { track: MediaStreamTrack; volume: number; sinkId: string }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const el = ref.current!;
    el.srcObject = new MediaStream([track]);
    el.play().catch(() => {});
    return () => void (el.srcObject = null);
  }, [track]);
  useEffect(() => void (ref.current!.volume = Math.min(1, Math.max(0, volume))), [volume]);
  useEffect(() => {
    const el = ref.current as (HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }) | null;
    el?.setSinkId?.(sinkId).catch(() => {});
  }, [sinkId]);
  return <audio ref={ref} autoPlay />;
}

/** Plays everyone's microphone. Mounted for the whole session so voice continues on every screen. */
export function RoomAudio() {
  const remote = useApp((s) => s.remote);
  const room = useApp((s) => s.room);
  const audio = useApp((s) => s.settings.audio);
  const peerVolume = useApp((s) => s.peerVolume);
  return (
    <>
      {remote.filter((r) => r.source === 'mic').map((r) => {
        const userId = room?.info.peers.find((p) => p.peerId === r.peerId)?.user.id ?? '';
        return <VoiceAudio key={r.id} track={r.track} sinkId={audio.speakerId} volume={audio.voiceVolume * (peerVolume[userId] ?? 1)} />;
      })}
    </>
  );
}

export function LiveView() {
  const room = useApp((s) => s.room)!;
  const localScreen = useApp((s) => s.localScreen);
  const remote = useApp((s) => s.remote);
  const mic = useApp((s) => s.mic);
  const settings = useApp((s) => s.settings);
  const updateSettings = useApp((s) => s.updateSettings);
  const reconnecting = useApp((s) => s.reconnecting);
  const ice = useApp((s) => s.ice);
  const decodeError = useApp((s) => s.decodeError);
  const latest = useApp((s) => s.latest);
  const [confirmShare, setConfirmShare] = useState(false);
  const [lowQuality, setLowQuality] = useState(false);
  const [busy, run] = useAction();
  const stage = useRef<HTMLDivElement>(null);

  const { info } = room;
  const me = info.peers.find((p) => p.peerId === room.peerId);
  const isOwner = Boolean(me?.isOwner);
  const sharer = info.peers.find((p) => p.publications.some((pub) => pub.source === 'screen'));
  const sharerPaused = sharer?.publications.find((pub) => pub.source === 'screen')?.paused ?? false;
  const remoteVideo = remote.find((r) => r.source === 'screen');
  const remoteAudio = remote.find((r) => r.source === 'screen-audio');
  const viewers = info.peers.length - (sharer ? 1 : 0);
  const someoneElseSharing = Boolean(sharer && sharer.peerId !== room.peerId);
  const live = localScreen ? latest?.send : latest?.recv;
  const mediaDown = ice === 'disconnected' || ice === 'failed';

  return (
    <div className="room">
      <div className="stage-wrap">
        <div className="room-head">
          <h2 data-testid="room-name">{info.name}</h2>
          <span className="chip">{info.mode === 'sfu' ? 'Group · SFU' : 'Direct · P2P'}</span>
          {info.locked && <span className="chip warn"><Lock /> Locked</span>}
          <span className="chip" data-testid="viewer-count">{viewers} viewer{viewers === 1 ? '' : 's'}</span>
          <span className="grow" />
          <span className={`chip ${reconnecting || mediaDown ? 'warn' : ice === 'connected' ? 'good' : ''}`} data-testid="media-state">
            {reconnecting ? 'Reconnecting…' : mediaDown ? 'Media interrupted — recovering' : ice === 'connected' ? 'Media connected' : ice === 'connecting' ? 'Connecting media…' : 'Idle'}
          </span>
        </div>

        <div className="stage" ref={stage}>
          {localScreen ? (
            <>
              <StreamVideo video={localScreen.track} muted volume={0} sinkId="" />
              <div className="stage-banner">
                <i className="live-dot" style={{ margin: 0, animationPlayState: localScreen.paused ? 'paused' : 'running' }} />
                {localScreen.paused ? 'Paused — viewers see a frozen frame' : `You are sharing: ${localScreen.surface}`}
              </div>
            </>
          ) : remoteVideo ? (
            <>
              <StreamVideo video={remoteVideo.track} audio={remoteAudio?.track} muted={settings.audio.streamMuted} volume={settings.audio.streamVolume} sinkId={settings.audio.speakerId} />
              {sharerPaused && <div className="stage-banner"><Pause size={14} /> {sharer?.user.displayName} paused the stream</div>}
            </>
          ) : decodeError ? (
            <div className="stage-empty"><ShieldAlert /><h2>Cannot play this stream</h2><p>{decodeError} Ask the host to switch encoder to H.264.</p></div>
          ) : someoneElseSharing ? (
            <div className="stage-empty"><MonitorUp /><h2>Connecting to {sharer!.user.displayName}’s stream…</h2></div>
          ) : (
            <div className="stage-empty">
              <MonitorUp />
              <h2>Nobody is sharing yet</h2>
              <p>Share your screen, or wait for someone else to start.</p>
              <button className="btn primary lg" style={{ marginTop: 16 }} onClick={() => setConfirmShare(true)} disabled={reconnecting}><MonitorUp /> Share screen</button>
            </div>
          )}
          {live && live.width > 0 && (
            <div className="stage-tag">
              <span className="chip mono" data-testid="actual-format">{live.width}×{live.height} · {fmt(live.fps)} FPS</span>
              <span className="chip mono">{live.codec || '…'}</span>
              {localScreen && latest?.send && latest.send.fps > 0 && latest.send.fps < settings.stream.fps * 0.9 && (
                <span className="chip warn" title="Measured frame rate is below the selected target">Below {settings.stream.fps} FPS target</span>
              )}
            </div>
          )}
          {settings.app.statsOverlay && latest && <StatsOverlay />}
        </div>

        <div className="controls">
          {localScreen ? (
            <>
              <button className="btn danger" disabled={busy} onClick={() => run(() => session.stopShare())} data-testid="stop-share"><MonitorOff /> Stop sharing</button>
              <button className="btn" disabled={busy} onClick={() => run(() => session.setSharePaused(!localScreen.paused))} data-testid="pause-share">
                {localScreen.paused ? <><Play /> Resume</> : <><Pause /> Pause</>}
              </button>
            </>
          ) : (
            <button className="btn primary" disabled={busy || reconnecting || someoneElseSharing} title={someoneElseSharing ? `${sharer!.user.displayName} is sharing` : undefined} onClick={() => setConfirmShare(true)} data-testid="share">
              <MonitorUp /> Share screen
            </button>
          )}
          <span className="sep" />
          <button className={`btn ${mic.active && !mic.muted ? 'on' : ''}`} disabled={busy || reconnecting} onClick={() => run(() => session.toggleMic())} data-testid="mic" aria-pressed={mic.active && !mic.muted}>
            {mic.active && !mic.muted ? <><Mic /> Mic on</> : <><MicOff /> {mic.active ? 'Muted' : 'Join voice'}</>}
          </button>
          {mic.active && <button className="btn ghost sm" disabled={busy} onClick={() => run(() => session.disableMic())}>Leave voice</button>}
          {!localScreen && (
            <>
              <span className="sep" />
              <button className="btn icon" aria-label={settings.audio.streamMuted ? 'Unmute stream audio' : 'Mute stream audio'} onClick={() => updateSettings({ audio: { streamMuted: !settings.audio.streamMuted } })}>
                {settings.audio.streamMuted ? <VolumeX /> : <Volume2 />}
              </button>
              <input className="vol" type="range" min={0} max={1} step={0.02} value={settings.audio.streamMuted ? 0 : settings.audio.streamVolume} aria-label="Stream volume"
                onChange={(e) => updateSettings({ audio: { streamVolume: Number(e.target.value), streamMuted: false } })} />
              {info.mode === 'sfu' && remoteVideo && (
                <button className={`btn sm ${lowQuality ? 'on' : ''}`} title="Ask the server for the low-bandwidth layer (when the host enabled it)"
                  onClick={() => run(async () => { await session.setViewerQuality(lowQuality ? 'auto' : 'low'); setLowQuality(!lowQuality); })}>
                  {lowQuality ? 'Data saver' : 'Auto quality'}
                </button>
              )}
            </>
          )}
          <span className="sep" />
          <button className={`btn icon ${settings.app.statsOverlay ? 'on' : ''}`} aria-label="Toggle statistics overlay" onClick={() => updateSettings({ app: { statsOverlay: !settings.app.statsOverlay } })}><Activity /></button>
          <button className="btn icon" aria-label="Fullscreen" onClick={() => (document.fullscreenElement ? document.exitFullscreen() : stage.current?.requestFullscreen())?.catch(() => {})}><Maximize /></button>
          <button className="btn danger" disabled={busy} onClick={() => run(() => session.leaveRoom())} data-testid="leave"><LogOut /> Leave</button>
        </div>
      </div>

      <aside className="side">
        <div className="card">
          <div className="row spread"><h3>Participants</h3><span className="muted small">{info.peers.length} / {info.maxParticipants}</span></div>
          <div style={{ marginTop: 6 }}>
            {info.peers.map((p) => <PeerRow key={p.peerId} peer={p} self={p.peerId === room.peerId} canKick={isOwner} />)}
          </div>
        </div>
        <InviteCard isOwner={isOwner} />
        {isOwner && (
          <button className="btn danger" disabled={busy} onClick={() => run(() => session.closeRoom())}><XCircle /> Close room for everyone</button>
        )}
      </aside>

      {confirmShare && (
        <ShareConsent
          viewers={info.peers.length - 1}
          roomName={info.name}
          onCancel={() => setConfirmShare(false)}
          onConfirm={() => {
            setConfirmShare(false);
            void run(() => session.startShare());
          }}
        />
      )}
    </div>
  );
}

/** In-app consent step. The system picker that follows is the second, platform-enforced one. */
function ShareConsent(p: { viewers: number; roomName: string; onCancel: () => void; onConfirm: () => void }) {
  const stream = useApp((s) => s.settings.stream);
  const updateSettings = useApp((s) => s.updateSettings);
  return (
    <Modal title="Share your screen?" onClose={p.onCancel}>
      <p className="muted">
        {p.viewers === 0 ? `You are alone in “${p.roomName}” — anyone who joins will see your screen.` : `${p.viewers} other participant${p.viewers === 1 ? '' : 's'} in “${p.roomName}” will see what you share.`}
      </p>
      <div className="stack" style={{ marginTop: 16 }}>
        <div className="field">
          <span>What to share</span>
          <Segmented<SurfacePreference> label="Source type" value={stream.surface} onChange={(surface) => updateSettings({ stream: { surface } })}
            options={[{ value: 'monitor', label: 'Entire screen' }, { value: 'window', label: 'Application window' }, { value: 'any', label: 'Decide in picker' }]} />
        </div>
        <ToggleRow title="Include system audio" hint="Game and app sound, sent as a separate stereo track" on={stream.systemAudio} onChange={(systemAudio) => updateSettings({ stream: { systemAudio } })} />
        <div className="kv">
          <span>Quality target</span><b>{resolutionLabel(stream.height)} · {stream.fps} FPS · {(stream.bitrateKbps / 1000).toFixed(1)} Mbps</b>
          <span>Encoder</span><b>{stream.codec === 'auto' ? 'Auto (best hardware codec)' : CODEC_LABEL[stream.codec]}</b>
        </div>
        <div className="notice info"><ShieldAlert />
          <span>Next, your system asks you to pick the exact screen or window. Nothing is captured until you confirm there, and you can stop at any time.</span>
        </div>
      </div>
      <div className="modal-actions">
        <button className="btn" onClick={p.onCancel}>Cancel</button>
        <button className="btn primary" onClick={p.onConfirm} data-testid="confirm-share"><MonitorUp /> Choose what to share</button>
      </div>
    </Modal>
  );
}

function PeerRow({ peer, self, canKick }: { peer: PeerInfo; self: boolean; canKick: boolean }) {
  const volume = useApp((s) => s.peerVolume[peer.user.id] ?? 1);
  const setPeerVolume = useApp((s) => s.setPeerVolume);
  const [busy, run] = useAction();
  const micPub = peer.publications.find((p) => p.source === 'mic');
  const sharing = peer.publications.some((p) => p.source === 'screen');
  return (
    <div className="peer" data-testid={`peer-${peer.user.username}`}>
      <Avatar user={peer.user} size={30} />
      <div className="grow">
        <div className="name">{peer.user.displayName}{self && <span className="muted"> (you)</span>}</div>
        <div className="icons">
          {peer.isOwner && <Crown color="#f5a524" aria-label="Room owner" />}
          {sharing && <MonitorUp color="#8b6cff" aria-label="Sharing screen" />}
          {micPub && (micPub.paused ? <MicOff aria-label="Muted" /> : <Mic color="#3ecf8e" aria-label="In voice" />)}
          {peer.user.guest && <span className="small">Guest</span>}
        </div>
      </div>
      {!self && micPub && (
        <input type="range" min={0} max={1} step={0.05} value={volume} aria-label={`Volume of ${peer.user.displayName}`} onChange={(e) => setPeerVolume(peer.user.id, Number(e.target.value))} />
      )}
      {!self && canKick && (
        <button className="btn ghost sm icon" aria-label={`Remove ${peer.user.displayName}`} title="Remove from room" disabled={busy} onClick={() => run(() => session.kick(peer.peerId))} data-testid={`kick-${peer.user.username}`}><UserX /></button>
      )}
    </div>
  );
}

function InviteCard({ isOwner }: { isOwner: boolean }) {
  const room = useApp((s) => s.room)!;
  const friends = useApp((s) => s.friends);
  const [busy, run] = useAction();
  const inRoom = new Set(room.info.peers.map((p) => p.user.id));
  const invitable = friends.filter((f) => f.status === 'accepted' && f.online && !inRoom.has(f.user.id));
  return (
    <div className="card stack" style={{ gap: 10 }}>
      <div className="row spread"><h3>Invite</h3><span className="chip mono" title="Room ID">{room.info.id}</span></div>
      <div className="code-box mono selectable" data-testid="invite-code">{room.inviteCode}</div>
      <div className="row">
        <button className="btn sm grow" onClick={() => copyText(room.inviteCode, 'Invitation code')}><Copy /> Code</button>
        <button className="btn sm grow" onClick={() => copyText(room.inviteLink, 'Invitation link')} data-invite-link={room.inviteLink} data-testid="copy-link"><Link2 /> Link</button>
        {isOwner && <button className="btn sm icon" aria-label="Generate a new invitation" title="Invalidate this invitation and create a new one" disabled={busy} onClick={() => run(() => session.regenerateInvite(), 'New invitation created — the old one no longer works')}><RefreshCw /></button>}
      </div>
      {isOwner && (
        <div className="row spread">
          <div><b>Lock room</b><div className="muted small">Nobody else can join</div></div>
          <Switch label="Lock room" on={room.info.locked} onChange={(locked) => void run(() => session.setLocked(locked))} />
        </div>
      )}
      {invitable.map((f) => (
        <div className="row" key={f.user.id}>
          <Avatar user={f.user} size={26} presence />
          <span className="grow">{f.user.displayName}</span>
          <button className="btn sm" disabled={busy} onClick={() => run(() => session.sig.call('room.inviteFriend', { userId: f.user.id }), `Invitation sent to ${f.user.displayName}`)}><Send /> Invite</button>
        </div>
      ))}
    </div>
  );
}

function StatsOverlay() {
  const s = useApp((st) => st.latest)!;
  const line = (k: string, v: string) => <div><span>{k}</span><b>{v}</b></div>;
  return (
    <div className="overlay-stats mono" data-testid="stats-overlay">
      {s.send && (
        <>
          {line('Sending', `${s.send.width}×${s.send.height}`)}
          {line('FPS sent / captured', `${fmt(s.send.fps)} / ${fmt(s.send.captureFps)}`)}
          {line('Bitrate', `${fmtMbps(s.send.bitrateKbps)} Mbps`)}
          {line('Encode', `${fmt(s.send.encodeMs, 1)} ms`)}
          {line('Encoder', `${s.send.codec} ${s.send.hardware === true ? '(HW)' : s.send.hardware === false ? '(SW)' : ''}`)}
          {line('Limited by', s.send.limitation)}
        </>
      )}
      {s.recv && (
        <>
          {line('Receiving', `${s.recv.width}×${s.recv.height}`)}
          {line('FPS', fmt(s.recv.fps))}
          {line('Bitrate', `${fmtMbps(s.recv.bitrateKbps)} Mbps`)}
          {line('Decode', `${fmt(s.recv.decodeMs, 1)} ms`)}
          {line('Jitter buffer', `${fmt(s.recv.jitterBufferMs)} ms`)}
          {line('Loss', `${fmt(s.recv.lossPct, 2)} %`)}
          {line('Dropped', String(s.recv.framesDropped))}
        </>
      )}
      {s.net && line('RTT', `${fmt(s.net.rttMs)} ms${s.net.relayed ? ' (relay)' : ''}`)}
      {!s.send && !s.recv && line('Stream', 'none')}
    </div>
  );
}
