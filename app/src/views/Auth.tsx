import { ChevronDown } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { LIMITS } from '../../../shared/protocol.ts';
import * as api from '../lib/api.ts';
import { setAuth, useApp } from '../store.ts';
import { Field, Segmented, useAction } from '../ui.tsx';

type Mode = 'login' | 'register' | 'guest';

export function AuthView() {
  const serverUrl = useApp((s) => s.settings.serverUrl);
  const updateSettings = useApp((s) => s.updateSettings);
  const pendingJoin = useApp((s) => s.pendingJoin);
  const [mode, setMode] = useState<Mode>(pendingJoin ? 'guest' : 'login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [showServer, setShowServer] = useState(false);
  const [guests, setGuests] = useState(true);
  const [busy, run] = useAction();

  useEffect(() => {
    let live = true;
    api.health(serverUrl).then((h) => live && setGuests(h.allowGuests), () => {});
    return () => void (live = false);
  }, [serverUrl]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const result =
        mode === 'login' ? await api.login(serverUrl, username, password)
        : mode === 'register' ? await api.register(serverUrl, username, password, displayName || username)
        : await api.guest(serverUrl, displayName);
      setAuth(result);
    });
  };

  return (
    <div className="auth">
      <form className="auth-card card" onSubmit={submit}>
        <div className="auth-logo">
          <img src="/icon.svg" alt="" />
          <b>VISION STREAM</b>
          {pendingJoin && <span className="chip accent">You have been invited to a room</span>}
        </div>
        <div className="stack">
          <Segmented<Mode>
            label="Account mode" value={mode} onChange={setMode}
            options={[{ value: 'login', label: 'Sign in' }, { value: 'register', label: 'Create account' }, ...(guests ? [{ value: 'guest' as const, label: 'Guest' }] : [])]}
          />
          {mode !== 'guest' && (
            <Field label="Username">
              <input className="input" name="username" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} minLength={LIMITS.username.min} maxLength={LIMITS.username.max} required autoFocus />
            </Field>
          )}
          {mode !== 'login' && (
            <Field label="Display name" hint={mode === 'guest' ? 'Guests can join rooms by invite. Create an account to host and add friends.' : undefined}>
              <input className="input" name="displayName" value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={LIMITS.displayName.max} required={mode === 'guest'} />
            </Field>
          )}
          {mode !== 'guest' && (
            <Field label="Password" hint={mode === 'register' ? `At least ${LIMITS.password.min} characters` : undefined}>
              <input className="input" name="password" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={password} onChange={(e) => setPassword(e.target.value)} minLength={mode === 'register' ? LIMITS.password.min : 1} maxLength={LIMITS.password.max} required />
            </Field>
          )}
          <button className="btn primary lg" type="submit" disabled={busy}>
            {mode === 'login' ? 'Sign in' : mode === 'register' ? 'Create account' : 'Continue as guest'}
          </button>
          <button type="button" className="btn ghost sm" onClick={() => setShowServer((v) => !v)}>
            Server <ChevronDown style={{ transform: showServer ? 'rotate(180deg)' : undefined }} />
          </button>
          {showServer && (
            <Field label="Server address" hint="The VISION STREAM room server you and your friends connect to.">
              <input className="input mono" name="server" value={serverUrl} onChange={(e) => updateSettings({ serverUrl: e.target.value.trim() })} placeholder="https://stream.example.com" />
            </Field>
          )}
        </div>
      </form>
    </div>
  );
}
