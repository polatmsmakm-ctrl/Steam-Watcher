import { Check, Send, UserMinus, UserPlus, Users, X } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { session } from '../session.ts';
import { useApp } from '../store.ts';
import { Avatar, useAction } from '../ui.tsx';

export function FriendsView() {
  const friends = useApp((s) => s.friends);
  const invites = useApp((s) => s.invites);
  const room = useApp((s) => s.room);
  const guest = useApp((s) => s.auth!.user.guest);
  const [username, setUsername] = useState('');
  const [busy, run] = useAction();
  const call = session.sig.call.bind(session.sig);

  const add = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await call('friends.request', { username: username.trim().replace(/^@/, '') });
      setUsername('');
    }, 'Friend request sent');
  };

  const incoming = friends.filter((f) => f.status === 'incoming');
  const outgoing = friends.filter((f) => f.status === 'outgoing');
  const accepted = friends.filter((f) => f.status === 'accepted').sort((a, b) => Number(b.online) - Number(a.online) || a.user.displayName.localeCompare(b.user.displayName));

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Friends</h1>
          <p>Add friends by username and invite them straight into your room.</p>
        </div>
      </div>
      {guest ? (
        <div className="card empty"><Users /><p>Guests cannot add friends. Create an account to build a friends list.</p></div>
      ) : (
        <div className="stack">
          <form className="card row" onSubmit={add}>
            <input className="input grow" placeholder="Add a friend by username" value={username} onChange={(e) => setUsername(e.target.value)} aria-label="Friend username" />
            <button className="btn primary" disabled={busy || username.trim().length < 3}><UserPlus /> Send request</button>
          </form>

          {invites.length > 0 && (
            <div className="card">
              <h2>Room invitations</h2>
              <p>Tap join to enter the room</p>
              {invites.map((inv) => (
                <div className="list-item" key={inv.roomId}>
                  <Avatar user={inv.from} />
                  <div className="grow"><b>{inv.roomName}</b><span className="muted small">from {inv.from.displayName}</span></div>
                  <button className="btn primary sm" disabled={busy} onClick={() => run(async () => {
                    await session.joinRoom(inv.inviteCode);
                    useApp.setState((s) => ({ invites: s.invites.filter((i) => i.roomId !== inv.roomId) }));
                  })}>Join</button>
                  <button className="btn ghost sm icon" aria-label="Dismiss invitation" onClick={() => useApp.setState((s) => ({ invites: s.invites.filter((i) => i.roomId !== inv.roomId) }))}><X /></button>
                </div>
              ))}
            </div>
          )}

          {incoming.length > 0 && (
            <div className="card">
              <h2>Requests</h2>
              <p>People who want to add you</p>
              {incoming.map((f) => (
                <div className="list-item" key={f.user.id}>
                  <Avatar user={f.user} />
                  <div className="grow"><b>{f.user.displayName}</b><span className="muted small">@{f.user.username}</span></div>
                  <button className="btn primary sm" disabled={busy} onClick={() => run(() => call('friends.respond', { userId: f.user.id, accept: true }))}><Check /> Accept</button>
                  <button className="btn sm" disabled={busy} onClick={() => run(() => call('friends.respond', { userId: f.user.id, accept: false }))}>Decline</button>
                </div>
              ))}
            </div>
          )}

          <div className="card">
            <h2>Your friends</h2>
            <p>{accepted.filter((f) => f.online).length} online</p>
            {accepted.length === 0 && <div className="empty"><Users /><p>No friends yet. Send a request above.</p></div>}
            {accepted.map((f) => (
              <div className="list-item" key={f.user.id} data-testid={`friend-${f.user.username}`}>
                <Avatar user={f.user} presence={f.online} />
                <div className="grow">
                  <b>{f.user.displayName}</b>
                  <span className="muted small">@{f.user.username} · {f.online ? (f.inRoom ? 'In a room' : 'Online') : 'Offline'}</span>
                </div>
                {room && (
                  <button className="btn sm" disabled={busy || !f.online} title={f.online ? undefined : 'Friend is offline'}
                    onClick={() => run(() => call('room.inviteFriend', { userId: f.user.id }), `Invitation sent to ${f.user.displayName}`)}>
                    <Send /> Invite to room
                  </button>
                )}
                <button className="btn ghost sm icon" aria-label={`Remove ${f.user.displayName}`} disabled={busy} onClick={() => run(() => call('friends.remove', { userId: f.user.id }))}><UserMinus /></button>
              </div>
            ))}
          </div>

          {outgoing.length > 0 && (
            <div className="card">
              <h2>Sent requests</h2>
              <p>Waiting for a reply</p>
              {outgoing.map((f) => (
                <div className="list-item" key={f.user.id}>
                  <Avatar user={f.user} />
                  <div className="grow"><b>{f.user.displayName}</b><span className="muted small">@{f.user.username}</span></div>
                  <button className="btn sm" disabled={busy} onClick={() => run(() => call('friends.remove', { userId: f.user.id }))}>Cancel</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
