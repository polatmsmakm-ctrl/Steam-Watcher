import { KeyRound, LogOut, Save } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { AVATAR_COLORS, LIMITS } from '../../../shared/protocol.ts';
import { session } from '../session.ts';
import { setAuth, useApp } from '../store.ts';
import { Avatar, Field, useAction } from '../ui.tsx';

export function ProfileView() {
  const auth = useApp((s) => s.auth)!;
  const { user } = auth;
  const [displayName, setDisplayName] = useState(user.displayName);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, run] = useAction();

  const saveProfile = (patch: { displayName?: string; avatarColor?: string }) => run(async () => {
    const { user: updated } = await session.sig.call('profile.update', patch);
    setAuth({ ...auth, user: updated });
  }, 'Profile updated');

  const changePassword = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await session.sig.call('profile.changePassword', { current, next });
      setCurrent('');
      setNext('');
    }, 'Password changed');
  };

  return (
    <div className="page">
      <div className="page-head">
        <div className="row" style={{ gap: 16 }}>
          <Avatar user={{ ...user, displayName }} size={64} />
          <div>
            <h1>{user.displayName}</h1>
            <p>{user.guest ? 'Guest session — expires after 24 hours' : `@${user.username}`}</p>
          </div>
        </div>
        <button className="btn danger" onClick={() => session.signOut()} data-testid="sign-out"><LogOut /> Sign out</button>
      </div>
      {user.guest ? (
        <div className="card empty"><p>Guests have no profile to edit. Sign out and create an account to host rooms, add friends and keep your name.</p></div>
      ) : (
        <div className="stack">
          <form className="card stack" onSubmit={(e) => { e.preventDefault(); void saveProfile({ displayName }); }}>
            <h2>Profile</h2>
            <Field label="Display name" hint="Shown to everyone in your rooms">
              <input className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={LIMITS.displayName.max} required />
            </Field>
            <div className="field">
              <span>Avatar colour</span>
              <div className="swatches">
                {AVATAR_COLORS.map((c) => (
                  <button type="button" key={c} className={`swatch ${c === user.avatarColor ? 'on' : ''}`} style={{ background: c }} aria-label={`Avatar colour ${c}`} aria-pressed={c === user.avatarColor} disabled={busy} onClick={() => saveProfile({ avatarColor: c })} />
                ))}
              </div>
            </div>
            <div><button className="btn primary" disabled={busy || !displayName.trim() || displayName === user.displayName}><Save /> Save name</button></div>
          </form>
          <form className="card stack" onSubmit={changePassword}>
            <h2>Password</h2>
            <div className="grid cols-2">
              <Field label="Current password"><input className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required /></Field>
              <Field label="New password" hint={`At least ${LIMITS.password.min} characters`}><input className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} minLength={LIMITS.password.min} maxLength={LIMITS.password.max} required /></Field>
            </div>
            <div><button className="btn" disabled={busy}><KeyRound /> Change password</button></div>
          </form>
        </div>
      )}
    </div>
  );
}
