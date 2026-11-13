import { Device, type types as msc } from 'mediasoup-client';
import type { JoinResult, Publication } from '../../../shared/protocol.ts';
import type { Signaling } from '../lib/signaling.ts';
import { CODEC_MIME, codecFromMime, sendableCodecs, type CodecName } from './codecs.ts';
import {
  applySenderParams, type EncodingUpdate, type MediaConnectionState, type MediaTransport, type PublishOptions, type TransportConfig,
  type TransportEvents,
} from './transport.ts';

/**
 * SFU path: one upload from the sharer, the server forwards it to every
 * viewer. Uses one send and one receive WebRTC transport per client.
 */
export class SfuTransport implements MediaTransport {
  readonly mode = 'sfu';
  private device = new Device();
  private send?: Promise<msc.Transport>;
  private recv?: Promise<msc.Transport>;
  private states = new Map<string, MediaConnectionState>();
  private producers = new Map<string, msc.Producer>();
  private consumers = new Map<string, msc.Consumer>();
  private closed = false;
  private repairTimer = 0;

  constructor(private sig: Signaling, private join: JoinResult, private ev: TransportEvents, private config: TransportConfig) {}

  async start(): Promise<void> {
    await this.device.load({ routerRtpCapabilities: this.join.routerRtpCapabilities as msc.RtpCapabilities });
  }

  usableVideoCodecs(): CodecName[] {
    const routable = new Set(
      (this.device.rtpCapabilities.codecs ?? []).map((c) => codecFromMime(c.mimeType)).filter((c): c is CodecName => c !== null),
    );
    return sendableCodecs().filter((c) => routable.has(c));
  }

  private transport(direction: 'send' | 'recv'): Promise<msc.Transport> {
    const existing = direction === 'send' ? this.send : this.recv;
    if (existing) return existing;
    const created = this.createTransport(direction);
    if (direction === 'send') this.send = created;
    else this.recv = created;
    return created;
  }

  private async createTransport(direction: 'send' | 'recv'): Promise<msc.Transport> {
    const params = await this.sig.call('media.createTransport', { direction });
    const options: msc.TransportOptions = {
      ...(params as unknown as msc.TransportOptions),
      iceServers: this.join.iceServers,
      iceTransportPolicy: this.config.relayOnly ? 'relay' : 'all',
    };
    const t = direction === 'send' ? this.device.createSendTransport(options) : this.device.createRecvTransport(options);
    if (this.closed) t.close();
    t.on('connect', ({ dtlsParameters }, done, fail) => {
      this.sig.call('media.connectTransport', { transportId: t.id, dtlsParameters }).then(done, fail);
    });
    t.on('produce', ({ kind, rtpParameters, appData }, done, fail) => {
      this.sig
        .call('media.produce', { transportId: t.id, kind, rtpParameters, source: appData.source as PublishOptions['source'] })
        .then(done, fail);
    });
    t.on('connectionstatechange', (state) => {
      if (this.closed) return;
      this.states.set(t.id, state === 'closed' ? 'failed' : state);
      this.ev.onConnectionState(this.aggregateState());
      if (state === 'disconnected' || state === 'failed') void this.repair(t, state === 'failed' ? 0 : 1500);
    });
    return t;
  }

  private aggregateState(): MediaConnectionState {
    const all = [...this.states.values()];
    for (const s of ['failed', 'disconnected', 'connecting', 'new'] as const) if (all.includes(s)) return s;
    return all.length ? 'connected' : 'new';
  }

  /** ICE restart keeps DTLS/SRTP state, so media resumes without renegotiating tracks. */
  private async repair(t: msc.Transport, delayMs: number): Promise<void> {
    await new Promise((r) => setTimeout(r, delayMs));
    if (this.closed || t.connectionState === 'connected') return;
    try {
      const { iceParameters } = await this.sig.call('media.restartIce', { transportId: t.id });
      await t.restartIce({ iceParameters: iceParameters as msc.IceParameters });
    } catch {
      /* signaling is down too: the session rebuilds everything when it returns */
    }
    clearTimeout(this.repairTimer);
    this.repairTimer = window.setTimeout(() => {
      if (!this.closed && this.aggregateState() !== 'connected' && this.sig.state === 'online') this.ev.onUnrecoverable();
    }, 10_000);
  }

