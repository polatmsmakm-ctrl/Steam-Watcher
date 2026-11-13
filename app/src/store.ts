import { create } from 'zustand';
import type { FriendInfo, MediaKind, MediaSource, PublicUser, RoomInfo, RoomInvite } from '../../shared/protocol.ts';
import { defaultServerUrl } from './lib/platform.ts';
import type { SignalState } from './lib/signaling.ts';
import type { SurfacePreference } from './media/capture.ts';
import type { CodecChoice, CodecName } from './media/codecs.ts';
import { PRESETS, type PresetName } from './media/presets.ts';
import type { Sample } from './media/stats.ts';
import type { MediaConnectionState } from './media/transport.ts';

export type View = 'home' | 'friends' | 'create' | 'join' | 'live' | 'stream' | 'audio' | 'stats' | 'profile' | 'settings';
export type LatencyMode = 'ultra' | 'balanced' | 'smooth';

export interface Settings {
  serverUrl: string;
  stream: {
    preset: PresetName;
    width: number;
    height: number;
    fps: number;
    bitrateKbps: number;
    codec: CodecChoice;
    degradation: RTCDegradationPreference;
    contentHint: 'motion' | 'detail';
    simulcast: boolean;
    systemAudio: boolean;
    surface: SurfacePreference;
  };
  audio: {
    micId: string;
    speakerId: string;
    noiseSuppression: boolean;
    echoCancellation: boolean;
    autoGainControl: boolean;
    /** 0-1 */
    streamVolume: number;
    voiceVolume: number;
    streamMuted: boolean;
    joinMuted: boolean;
  };
  app: {
    latencyMode: LatencyMode;
    statsOverlay: boolean;
    reducedMotion: boolean;
    /** Send media only through the TURN relay, so peers never learn this device's IP address. */
    relayOnly: boolean;
  };
}

export const DEFAULT_SETTINGS: Settings = {
  serverUrl: defaultServerUrl(),
  stream: {
    preset: 'medium', ...pick(PRESETS.medium), codec: 'auto', degradation: 'maintain-framerate', contentHint: 'motion',
    simulcast: false, systemAudio: true, surface: 'monitor',
  },
  audio: {
    micId: '', speakerId: '', noiseSuppression: true, echoCancellation: true, autoGainControl: true,
    streamVolume: 1, voiceVolume: 1, streamMuted: false, joinMuted: true,
  },
  app: { latencyMode: 'ultra', statsOverlay: false, reducedMotion: false, relayOnly: false },
};

function pick(f: { width: number; height: number; fps: number; bitrateKbps: number }) {
  return { width: f.width, height: f.height, fps: f.fps, bitrateKbps: f.bitrateKbps };
}

export interface RemoteMedia {
  id: string;
  peerId: string;
  source: MediaSource;
  kind: MediaKind;
  track: MediaStreamTrack;
}

export interface LocalScreen {
  track: MediaStreamTrack;
  hasAudio: boolean;
  paused: boolean;
  codec: CodecName;
  surface: string;
}

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'error';
  text: string;
}

export interface RoomState {
  info: RoomInfo;
  peerId: string;
  inviteCode: string;
  inviteLink: string;
}

interface AppState {
  auth: { token: string; user: PublicUser } | null;
  settings: Settings;
  view: View;
  signal: SignalState;
  friends: FriendInfo[];
  invites: RoomInvite[];
  toasts: Toast[];
  room: RoomState | null;
  /** True while (re)joining a room after a connection drop. */
  reconnecting: boolean;
  ice: MediaConnectionState;
  localScreen: LocalScreen | null;
  mic: { active: boolean; muted: boolean };
  remote: RemoteMedia[];
  /** Set when the stream uses a codec this device cannot decode. */
  decodeError: string | null;
  /** Per-user voice volume, 0-1, keyed by user id. */
  peerVolume: Record<string, number>;
  latest: Sample | null;
  history: Sample[];
  pendingJoin: string | null;

  setView(view: View): void;
  toast(kind: Toast['kind'], text: string): void;
  dismissToast(id: number): void;
  updateSettings(patch: { [K in keyof Settings]?: Partial<Settings[K]> | Settings[K] }): void;
  setPeerVolume(userId: string, volume: number): void;
}

const load = <T,>(key: string): T | null => {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null') as T | null;
  } catch {
    return null;
  }
};
const save = (key: string, value: unknown): void => {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable: settings just won't persist */
  }
};

function loadSettings(): Settings {
  const s = load<Partial<Settings>>('vs.settings') ?? {};
  return {
    serverUrl: s.serverUrl || DEFAULT_SETTINGS.serverUrl,
    stream: { ...DEFAULT_SETTINGS.stream, ...s.stream },
    audio: { ...DEFAULT_SETTINGS.audio, ...s.audio },
    app: { ...DEFAULT_SETTINGS.app, ...s.app },
  };
}

function initialJoinCode(): string | null {
  const m = /^#\/join\/([A-Za-z0-9-]+)/.exec(location.hash);
  if (m) history.replaceState(null, '', location.pathname);
  return m?.[1] ?? null;
}

let toastId = 1;

export const useApp = create<AppState>((set) => ({
  auth: load('vs.auth'),
  settings: loadSettings(),
  view: 'home',
  signal: 'offline',
  friends: [],
  invites: [],
  toasts: [],
  room: null,
  reconnecting: false,
  ice: 'new',
  localScreen: null,
  mic: { active: false, muted: false },
  remote: [],
  decodeError: null,
  peerVolume: {},
  latest: null,
  history: [],
  pendingJoin: initialJoinCode(),

  setView: (view) => set({ view }),
  toast: (kind, text) => set((s) => ({ toasts: [...s.toasts.slice(-3), { id: toastId++, kind, text }] })),
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  updateSettings: (patch) =>
    set((s) => {
      const settings = { ...s.settings };
      for (const [key, value] of Object.entries(patch)) {
        const k = key as keyof Settings;
        (settings as Record<string, unknown>)[k] = typeof value === 'object' ? { ...(s.settings[k] as object), ...value } : value;
      }
      save('vs.settings', settings);
      return { settings };
    }),
  setPeerVolume: (userId, volume) => set((s) => ({ peerVolume: { ...s.peerVolume, [userId]: volume } })),
}));

export function setAuth(auth: AppState['auth']): void {
  save('vs.auth', auth);
  useApp.setState({ auth });
}

export const toast = (kind: Toast['kind'], text: string): void => useApp.getState().toast(kind, text);
