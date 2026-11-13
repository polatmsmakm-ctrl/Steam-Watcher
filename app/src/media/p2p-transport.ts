import type { JoinResult, Publication } from '../../../shared/protocol.ts';
import type { Signaling } from '../lib/signaling.ts';
import { CODEC_MIME, sendableCodecs, type CodecName } from './codecs.ts';
import {
  applySenderParams, type EncodingUpdate, type MediaTransport, type PublishOptions, type TransportEvents,
} from './transport.ts';

interface LocalPub {
  track: MediaStreamTrack;
  opts: PublishOptions;
  transceiver?: RTCRtpTransceiver;
}

interface Signal {
  description?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
  /** transceiver mid -> publication id, so the receiver can label incoming tracks. */
  mids?: Record<string, string>;
}

/**
 * Direct path for 1:1 rooms: a single RTCPeerConnection between the two
 * participants (STUN for NAT traversal, TURN relay as fallback). No server
 * touches the media, so every codec both ends support is available — HEVC
 * included — and there is no SFU hop adding latency.
 */
export class P2pTransport implements MediaTransport {
  readonly mode = 'p2p';
  private pc?: RTCPeerConnection;
  private remotePeerId?: string;
  private local = new Map<string, LocalPub>();
  private remoteMids = new Map<string, string>();
  private remoteTracks = new Map<string, MediaStreamTrack>();
  private wanted = new Set<string>();
  private groups = new Map<string, MediaStream>();
  private makingOffer = false;
  private ignoreOffer = false;
  private offSignal: () => void;
  private closed = false;

  constructor(private sig: Signaling, private join: JoinResult, private ev: TransportEvents) {
    this.offSignal = sig.on('p2p.signal', ({ from, data }) => {
      if (from === this.remotePeerId) void this.onSignal(data as Signal).catch((e) => console.warn('p2p signal failed', e));
    });
  }

  async start(): Promise<void> {
    const other = this.join.room.peers.find((p) => p.peerId !== this.join.peerId);
    if (other) this.peerJoined(other.peerId);
  }

  usableVideoCodecs(): CodecName[] {
    return sendableCodecs();
  }