  async publish(track: MediaStreamTrack, o: PublishOptions): Promise<string> {
    const t = await this.transport('send');
    const options: msc.ProducerOptions = { track, stopTracks: false, zeroRtpOnPause: true, appData: { source: o.source } };
    if (track.kind === 'video') {
      const mime = o.codec ? CODEC_MIME[o.codec].toLowerCase() : undefined;
      options.codec = this.device.rtpCapabilities.codecs?.find((c) => c.mimeType.toLowerCase() === mime);
      const maxBitrate = o.maxBitrate ?? 8_000_000;
      const full = { maxBitrate, maxFramerate: o.maxFramerate };
      const layered = o.simulcast && (o.codec === 'h264' || o.codec === 'vp8');
      options.encodings = layered
        ? [
            { rid: 'l', scaleResolutionDownBy: 2, maxBitrate: Math.round(maxBitrate * 0.2), maxFramerate: Math.min(o.maxFramerate ?? 30, 30) },
            { rid: 'h', ...full },
          ]
        : [full];
      // libwebrtc treats priority as a per-sender setting: it is only accepted on the first encoding.
      options.encodings[0]!.networkPriority = 'high';
      // Start near the target instead of ramping up from ~300 kbps.
      options.codecOptions = { videoGoogleStartBitrate: Math.min(Math.round((maxBitrate / 1000) * 0.6), 20_000) };
    } else if (o.source === 'screen-audio') {
      options.encodings = [{ maxBitrate: 192_000 }];
      options.codecOptions = { opusStereo: true, opusDtx: false, opusFec: true, opusMaxAverageBitrate: 192_000 };
    } else {
      options.codecOptions = { opusStereo: false, opusDtx: true, opusFec: true, opusMaxAverageBitrate: 48_000 };
    }
    const producer = await t.produce(options);
    this.producers.set(producer.id, producer);
    if (o.degradation) await applySenderParams(producer.rtpSender, { degradation: o.degradation }).catch(() => {});
    return producer.id;
  }

  async unpublish(id: string): Promise<void> {
    const producer = this.producers.get(id);
    this.producers.delete(id);
    producer?.close();
    await this.sig.call('media.unpublish', { id }).catch(() => {});
  }

  async setPaused(id: string, paused: boolean): Promise<void> {
    const producer = this.producers.get(id);
    if (!producer) return;
    if (paused) producer.pause();
    else producer.resume();
    await this.sig.call('media.setPaused', { id, paused });
  }

  async updateEncoding(id: string, update: EncodingUpdate): Promise<void> {
    await applySenderParams(this.producers.get(id)?.rtpSender, update);
  }

  async subscribe(pub: Publication): Promise<void> {
    if (this.consumers.has(pub.id)) return;
    const t = await this.transport('recv');
    const params = await this.sig.call('media.consume', { producerId: pub.id, rtpCapabilities: this.device.rtpCapabilities });
    if (this.closed) return;
    const consumer = await t.consume({
      id: params.id,
      producerId: params.producerId,
      kind: params.kind,
      rtpParameters: params.rtpParameters as msc.RtpParameters,
      // Same stream id => the browser lip-syncs the screen video with its audio.
      streamId: `${pub.source === 'mic' ? 'mic' : 'screen'}-${pub.peerId}`,
    });
    this.consumers.set(pub.id, consumer);
    await this.sig.call('media.resumeConsumer', { consumerId: consumer.id });
    this.ev.onRemoteTrack({ id: pub.id, kind: consumer.kind, track: consumer.track, receiver: consumer.rtpReceiver });
  }

  unsubscribe(publicationId: string): void {
    const consumer = this.consumers.get(publicationId);
    if (!consumer) return;
    this.consumers.delete(publicationId);
    consumer.close();
    this.ev.onRemoteTrackGone(publicationId);
  }

  async setPreferredQuality(publicationId: string, quality: 'auto' | 'low'): Promise<void> {
    const consumer = this.consumers.get(publicationId);
    if (consumer) await this.sig.call('media.setPreferredLayers', { consumerId: consumer.id, spatialLayer: quality === 'low' ? 0 : 1 });
  }

  peerJoined(): void {}
  peerLeft(): void {}

  async getStats(): Promise<RTCStatsReport[]> {
    const transports = await Promise.all([this.send, this.recv].filter((t) => t !== undefined));
    return Promise.all(transports.filter((t) => !t.closed).map((t) => t.getStats()));
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.repairTimer);
    for (const p of [this.send, this.recv]) void p?.then((t) => t.close(), () => {});
    this.producers.clear();
    this.consumers.clear();
  }
}
