import type { MediaKind, MediaSource, Publication } from '../../../shared/protocol.ts';
import type { CodecName } from './codecs.ts';

export interface PublishOptions {
  source: MediaSource;
  codec?: CodecName;
  maxBitrate?: number;
  maxFramerate?: number;
  /** Adds a half-resolution layer for viewers on slow links (SFU, H.264/VP8). */
  simulcast?: boolean;
  degradation?: RTCDegradationPreference;
}

export interface EncodingUpdate {
  maxBitrate?: number;
  maxFramerate?: number;
  degradation?: RTCDegradationPreference;
}

export interface RemoteTrack {
  /** Publication id. */
  id: string;
  kind: MediaKind;
  track: MediaStreamTrack;
  receiver?: RTCRtpReceiver;
}

export type MediaConnectionState = 'new' | 'connecting' | 'connected' | 'disconnected' | 'failed';

export interface TransportEvents {
  onRemoteTrack(track: RemoteTrack): void;
  onRemoteTrackGone(publicationId: string): void;
  onConnectionState(state: MediaConnectionState): void;
  /** Media path is beyond ICE-restart repair; the session should rebuild it. */
  onUnrecoverable(): void;
}

/** One media path for a room: through the SFU, or direct peer-to-peer. */
export interface MediaTransport {
  readonly mode: 'sfu' | 'p2p';
  start(): Promise<void>;
  /** Video codecs that can be sent in this room from this device. */
  usableVideoCodecs(): CodecName[];
  publish(track: MediaStreamTrack, opts: PublishOptions): Promise<string>;
  unpublish(id: string): Promise<void>;
  setPaused(id: string, paused: boolean): Promise<void>;
  updateEncoding(id: string, update: EncodingUpdate): Promise<void>;
  subscribe(publication: Publication): Promise<void>;
  unsubscribe(publicationId: string): void;
  /** SFU simulcast only: 'low' pins the half-resolution layer. */
  setPreferredQuality(publicationId: string, quality: 'auto' | 'low'): Promise<void>;
  peerJoined(peerId: string): void;
  peerLeft(peerId: string): void;
  getStats(): Promise<RTCStatsReport[]>;
  close(): void;
}

export async function applySenderParams(sender: RTCRtpSender | undefined, u: EncodingUpdate): Promise<void> {
  if (!sender) return;
  const params = sender.getParameters();
  if (u.degradation) params.degradationPreference = u.degradation;
  const encodings = params.encodings ?? [];
  const top = encodings.length - 1;
  encodings.forEach((enc, i) => {
    // With simulcast the last encoding is full quality; lower layers keep their ratio.
    const ratio = i === top ? 1 : 0.2;
    if (u.maxBitrate) enc.maxBitrate = Math.round(u.maxBitrate * ratio);
    if (u.maxFramerate) enc.maxFramerate = i === top ? u.maxFramerate : Math.min(u.maxFramerate, 30);
  });
  await sender.setParameters(params);
}