  peerJoined(peerId: string): void {
    if (this.closed) return;
    this.teardownPeer();
    this.remotePeerId = peerId;
    const pc = new RTCPeerConnection({ iceServers: this.join.iceServers });
    this.pc = pc;
    pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        await pc.setLocalDescription();
        this.signal({ description: pc.localDescription!.toJSON(), mids: this.localMids() });
      } catch (e) {
        console.warn('p2p offer failed', e);
      } finally {
        this.makingOffer = false;
      }
    };
    pc.onicecandidate = ({ candidate }) => candidate && this.signal({ candidate: candidate.toJSON() });
    pc.ontrack = ({ track, transceiver, receiver }) => {
      const id = transceiver.mid ? this.remoteMids.get(transceiver.mid) : undefined;
      if (!id) return;
      this.remoteTracks.set(id, track);
      if (this.wanted.has(id)) this.ev.onRemoteTrack({ id, kind: track.kind as 'audio' | 'video', track, receiver });
    };
    pc.onconnectionstatechange = () => {
      if (this.pc !== pc) return;
      const s = pc.connectionState;
      if (s !== 'closed') this.ev.onConnectionState(s);
      // restartIce() triggers a fresh offer with new ICE credentials; DTLS state is kept.
      if (s === 'failed') pc.restartIce();
    };
    pc.oniceconnectionstatechange = () => {
      if (this.pc === pc && pc.iceConnectionState === 'disconnected') {
        setTimeout(() => this.pc === pc && pc.iceConnectionState === 'disconnected' && pc.restartIce(), 2000);
      }
    };
    for (const pub of this.local.values()) this.attach(pub);
  }

  peerLeft(peerId: string): void {
    if (peerId === this.remotePeerId) this.teardownPeer();
  }

  private teardownPeer(): void {
    for (const id of this.remoteTracks.keys()) this.ev.onRemoteTrackGone(id);
    this.remoteTracks.clear();
    this.remoteMids.clear();
    this.wanted.clear();
    for (const pub of this.local.values()) pub.transceiver = undefined;
    this.pc?.close();
    this.pc = undefined;
    this.remotePeerId = undefined;
    this.groups.clear();
  }

  private signal(data: Signal): void {
    if (this.remotePeerId) void this.sig.call('p2p.signal', { to: this.remotePeerId, data }).catch(() => {});
  }

  private localMids(): Record<string, string> {
    const mids: Record<string, string> = {};
    for (const [id, pub] of this.local) if (pub.transceiver?.mid) mids[pub.transceiver.mid] = id;
    return mids;
  }

  /** Perfect-negotiation pattern: either side may offer; the polite side yields on glare. */
  private async onSignal({ description, candidate, mids }: Signal): Promise<void> {
    const pc = this.pc;
    if (!pc) return;
    if (description) {
      const polite = this.join.peerId > this.remotePeerId!;
      const collision = description.type === 'offer' && (this.makingOffer || pc.signalingState !== 'stable');
      this.ignoreOffer = !polite && collision;
      if (this.ignoreOffer) return;
      for (const [mid, id] of Object.entries(mids ?? {})) this.remoteMids.set(mid, id);
      await pc.setRemoteDescription(this.withStartBitrate(description));
      if (description.type === 'offer') {
        await pc.setLocalDescription();
        this.signal({ description: pc.localDescription!.toJSON(), mids: this.localMids() });
      }
    } else if (candidate) {
      try {
        await pc.addIceCandidate(candidate);
      } catch (e) {
        if (!this.ignoreOffer) throw e;
      }
    }
  }

  /**
   * WebRTC starts every video encoder at ~300 kbps and probes upward, which
   * makes the first seconds of a 1080p+ share blurry. `x-google-start-bitrate`
   * on the remote description tells our encoder where to start instead (the
   * same hint mediasoup-client applies in SFU rooms). Congestion control still
   * backs off if the link cannot carry it.
   */
  private withStartBitrate(description: RTCSessionDescriptionInit): RTCSessionDescriptionInit {
    const video = [...this.local.values()].find((p) => p.track.kind === 'video');
    if (!video?.opts.maxBitrate || !description.sdp) return description;
    const startKbps = Math.min(Math.round((video.opts.maxBitrate / 1000) * 0.6), 20_000);
    let inVideo = false;
    const withFmtp = new Set<string>();
    const lines = description.sdp.split('\r\n');
    for (const line of lines) {
      if (line.startsWith('m=')) inVideo = line.startsWith('m=video');
      const m = inVideo ? /^a=fmtp:(\d+) /.exec(line) : null;
      if (m) withFmtp.add(m[1]!);
    }
    inVideo = false;
    const out: string[] = [];
    for (const line of lines) {
      if (line.startsWith('m=')) inVideo = line.startsWith('m=video');
      if (!inVideo) {
        out.push(line);
        continue;
      }
      const fmtp = /^a=fmtp:(\d+) (.*)$/.exec(line);
      const rtpmap = /^a=rtpmap:(\d+) (VP8|VP9|H264|H265|AV1)\//i.exec(line);
      if (fmtp && !/apt=/.test(fmtp[2]!)) out.push(`${line};x-google-start-bitrate=${startKbps}`);
      else {
        out.push(line);
        // Codecs without an fmtp line (VP8, AV1 in some builds) need one to carry the hint.
        if (rtpmap && !withFmtp.has(rtpmap[1]!)) out.push(`a=fmtp:${rtpmap[1]} x-google-start-bitrate=${startKbps}`);
      }
    }
    return { type: description.type, sdp: out.join('\r\n') };
  }

  private attach(pub: LocalPub): void {
    const pc = this.pc;
    if (!pc) return;
    const { opts, track } = pub;
    // Screen video and its audio share one stream id so the receiver lip-syncs them.
    const groupKey = opts.source === 'mic' ? 'mic' : 'screen';
    let group = this.groups.get(groupKey);
    if (!group) this.groups.set(groupKey, (group = new MediaStream()));
    const transceiver = pc.addTransceiver(track, {
      direction: 'sendonly',
      streams: [group],
      sendEncodings: [
        track.kind === 'video'
          ? { maxBitrate: opts.maxBitrate, maxFramerate: opts.maxFramerate, networkPriority: 'high' }
          : { maxBitrate: opts.source === 'screen-audio' ? 192_000 : 48_000 },
      ],
    });
    if (track.kind === 'video' && opts.codec) {
      const want = CODEC_MIME[opts.codec].toLowerCase();
      const all = RTCRtpSender.getCapabilities('video')?.codecs ?? [];
      const preferred = [...all.filter((c) => c.mimeType.toLowerCase() === want), ...all.filter((c) => c.mimeType.toLowerCase() !== want)];
      try {
        transceiver.setCodecPreferences(preferred);
      } catch (e) {
        console.warn('codec preference rejected', e);
      }
    }
    pub.transceiver = transceiver;
    if (opts.degradation) void applySenderParams(transceiver.sender, { degradation: opts.degradation }).catch(() => {});
  }

  async publish(track: MediaStreamTrack, opts: PublishOptions): Promise<string> {
    const id = crypto.randomUUID();
    await this.sig.call('media.publish', { id, kind: track.kind as 'audio' | 'video', source: opts.source });
    const pub: LocalPub = { track, opts };
    this.local.set(id, pub);
    this.attach(pub);
    return id;
  }

  async unpublish(id: string): Promise<void> {
    const pub = this.local.get(id);
    this.local.delete(id);
    if (pub?.transceiver && this.pc) {
      this.pc.removeTrack(pub.transceiver.sender);
      pub.transceiver.stop();
    }
    await this.sig.call('media.unpublish', { id }).catch(() => {});
  }

  async setPaused(id: string, paused: boolean): Promise<void> {
    const pub = this.local.get(id);
    if (!pub) return;
    await pub.transceiver?.sender.replaceTrack(paused ? null : pub.track);
    await this.sig.call('media.setPaused', { id, paused });
  }

  async updateEncoding(id: string, update: EncodingUpdate): Promise<void> {
    const pub = this.local.get(id);
    if (!pub) return;
    Object.assign(pub.opts, update);
    await applySenderParams(pub.transceiver?.sender, update);
  }

  async subscribe(pub: Publication): Promise<void> {
    this.wanted.add(pub.id);
    const track = this.remoteTracks.get(pub.id);
    if (track) {
      const receiver = this.pc?.getReceivers().find((r) => r.track === track);
      this.ev.onRemoteTrack({ id: pub.id, kind: pub.kind, track, receiver });
    }
  }

  unsubscribe(publicationId: string): void {
    this.wanted.delete(publicationId);
    if (this.remoteTracks.delete(publicationId)) this.ev.onRemoteTrackGone(publicationId);
  }

  async setPreferredQuality(): Promise<void> {}

  async getStats(): Promise<RTCStatsReport[]> {
    return this.pc ? [await this.pc.getStats()] : [];
  }

  close(): void {
    this.closed = true;
    this.offSignal();
    this.teardownPeer();
    this.local.clear();
  }
}
