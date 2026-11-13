import type { JoinResult, Publication, RoomMode } from '../../shared/protocol.ts';
import { systemMetrics } from './lib/platform.ts';
import { RpcFailure, Signaling } from './lib/signaling.ts';
import { captureMic, captureScreen, describeSurface, mediaErrorMessage, videoConstraints } from './media/capture.ts';
import { CODEC_LABEL, pickCodec, probeEncoders, type CodecName } from './media/codecs.ts';
import { P2pTransport } from './media/p2p-transport.ts';
import { SfuTransport } from './media/sfu-transport.ts';
import { StatsSampler, type Sample } from './media/stats.ts';
import type { MediaTransport, RemoteTrack, TransportEvents } from './media/transport.ts';
import { setAuth, toast, useApp, type RoomState } from './store.ts';

const get = useApp.getState;
const set = useApp.setState;

const HISTORY = 300; // samples kept for the live charts (5 min at 1 Hz)
const RECORDING_MAX = 6 * 60 * 60; // samples kept for export (6 h)

interface LocalScreenMedia {
  video: MediaStreamTrack;
  audio?: MediaStreamTrack;
  videoPub?: string;
  audioPub?: string;
  codec?: CodecName;
  simulcast?: boolean;
  paused: boolean;
}

/**
 * The single live session: signaling connection, current room, the media
 * transport and local capture. React reads state from the store; this class
 * performs the side effects.
 */
class Session {
  readonly sig = new Signaling();
  /** Every sample since the room was entered, for CSV/JSON export. */
  recording: Sample[] = [];

  private transport?: MediaTransport;
  private join?: JoinResult;
  private rejoinCode?: string;
  private screen?: LocalScreenMedia;
  private mic?: { track: MediaStreamTrack; pub?: string; muted: boolean };
  private receivers = new Map<string, RTCRtpReceiver>();
  private sampler = new StatsSampler();
  private rebuilding = false;
  private statsBusy = false;
  private shareQueue: Promise<unknown> = Promise.resolve();

