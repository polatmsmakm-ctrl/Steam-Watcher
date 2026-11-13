import { Lock, Share2, Users, Zap } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { LIMITS, type RoomMode } from '../../../shared/protocol.ts';
import { session } from '../session.ts';
import { useApp } from '../store.ts';
import { Field, useAction } from '../ui.tsx';

export function CreateRoomView() {
  const user = useApp((s) => s.auth!.user);
  const online = useApp((s) => s.signal === 'online');
  const [name, setName] = useState(`${user.displayName}'s room`.slice(0, LIMITS.roomName.max));
  const [mode, setMode] = useState<RoomMode>('sfu');
  const [busy, run] = useAction();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(() => session.createRoom(name, mode));
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Create a private room</h1>
          <p>Only people with your invitation can enter. You can remove anyone at any time.</p>
        </div>
      </div>
      {user.guest ? (
        <div className="card empty"><Lock /><p>Guests cannot host rooms. Create an account to host.</p></div>
      ) : (
        <form className="stack" onSubmit={submit}>
          <div className="card">
            <Field label="Room name">
              <input className="input" name="roomName" value={name} onChange={(e) => setName(e.target.value)} maxLength={LIMITS.roomName.max} required />
            </Field>
          </div>
          <div className="grid cols-2">
            <div className={`card hover ${mode === 'sfu' ? 'selected' : ''}`} onClick={() => setMode('sfu')} role="radio" aria-checked={mode === 'sfu'} tabIndex={0} data-testid="mode-sfu">
              <div className="row spread"><Users color="#8b6cff" /><span className="chip accent">Recommended</span></div>
              <h2 style={{ marginTop: 10 }}>Group room</h2>
              <p className="muted small">
                Your stream is uploaded once and the server forwards it to every viewer, so upload bandwidth stays constant no matter how many friends watch.
                Encoders: AV1, H.264, VP9, VP8.
              </p>
            </div>
            <div className={`card hover ${mode === 'p2p' ? 'selected' : ''}`} onClick={() => setMode('p2p')} role="radio" aria-checked={mode === 'p2p'} tabIndex={0} data-testid="mode-p2p">
              <div className="row spread"><Zap color="#4f9dff" /><span className="chip">1 viewer</span></div>
              <h2 style={{ marginTop: 10 }}>Direct room</h2>
              <p className="muted small">
                A peer-to-peer connection between you and one friend — no media server in the path, lowest latency.
                Adds HEVC where both PCs support it.
              </p>
            </div>
          </div>
          <div className="row">
            <button className="btn primary lg" disabled={busy || !online || !name.trim()}><Share2 /> Create room</button>
            {!online && <span className="muted small">Waiting for the server connection…</span>}
          </div>
        </form>
      )}
    </div>
  );
}

export function JoinRoomView() {
  const pendingJoin = useApp((s) => s.pendingJoin);
  const online = useApp((s) => s.signal === 'online');
  const [code, setCode] = useState(pendingJoin ?? '');
  const [busy, run] = useAction();
  const autoJoined = useRef(false);

  const join = (value: string) => run(async () => {
    useApp.setState({ pendingJoin: null });
    await session.joinRoom(value);
  });

  // Opened from an invite link: join as soon as the connection is up.
  useEffect(() => {
    if (pendingJoin && online && !autoJoined.current) {
      autoJoined.current = true;
      void join(pendingJoin);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingJoin, online]);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Join a room</h1>
          <p>Paste the invitation link or code the host sent you.</p>
        </div>
      </div>
      <form className="card stack" onSubmit={(e) => { e.preventDefault(); void join(code); }}>
        <Field label="Invitation link or code" hint="Example: K7M2QX9PD-4HT8WQ2ZNB6RC3VYJ5XA">
          <input className="input mono" name="invite" value={code} onChange={(e) => setCode(e.target.value)} placeholder="Paste here" autoFocus required />
        </Field>
        <div className="row">
          <button className="btn primary lg" disabled={busy || !online || code.trim().length < 9}>Join room</button>
          {!online && <span className="muted small">Waiting for the server connection…</span>}
        </div>
      </form>
    </div>
  );
}
