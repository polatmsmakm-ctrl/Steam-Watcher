import {
  Activity, AlertCircle, CheckCircle2, Home, Info, LogIn, Mic, PlusCircle, Radio, Settings as SettingsIcon, SlidersHorizontal, Users,
} from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import { session } from './session.ts';
import { useApp, type Toast, type View } from './store.ts';
import { Avatar } from './ui.tsx';
import { AudioSettingsView } from './views/AudioSettings.tsx';
import { AuthView } from './views/Auth.tsx';
import { CreateRoomView, JoinRoomView } from './views/Rooms.tsx';
import { FriendsView } from './views/Friends.tsx';
import { HomeView } from './views/Home.tsx';
import { LiveView, RoomAudio } from './views/Live.tsx';
import { ProfileView } from './views/Profile.tsx';
import { AppSettingsView } from './views/AppSettings.tsx';
import { StatsView } from './views/Stats.tsx';
import { StreamSettingsView } from './views/StreamSettings.tsx';

const VIEWS: Record<Exclude<View, 'live'>, () => ReactNode> = {
  home: HomeView, friends: FriendsView, create: CreateRoomView, join: JoinRoomView, stream: StreamSettingsView,
  audio: AudioSettingsView, stats: StatsView, profile: ProfileView, settings: AppSettingsView,
};

export function App() {
  const auth = useApp((s) => s.auth);
  const reducedMotion = useApp((s) => s.settings.app.reducedMotion);

  useEffect(() => {
    if (auth) session.start();
    // Only (re)connect when the account changes, not on every profile edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth?.token]);

  return (
    <div className={reducedMotion ? 'reduced-motion' : ''} style={{ height: '100%' }}>
      {auth ? <Shell /> : <AuthView />}
      <Toasts />
    </div>
  );
}

function Shell() {
  const view = useApp((s) => s.view);
  const room = useApp((s) => s.room);
  const pendingJoin = useApp((s) => s.pendingJoin);
  const setView = useApp((s) => s.setView);
  const Current = view === 'live' ? null : VIEWS[view];

  useEffect(() => {
    if (pendingJoin) setView('join');
  }, [pendingJoin, setView]);
  useEffect(() => {
    if (view === 'live' && !room) setView('home');
  }, [view, room, setView]);

  return (
    <div className="shell">
      <Sidebar />
      <main className="main">
        {/* The room stays mounted while you visit other screens so the stream keeps playing. */}
        {room && (
          <div style={{ display: view === 'live' ? 'block' : 'none', height: '100%' }}>
            <LiveView />
          </div>
        )}
        {Current && <Current key={view} />}
      </main>
      <RoomAudio />
    </div>
  );
}

function Sidebar() {
  const view = useApp((s) => s.view);
  const setView = useApp((s) => s.setView);
  const room = useApp((s) => s.room);
  const user = useApp((s) => s.auth!.user);
  const signal = useApp((s) => s.signal);
  const attention = useApp((s) => s.friends.filter((f) => f.status === 'incoming').length + s.invites.length);

  const item = (id: View, label: string, icon: ReactNode, extra?: ReactNode) => (
    <button className={`nav ${view === id ? 'active' : ''}`} onClick={() => setView(id)} aria-current={view === id ? 'page' : undefined}>
      {icon}
      {label}
      {extra}
    </button>
  );

  return (
    <nav className="sidebar" aria-label="Main">
      <div className="brand">
        <img src="/icon.svg" alt="" />
        <span>VISION STREAM</span>
      </div>
      {item('home', 'Home', <Home />)}
      {item('friends', 'Friends', <Users />, attention > 0 && <span className="badge">{attention}</span>)}
      <div className="nav-label">Rooms</div>
      {room && item('live', room.info.name, <Radio />, <i className="live-dot" />)}
      {item('create', 'Create room', <PlusCircle />)}
      {item('join', 'Join room', <LogIn />)}
      <div className="nav-label">Streaming</div>
      {item('stream', 'Stream settings', <SlidersHorizontal />)}
      {item('audio', 'Audio settings', <Mic />)}
      {item('stats', 'Performance', <Activity />)}
      <div className="sidebar-foot">
        {item('settings', 'Settings', <SettingsIcon />)}
        <div className="conn" data-testid="connection">
          <i className={`dot ${signal === 'online' ? 'good' : signal === 'connecting' ? 'warn' : 'bad'}`} />
          {signal === 'online' ? 'Connected' : signal === 'connecting' ? 'Connecting…' : 'Offline'}
        </div>
        <button className="me" onClick={() => setView('profile')} style={{ color: 'inherit', textAlign: 'left' }}>
          <Avatar user={user} presence={signal === 'online'} />
          <div>
            <b>{user.displayName}</b>
            <small>{user.guest ? 'Guest' : `@${user.username}`}</small>
          </div>
        </button>
      </div>
    </nav>
  );
}

function Toasts() {
  const toasts = useApp((s) => s.toasts);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => <ToastItem key={t.id} toast={t} />)}
    </div>
  );
}

/** Each toast runs its own timer, so a burst of messages does not queue up on screen. */
function ToastItem({ toast: t }: { toast: Toast }) {
  const dismiss = useApp((s) => s.dismissToast);
  useEffect(() => {
    const timer = setTimeout(() => dismiss(t.id), t.kind === 'error' ? 7000 : 4000);
    return () => clearTimeout(timer);
  }, [t.id, t.kind, dismiss]);
  return (
    <div className={`toast ${t.kind}`} onClick={() => dismiss(t.id)}>
      {t.kind === 'error' ? <AlertCircle /> : t.kind === 'success' ? <CheckCircle2 /> : <Info />}
      {t.text}
    </div>
  );
}