  /** Share operations (start/stop/pause/re-encode) run one at a time, in call order. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.shareQueue.then(fn, fn);
    this.shareQueue = run.catch(() => {});
    return run;
  }

  constructor() {
    const { sig } = this;
    sig.onState = (state) => {
      set({ signal: state });
      if (state === 'online') void this.onOnline();
      else if (get().room) set({ reconnecting: true });
    };
    sig.onFatal = (e) => {
      toast('error', e.message);
      this.signOut();
    };
    sig.on('friends.changed', () => void this.refreshFriends());
    sig.on('friends.invite', (invite) => {
      set((s) => ({ invites: [invite, ...s.invites.filter((i) => i.roomId !== invite.roomId)].slice(0, 10) }));
      toast('info', `${invite.from.displayName} invited you to “${invite.roomName}”`);
    });
    sig.on('room.peerJoined', ({ peer }) => {
      this.updateRoom((info) => ({ ...info, peers: [...info.peers.filter((p) => p.peerId !== peer.peerId), peer] }));
      this.transport?.peerJoined(peer.peerId);
      toast('info', `${peer.user.displayName} joined`);
    });
    sig.on('room.peerLeft', ({ peerId, reason }) => {
      const peer = get().room?.info.peers.find((p) => p.peerId === peerId);
      for (const pub of peer?.publications ?? []) this.transport?.unsubscribe(pub.id);
      this.transport?.peerLeft(peerId);
      this.updateRoom((info) => ({ ...info, peers: info.peers.filter((p) => p.peerId !== peerId) }));
      if (peer && reason !== 'disconnected') toast('info', `${peer.user.displayName} ${reason === 'kicked' ? 'was removed' : 'left'}`);
    });
    sig.on('room.updated', ({ locked }) => this.updateRoom((info) => ({ ...info, locked })));
    sig.on('room.closed', ({ reason }) => {
      this.cleanupRoom();
      toast(reason === 'kicked' ? 'error' : 'info', reason === 'kicked' ? 'You were removed from the room by the owner.' : 'The room was closed.');
    });
    sig.on('media.published', ({ publication }) => {
      this.updateRoom((info) => ({
        ...info,
        peers: info.peers.map((p) => (p.peerId === publication.peerId ? { ...p, publications: [...p.publications, publication] } : p)),
      }));
      this.subscribe(publication);
    });
    sig.on('media.unpublished', ({ id, peerId }) => {
      this.transport?.unsubscribe(id);
      this.updatePublications(peerId, (pubs) => pubs.filter((p) => p.id !== id));
      if (!this.remoteScreen()) set({ decodeError: null });
    });
    sig.on('media.paused', ({ id, peerId, paused }) =>
      this.updatePublications(peerId, (pubs) => pubs.map((p) => (p.id === id ? { ...p, paused } : p))),
    );
    setInterval(() => void this.tick(), 1000);
  }

  // ---------------------------------------------------------------- account

  start(): void {
    const { auth, settings } = get();
    if (auth) this.sig.start(settings.serverUrl, auth.token);
  }

  signOut(): void {
    this.cleanupRoom();
    this.sig.stop();
    setAuth(null);
    set({ friends: [], invites: [], view: 'home' });
  }

  private async onOnline(): Promise<void> {
    void this.refreshFriends();
    if (this.rejoinCode && get().room) await this.rebuild();
  }

  async refreshFriends(): Promise<void> {
    try {
      const { friends } = await this.sig.call('friends.list', {});
      set({ friends });
    } catch {
      /* offline: refreshed again on reconnect */
    }
  }

  // ------------------------------------------------------------------ rooms

  async createRoom(name: string, mode: RoomMode): Promise<void> {
    this.cleanupRoom();
    await this.enter(await this.sig.call('room.create', { name, mode }), false);
  }

  async joinRoom(inviteCode: string): Promise<void> {
    this.cleanupRoom();
    await this.enter(await this.sig.call('room.join', { inviteCode: extractInviteCode(inviteCode) }), false);
  }

  async leaveRoom(): Promise<void> {
    await this.sig.call('room.leave', {}).catch(() => {});
    this.cleanupRoom();
  }

  async closeRoom(): Promise<void> {
    await this.sig.call('room.close', {});
    this.cleanupRoom();
  }

  /** After a signaling drop the server has discarded our peer: join again and republish live tracks. */
  private async rebuild(): Promise<void> {
    if (this.rebuilding || !this.rejoinCode) return;
    this.rebuilding = true;
    set({ reconnecting: true });
    try {
      this.teardownTransport();
      await this.enter(await this.sig.call('room.join', { inviteCode: this.rejoinCode }), true);
      toast('success', 'Reconnected');
    } catch (e) {
      if (!(e instanceof RpcFailure && (e.code === 'OFFLINE' || e.code === 'TIMEOUT'))) {
        this.cleanupRoom();
        toast('error', `Could not rejoin the room: ${(e as Error).message}`);
      } // else: still offline — the next 'online' transition retries
    } finally {
      this.rebuilding = false;
    }
  }

  private async enter(join: JoinResult, republish: boolean): Promise<void> {
    this.join = join;
    this.rejoinCode = join.inviteCode ?? join.room.id;
    const room: RoomState = { info: join.room, peerId: join.peerId, inviteCode: join.inviteCode ?? '', inviteLink: join.inviteLink ?? '' };
    set({ room, remote: [], reconnecting: false, ice: 'new', decodeError: null, view: 'live' });
    if (!republish) {
      this.recording = [];
      set({ history: [], latest: null });
    }
    this.sampler.reset();

    const events: TransportEvents = {
      onRemoteTrack: (t) => this.onRemoteTrack(t),
      onRemoteTrackGone: (id) => {
        this.receivers.delete(id);
        set((s) => ({ remote: s.remote.filter((r) => r.id !== id) }));
      },
      onConnectionState: (ice) => set({ ice }),
      onUnrecoverable: () => void this.rebuild(),
    };
    const config = { relayOnly: get().settings.app.relayOnly };
    if (config.relayOnly && !join.iceServers.some((s) => s.urls.some((u) => u.startsWith('turn')))) {
      toast('error', 'Relay-only mode is on, but this server has no TURN relay configured. Media cannot connect.');
    }
    const transport = join.room.mode === 'sfu' ? new SfuTransport(this.sig, join, events, config) : new P2pTransport(this.sig, join, events, config);
    this.transport = transport;
    await transport.start();
    for (const peer of join.room.peers) {
      if (peer.peerId !== join.peerId) for (const pub of peer.publications) this.subscribe(pub);
    }
    if (republish) {
      if (this.screen) {
        const paused = this.screen.paused;
        await this.publishScreen().catch((e) => toast('error', `Could not resume sharing: ${(e as Error).message}`));
        if (paused) await this.setSharePausedNow(true).catch(() => {});
      }
      if (this.mic) await this.publishMic().catch(() => {});
    }
  }

  private teardownTransport(): void {
    this.transport?.close();
    this.transport = undefined;
    this.receivers.clear();
    if (this.screen) this.screen.videoPub = this.screen.audioPub = undefined;
    if (this.mic) this.mic.pub = undefined;
    set({ remote: [] });
  }

  private cleanupRoom(): void {
    this.teardownTransport();
    this.screen?.video.stop();
    this.screen?.audio?.stop();
    this.screen = undefined;
    this.mic?.track.stop();
    this.mic = undefined;
    this.join = undefined;
    this.rejoinCode = undefined;
    const wasLive = get().view === 'live';
    set({
      room: null, reconnecting: false, localScreen: null, mic: { active: false, muted: false }, remote: [], decodeError: null,
      ice: 'new', ...(wasLive ? { view: 'home' as const } : {}),
    });
  }

  private updateRoom(fn: (info: RoomState['info']) => RoomState['info']): void {
    set((s) => (s.room ? { room: { ...s.room, info: fn(s.room.info) } } : {}));
  }

  private updatePublications(peerId: string, fn: (pubs: Publication[]) => Publication[]): void {
    this.updateRoom((info) => ({
      ...info,
      peers: info.peers.map((p) => (p.peerId === peerId ? { ...p, publications: fn(p.publications) } : p)),
    }));
  }

  private findPublication(id: string): Publication | undefined {
    for (const p of get().room?.info.peers ?? []) {
      const pub = p.publications.find((x) => x.id === id);
      if (pub) return pub;
    }
    return undefined;
  }

  private remoteScreen(): Publication | undefined {
    const room = get().room;
    for (const p of room?.info.peers ?? []) {
      if (p.peerId === room!.peerId) continue;
      const pub = p.publications.find((x) => x.source === 'screen');
      if (pub) return pub;
    }
    return undefined;
  }

  async kick(peerId: string): Promise<void> {
    await this.sig.call('room.kick', { peerId });
  }

  async setLocked(locked: boolean): Promise<void> {
    await this.sig.call('room.setLocked', { locked });
  }

  async regenerateInvite(): Promise<void> {
    const { inviteCode, inviteLink } = await this.sig.call('room.regenerateInvite', {});
    this.rejoinCode = inviteCode;
    set((s) => (s.room ? { room: { ...s.room, inviteCode, inviteLink } } : {}));
  }

  // ------------------------------------------------------------ remote media

  private subscribe(pub: Publication): void {
    this.transport?.subscribe(pub).catch((e: Error) => {
      if (e instanceof RpcFailure && e.code === 'CANNOT_CONSUME') set({ decodeError: e.message });
      else if (!(e instanceof RpcFailure && e.code === 'OFFLINE')) toast('error', `Could not receive ${pub.source}: ${e.message}`);
    });
  }

  private onRemoteTrack(t: RemoteTrack): void {
    const pub = this.findPublication(t.id);
    if (!pub) return;
    if (t.receiver) {
      this.receivers.set(t.id, t.receiver);
      this.applyLatency(t.receiver, pub.source);
    }
    set((s) => ({
      remote: [...s.remote.filter((r) => r.id !== t.id), { id: t.id, peerId: pub.peerId, source: pub.source, kind: t.kind, track: t.track }],
    }));
  }

  /** Jitter-buffer target for the screen stream (voice keeps the browser default). */
  private applyLatency(receiver: RTCRtpReceiver, source: Publication['source']): void {
    if (source === 'mic') return;
    const mode = get().settings.app.latencyMode;
    try {
      (receiver as RTCRtpReceiver & { jitterBufferTarget: number | null }).jitterBufferTarget =
        mode === 'ultra' ? 0 : mode === 'smooth' ? 150 : null;
    } catch {
      /* older runtimes: default adaptive buffer */
    }
  }

  applyLatencyMode(): void {
    for (const [id, receiver] of this.receivers) {
      const pub = this.findPublication(id);
      if (pub) this.applyLatency(receiver, pub.source);
    }
  }

  async setViewerQuality(quality: 'auto' | 'low'): Promise<void> {
    const pub = this.remoteScreen();
    if (pub) await this.transport?.setPreferredQuality(pub.id, quality);
  }

  // ------------------------------------------------------------ screen share

  /**
   * Starts sharing. Must only be called from an explicit user action: the UI
   * shows its own confirmation first, and the system picker opened here is a
   * second, platform-enforced consent step.
   * @returns false if the user cancelled the system picker.
   */
  startShare(): Promise<boolean> {
    return this.serial(() => this.startShareNow());
  }

  private async startShareNow(): Promise<boolean> {
    if (!this.transport || this.screen) return false;
    const s = get().settings.stream;
    let capture;
    try {
      capture = await captureScreen({ width: s.width, height: s.height, fps: s.fps, audio: s.systemAudio, surface: s.surface, contentHint: s.contentHint });
    } catch (e) {
      if ((e as DOMException).name === 'NotAllowedError') return false;
      throw new Error(mediaErrorMessage(e));
    }
    this.screen = { video: capture.video, audio: capture.audio, paused: false };
    capture.video.addEventListener('ended', () => void this.stopShare());
    try {
      await this.publishScreen();
    } catch (e) {
      capture.video.stop();
      capture.audio?.stop();
      this.screen = undefined;
      set({ localScreen: null });
      throw e;
    }
    return true;
  }

  /** @param fallback publish with this encoder setup instead of the one in settings (used to undo a failed live change). */
  private async publishScreen(fallback?: { codec: CodecName; simulcast: boolean }): Promise<void> {
    const { screen, transport } = this;
    if (!screen || !transport) return;
    const s = { ...get().settings.stream, ...(fallback ?? {}) };
    const usable = transport.usableVideoCodecs();
    const codec = pickCodec(s.codec, usable, await probeEncoders(s.width, s.height, s.fps));
    if (!codec) {
      const wanted = s.codec === 'auto' ? 'A usable video codec' : CODEC_LABEL[s.codec];
      const hint = s.codec === 'hevc' && transport.mode === 'sfu' ? ' HEVC is only available in Direct (1:1) rooms.' : '';
      throw new Error(`${wanted} is not available here.${hint} Choose another encoder in Stream Settings.`);
    }
    screen.codec = codec;
    screen.simulcast = s.simulcast;
    screen.videoPub = await transport.publish(screen.video, {
      source: 'screen', codec, maxBitrate: s.bitrateKbps * 1000, maxFramerate: s.fps, simulcast: s.simulcast, degradation: s.degradation,
    });
    this.addOwnPublication({ id: screen.videoPub, kind: 'video', source: 'screen' });
    if (screen.audio && screen.audio.readyState === 'live') {
      screen.audioPub = await transport.publish(screen.audio, { source: 'screen-audio' });
      this.addOwnPublication({ id: screen.audioPub, kind: 'audio', source: 'screen-audio' });
    }
    set({
      localScreen: { track: screen.video, hasAudio: Boolean(screen.audioPub), paused: false, codec, surface: describeSurface(screen.video) },
    });
  }

  private addOwnPublication(p: Pick<Publication, 'id' | 'kind' | 'source'>): void {
    const peerId = get().room?.peerId;
    if (peerId) this.updatePublications(peerId, (pubs) => [...pubs, { ...p, peerId, paused: false }]);
  }

  private removeOwnPublication(id: string | undefined): void {
    const peerId = get().room?.peerId;
    if (peerId && id) this.updatePublications(peerId, (pubs) => pubs.filter((p) => p.id !== id));
  }

  stopShare(): Promise<void> {
    return this.serial(() => this.stopShareNow());
  }

  private async stopShareNow(): Promise<void> {
    const screen = this.screen;
    if (!screen) return;
    this.screen = undefined;
    screen.video.stop();
    screen.audio?.stop();
    set({ localScreen: null });
    for (const id of [screen.videoPub, screen.audioPub]) {
      this.removeOwnPublication(id);
      if (id) await this.transport?.unpublish(id);
    }
  }

  setSharePaused(paused: boolean): Promise<void> {
    return this.serial(() => this.setSharePausedNow(paused));
  }

  private async setSharePausedNow(paused: boolean): Promise<void> {
    const screen = this.screen;
    if (!screen?.videoPub || !this.transport) return;
    await this.transport.setPaused(screen.videoPub, paused);
    if (screen.audioPub) await this.transport.setPaused(screen.audioPub, paused);
    screen.paused = paused;
    set((s) => (s.localScreen ? { localScreen: { ...s.localScreen, paused } } : {}));
  }

  /** Applies changed stream settings to a running share without re-opening the picker. */
  applyStreamSettings(): Promise<void> {
    return this.serial(() => this.applyStreamSettingsNow());
  }

  private async applyStreamSettingsNow(): Promise<void> {
    const { screen, transport } = this;
    if (!screen?.videoPub || !transport) return;
    const s = get().settings.stream;
    screen.video.contentHint = s.contentHint;
    await screen.video.applyConstraints(videoConstraints(s.width, s.height, s.fps));
    const codec = pickCodec(s.codec, transport.usableVideoCodecs(), await probeEncoders(s.width, s.height, s.fps));
    if (codec !== screen.codec || s.simulcast !== screen.simulcast) {
      // Codec / layer changes need a new encoder: swap the publication, keep the capture.
      const paused = screen.paused;
      for (const id of [screen.videoPub, screen.audioPub]) {
        this.removeOwnPublication(id);
        if (id) await transport.unpublish(id);
      }
      screen.videoPub = screen.audioPub = undefined;
      const previous = { codec: screen.codec!, simulcast: Boolean(screen.simulcast) };
      try {
        await this.publishScreen();
      } catch (e) {
        // The new encoder setup was rejected: go back to the one that worked rather than leave viewers with nothing.
        if (!screen.videoPub) {
          await this.publishScreen(previous).catch(() => this.stopShareNow());
        }
        throw e;
      }
      if (paused) await this.setSharePausedNow(true);
    } else {
      await transport.updateEncoding(screen.videoPub, { maxBitrate: s.bitrateKbps * 1000, maxFramerate: s.fps, degradation: s.degradation });
    }
  }

  // ------------------------------------------------------------- voice chat

  async toggleMic(): Promise<void> {
    if (!this.mic) return this.enableMic();
    await this.setMicMuted(!this.mic.muted);
  }

  async enableMic(): Promise<void> {
    if (!this.transport || this.mic) return;
    let track: MediaStreamTrack;
    try {
      const a = get().settings.audio;
      track = await captureMic({ deviceId: a.micId, echoCancellation: a.echoCancellation, noiseSuppression: a.noiseSuppression, autoGainControl: a.autoGainControl });
    } catch (e) {
      throw new Error(`Microphone: ${mediaErrorMessage(e)}`);
    }
    this.mic = { track, muted: false };
    track.addEventListener('ended', () => void this.disableMic());
    try {
      await this.publishMic();
    } catch (e) {
      track.stop();
      this.mic = undefined;
      throw e;
    }
  }

  private async publishMic(): Promise<void> {
    const { mic, transport } = this;
    if (!mic || !transport) return;
    mic.pub = await transport.publish(mic.track, { source: 'mic' });
    this.addOwnPublication({ id: mic.pub, kind: 'audio', source: 'mic' });
    set({ mic: { active: true, muted: mic.muted } });
    if (mic.muted) await this.setMicMuted(true);
  }

  async setMicMuted(muted: boolean): Promise<void> {
    const mic = this.mic;
    if (!mic) return;
    mic.muted = muted;
    mic.track.enabled = !muted;
    set({ mic: { active: true, muted } });
    if (mic.pub) {
      await this.transport?.setPaused(mic.pub, muted).catch(() => {});
      const peerId = get().room?.peerId;
      if (peerId) this.updatePublications(peerId, (pubs) => pubs.map((p) => (p.id === mic.pub ? { ...p, paused: muted } : p)));
    }
  }

  async disableMic(): Promise<void> {
    const mic = this.mic;
    if (!mic) return;
    this.mic = undefined;
    mic.track.stop();
    set({ mic: { active: false, muted: false } });
    this.removeOwnPublication(mic.pub);
    if (mic.pub) await this.transport?.unpublish(mic.pub);
  }

  /** Re-opens the microphone with the current device / processing settings. */
  async restartMic(): Promise<void> {
    if (!this.mic) return;
    const muted = this.mic.muted;
    await this.disableMic();
    await this.enableMic();
    if (muted) await this.setMicMuted(true);
  }

  // ------------------------------------------------------------------ stats

  private async tick(): Promise<void> {
    if (this.statsBusy || !get().auth) return;
    this.statsBusy = true;
    try {
      const transport = this.transport;
      const sys = await systemMetrics().catch(() => null);
      const reports = transport ? await transport.getStats().catch(() => []) : [];
      const remote = get().remote;
      const tracks = {
        video: remote.find((r) => r.source === 'screen')?.track.id,
        audio: remote.find((r) => r.source === 'screen-audio')?.track.id,
        localVideo: this.screen?.videoPub ? this.screen.video.id : undefined,
      };
      const rtc = transport && reports.length ? this.sampler.sample(reports, tracks) : { t: Date.now(), send: null, recv: null, audio: null, net: null };
      const sample: Sample = { ...rtc, sys };
      if (transport) {
        this.recording.push(sample);
        if (this.recording.length > RECORDING_MAX) this.recording.shift();
      }
      set((s) => ({ latest: sample, history: [...s.history.slice(-(HISTORY - 1)), sample] }));
    } finally {
      this.statsBusy = false;
    }
  }
}

/** Accepts a pasted invite link or a bare code. */
export function extractInviteCode(input: string): string {
  const m = /#\/join\/([A-Za-z0-9-]+)/.exec(input);
  return (m?.[1] ?? input).trim();
}

export const session = new Session();
