import { ArrowRight, Cpu, LogIn, MonitorUp, PlusCircle, Radio, Users } from 'lucide-react';
import { session } from '../session.ts';
import { isTauri } from '../lib/platform.ts';
import { CODEC_LABEL } from '../media/codecs.ts';
import { resolutionLabel } from '../media/presets.ts';
import { useApp } from '../store.ts';
import { Avatar, fmt, useAction } from '../ui.tsx';

export function HomeView() {
  const user = useApp((s) => s.auth!.user);
  const room = useApp((s) => s.room);
  const friends = useApp((s) => s.friends);
  const invites = useApp((s) => s.invites);
  const stream = useApp((s) => s.settings.stream);
  const sys = useApp((s) => s.latest?.sys);
  const setView = useApp((s) => s.setView);
  const [busy, run] = useAction();
  const online = friends.filter((f) => f.status === 'accepted' && f.online);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Welcome back, {user.displayName}</h1>
          <p>Share your screen with friends in a private room.</p>
        </div>
      </div>
      <div className="stack">
        {room && (
          <div className="card hover selected row spread" onClick={() => setView('live')} data-testid="home-room">
            <div className="row">
              <Radio color="#ef5a6f" />
              <div>
                <b>{room.info.name}</b>
                <div className="muted small">{room.info.peers.length} participant{room.info.peers.length === 1 ? '' : 's'} · {room.info.mode === 'sfu' ? 'Group room' : 'Direct room'}</div>
              </div>
            </div>
            <span className="btn ghost">Return to room <ArrowRight /></span>
          </div>
        )}
        <div className="grid cols-2">
          <div className="card hover" onClick={() => setView('create')}>
            <PlusCircle color="#8b6cff" />
            <h2 style={{ marginTop: 10 }}>Create a private room</h2>
            <p className="muted">Host a room and invite friends with a secure code or link.</p>
          </div>
          <div className="card hover" onClick={() => setView('join')}>
            <LogIn color="#4f9dff" />
            <h2 style={{ marginTop: 10 }}>Join a room</h2>
            <p className="muted">Paste an invitation link or code you received.</p>
          </div>
        </div>
        {invites.length > 0 && (
          <div className="card">
            <h2>Invitations</h2>
            <p>Friends who want you in their room</p>
            {invites.map((inv) => (
              <div className="list-item" key={inv.roomId}>
                <Avatar user={inv.from} />
                <div className="grow"><b>{inv.roomName}</b><span className="muted small">from {inv.from.displayName}</span></div>
                <button className="btn primary sm" disabled={busy} onClick={() => run(async () => {
                  await session.joinRoom(inv.inviteCode);
                  useApp.setState((s) => ({ invites: s.invites.filter((i) => i.roomId !== inv.roomId) }));
                })}>Join</button>
              </div>
            ))}
          </div>
        )}
        <div className="grid cols-3">
          <div className="card hover" onClick={() => setView('stream')}>
            <h3><MonitorUp size={13} style={{ verticalAlign: -2 }} /> Stream quality</h3>
            <div className="stat" style={{ marginTop: 8 }}>
              <span className="value">{resolutionLabel(stream.height)}<small>{stream.fps} FPS</small></span>
              <span className="sub">{(stream.bitrateKbps / 1000).toFixed(1)} Mbps · {stream.codec === 'auto' ? 'Auto encoder' : CODEC_LABEL[stream.codec]}</span>
            </div>
          </div>
          <div className="card hover" onClick={() => setView('friends')}>
            <h3><Users size={13} style={{ verticalAlign: -2 }} /> Friends online</h3>
            <div className="stat" style={{ marginTop: 8 }}>
              <span className="value">{online.length}<small>of {friends.filter((f) => f.status === 'accepted').length}</small></span>
              <span className="sub">{online.slice(0, 3).map((f) => f.user.displayName).join(', ') || 'Nobody online right now'}</span>
            </div>
          </div>
          <div className="card hover" onClick={() => setView('stats')}>
            <h3><Cpu size={13} style={{ verticalAlign: -2 }} /> System</h3>
            <div className="stat" style={{ marginTop: 8 }}>
              {sys ? (
                <>
                  <span className="value">{fmt(sys.cpu)}<small>% CPU</small></span>
                  <span className="sub">{sys.gpu ? `${sys.gpu.name} · ${sys.gpu.utilization}% GPU` : 'No NVIDIA GPU detected'}</span>
                </>
              ) : (
                <>
                  <span className="value">—</span>
                  <span className="sub">{isTauri ? 'Reading…' : 'System metrics need the desktop app'}</span>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
