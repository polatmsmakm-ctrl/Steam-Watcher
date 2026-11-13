import type { SystemMetrics } from '../lib/platform.ts';

/* Every number here is read from RTCPeerConnection.getStats() — nothing is synthesised. */

export interface VideoSendStats {
  codec: string;
  encoder: string;
  /** `powerEfficientEncoder` from the browser: true = hardware (e.g. NVENC), null = not reported. */
  hardware: boolean | null;
  width: number;
  height: number;
  /** Frames actually encoded and sent per second. */
  fps: number;
  /** Frames per second delivered by screen capture. */
  captureFps: number;
  bitrateKbps: number;
  targetKbps: number;
  /** Average encode time per frame over the last interval. */
  encodeMs: number;
  /** Captured frames that were not encoded during the interval. */
  framesDropped: number;
  /** 'none' | 'cpu' | 'bandwidth' | 'other' */
  limitation: string;
  layers: number;
  nack: number;
  pli: number;
  /** Receiver-reported, i.e. as seen by the SFU or the remote peer. */
  remoteLossPct: number;
  remoteJitterMs: number;
}

export interface VideoRecvStats {
  codec: string;
  decoder: string;
  hardware: boolean | null;
  width: number;
  height: number;
  fps: number;
  bitrateKbps: number;
  jitterMs: number;
  lossPct: number;
  packetsLost: number;
  framesDropped: number;
  freezes: number;
  decodeMs: number;
  /** Time frames wait in the jitter buffer. */
  jitterBufferMs: number;
  /** Packet arrival -> decoded frame (jitter buffer + decode). */
  processingMs: number;
  nack: number;
  pli: number;
  /** Video playout position minus audio playout position; null without stream audio. */
  avOffsetMs: number | null;
}

export interface NetStats {
  rttMs: number;
  availableOutKbps: number | null;
  localCandidate: string;
  remoteCandidate: string;
  protocol: string;
  /** True when media flows through a TURN relay. */
  relayed: boolean;
  sentKbps: number;
  recvKbps: number;
}

export interface AudioRecvStats {
  bitrateKbps: number;
  jitterMs: number;
  lossPct: number;
  concealedPct: number;
}

export interface Sample {
  t: number;
  send: VideoSendStats | null;
  recv: VideoRecvStats | null;
  audio: AudioRecvStats | null;
  net: NetStats | null;
  sys: SystemMetrics | null;
}

type Raw = Record<string, any>; // RTCStats dictionaries are open-ended

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export class StatsSampler {
  private prev = new Map<string, Raw>();
  private prevTime = 0;

  reset(): void {
    this.prev.clear();
    this.prevTime = 0;
  }

  /**
   * @param tracks ids of the remote screen tracks being played. Needed because a
   * receive transport also carries other inbound streams (voice, the SFU's
   * bandwidth-probing stream, receivers of streams that just ended).
   */
  sample(reports: RTCStatsReport[], tracks: { video?: string; audio?: string } = {}): Omit<Sample, 'sys'> {
    const now = performance.now();
    const dt = this.prevTime ? (now - this.prevTime) / 1000 : 0;
    this.prevTime = now;

    const all = new Map<string, Raw>();
    for (const report of reports) report.forEach((s: Raw) => all.set(s.id, s));
    const prev = this.prev;
    this.prev = all;

    const delta = (s: Raw, key: string): number => {
      const before = prev.get(s.id);
      return before ? Math.max(0, num(s[key]) - num(before[key])) : 0;
    };
    const rate = (s: Raw, key: string): number => (dt > 0 ? delta(s, key) / dt : 0);
    const codecOf = (s: Raw): string => String(all.get(s.codecId)?.mimeType ?? '').replace(/^(video|audio)\//, '');
    const stats = [...all.values()];

    // ---- outbound video (the screen we share) ----
    let send: VideoSendStats | null = null;
    const outs = stats.filter((s) => s.type === 'outbound-rtp' && s.kind === 'video' && num(s.packetsSent) > 0);
    if (outs.length) {
      const top = outs.reduce((a, b) => (num(b.frameHeight) > num(a.frameHeight) ? b : a));
      const source = all.get(top.mediaSourceId);
      const remotes = stats.filter((s) => s.type === 'remote-inbound-rtp' && s.kind === 'video');
      const framesEncoded = delta(top, 'framesEncoded');
      send = {
        codec: codecOf(top),
        encoder: String(top.encoderImplementation ?? ''),
        hardware: typeof top.powerEfficientEncoder === 'boolean' ? top.powerEfficientEncoder : null,
        width: num(top.frameWidth),
        height: num(top.frameHeight),
        fps: dt > 0 ? framesEncoded / dt : num(top.framesPerSecond),
        captureFps: source ? rate(source, 'frames') : 0,
        bitrateKbps: outs.reduce((sum, s) => sum + rate(s, 'bytesSent'), 0) * 8 / 1000,
        targetKbps: outs.reduce((sum, s) => sum + num(s.targetBitrate), 0) / 1000,
        encodeMs: framesEncoded > 0 ? (delta(top, 'totalEncodeTime') / framesEncoded) * 1000 : 0,
        framesDropped: source && prev.has(source.id) ? Math.max(0, delta(source, 'frames') - framesEncoded) : 0,
        limitation: String(top.qualityLimitationReason ?? 'none'),
        layers: outs.length,
        nack: outs.reduce((sum, s) => sum + delta(s, 'nackCount'), 0),
        pli: outs.reduce((sum, s) => sum + delta(s, 'pliCount'), 0),
        remoteLossPct: remotes.length ? Math.max(...remotes.map((r) => num(r.fractionLost))) * 100 : 0,
        remoteJitterMs: remotes.length ? Math.max(...remotes.map((r) => num(r.jitter))) * 1000 : 0,
      };
    }

    // ---- inbound video (the screen we watch) ----
    let recv: VideoRecvStats | null = null;
    const inbound = stats.filter((s) => s.type === 'inbound-rtp');
    const vin = inbound.find((s) => s.kind === 'video' && tracks.video !== undefined && s.trackIdentifier === tracks.video);
    const screenAudio = inbound.find((s) => s.kind === 'audio' && tracks.audio !== undefined && s.trackIdentifier === tracks.audio);
    if (vin) {
      const lost = delta(vin, 'packetsLost');
      const received = delta(vin, 'packetsReceived');
      const decoded = delta(vin, 'framesDecoded');
      const emitted = delta(vin, 'jitterBufferEmittedCount');
      const both = screenAudio && num(vin.estimatedPlayoutTimestamp) > 0 && num(screenAudio.estimatedPlayoutTimestamp) > 0;
      recv = {
        codec: codecOf(vin),
        decoder: String(vin.decoderImplementation ?? ''),
        hardware: typeof vin.powerEfficientDecoder === 'boolean' ? vin.powerEfficientDecoder : null,
        width: num(vin.frameWidth),
        height: num(vin.frameHeight),
        fps: dt > 0 ? decoded / dt : num(vin.framesPerSecond),
        bitrateKbps: rate(vin, 'bytesReceived') * 8 / 1000,
        jitterMs: num(vin.jitter) * 1000,
        lossPct: lost + received > 0 ? (lost / (lost + received)) * 100 : 0,
        packetsLost: lost,
        framesDropped: delta(vin, 'framesDropped'),
        freezes: delta(vin, 'freezeCount'),
        decodeMs: decoded > 0 ? (delta(vin, 'totalDecodeTime') / decoded) * 1000 : 0,
        jitterBufferMs: emitted > 0 ? (delta(vin, 'jitterBufferDelay') / emitted) * 1000 : 0,
        processingMs: decoded > 0 ? (delta(vin, 'totalProcessingDelay') / decoded) * 1000 : 0,
        nack: delta(vin, 'nackCount'),
        pli: delta(vin, 'pliCount'),
        avOffsetMs: both ? num(vin.estimatedPlayoutTimestamp) - num(screenAudio.estimatedPlayoutTimestamp) : null,
      };
    }

    // ---- inbound audio (stream audio if present, else the first voice track) ----
    let audio: AudioRecvStats | null = null;
    const ain = screenAudio ?? inbound.find((s) => s.kind === 'audio' && num(s.packetsReceived) > 0);
    if (ain) {
      const lost = delta(ain, 'packetsLost');
      const received = delta(ain, 'packetsReceived');
      const samples = delta(ain, 'totalSamplesReceived');
      audio = {
        bitrateKbps: rate(ain, 'bytesReceived') * 8 / 1000,
        jitterMs: num(ain.jitter) * 1000,
        lossPct: lost + received > 0 ? (lost / (lost + received)) * 100 : 0,
        concealedPct: samples > 0 ? (delta(ain, 'concealedSamples') / samples) * 100 : 0,
      };
    }

    // ---- network path: the ICE candidate pair(s) in use ----
    let net: NetStats | null = null;
    const transports = stats.filter((s) => s.type === 'transport');
    const pairs = transports
      .map((t) => all.get(t.selectedCandidatePairId))
      .filter((p): p is Raw => Boolean(p));
    if (!pairs.length) pairs.push(...stats.filter((s) => s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded'));
    if (pairs.length) {
      // SFU mode has one pair per direction; report the one carrying the most traffic for path details.
      const main = pairs.reduce((a, b) => (num(b.bytesSent) + num(b.bytesReceived) > num(a.bytesSent) + num(a.bytesReceived) ? b : a));
      const local = all.get(main.localCandidateId);
      const remote = all.get(main.remoteCandidateId);
      const available = pairs.map((p) => p.availableOutgoingBitrate).find((v) => typeof v === 'number');
      net = {
        rttMs: Math.max(...pairs.map((p) => num(p.currentRoundTripTime))) * 1000,
        availableOutKbps: typeof available === 'number' ? available / 1000 : null,
        localCandidate: String(local?.candidateType ?? '?'),
        remoteCandidate: String(remote?.candidateType ?? '?'),
        protocol: String(local?.protocol ?? '?'),
        relayed: local?.candidateType === 'relay' || remote?.candidateType === 'relay',
        sentKbps: pairs.reduce((sum, p) => sum + rate(p, 'bytesSent'), 0) * 8 / 1000,
        recvKbps: pairs.reduce((sum, p) => sum + rate(p, 'bytesReceived'), 0) * 8 / 1000,
      };
    }

    return { t: Date.now(), send, recv, audio, net };
  }
}

/** Flattens samples for the CSV export on the Performance screen. */
export function samplesToCsv(samples: Sample[]): string {
  const cols: [string, (s: Sample) => unknown][] = [
    ['time', (s) => new Date(s.t).toISOString()],
    ['send_codec', (s) => s.send?.codec], ['send_encoder', (s) => s.send?.encoder], ['send_hw', (s) => s.send?.hardware],
    ['send_width', (s) => s.send?.width], ['send_height', (s) => s.send?.height],
    ['send_fps', (s) => s.send?.fps.toFixed(1)], ['capture_fps', (s) => s.send?.captureFps.toFixed(1)],
    ['send_kbps', (s) => s.send?.bitrateKbps.toFixed(0)], ['encode_ms', (s) => s.send?.encodeMs.toFixed(2)],
    ['send_dropped', (s) => s.send?.framesDropped], ['limitation', (s) => s.send?.limitation],
    ['recv_codec', (s) => s.recv?.codec], ['recv_decoder', (s) => s.recv?.decoder],
    ['recv_width', (s) => s.recv?.width], ['recv_height', (s) => s.recv?.height],
    ['recv_fps', (s) => s.recv?.fps.toFixed(1)], ['recv_kbps', (s) => s.recv?.bitrateKbps.toFixed(0)],
    ['decode_ms', (s) => s.recv?.decodeMs.toFixed(2)], ['jitter_buffer_ms', (s) => s.recv?.jitterBufferMs.toFixed(1)],
    ['recv_jitter_ms', (s) => s.recv?.jitterMs.toFixed(2)], ['recv_loss_pct', (s) => s.recv?.lossPct.toFixed(2)],
    ['recv_dropped', (s) => s.recv?.framesDropped], ['freezes', (s) => s.recv?.freezes], ['av_offset_ms', (s) => s.recv?.avOffsetMs?.toFixed(0)],
    ['rtt_ms', (s) => s.net?.rttMs.toFixed(1)], ['relayed', (s) => s.net?.relayed],
    ['cpu_pct', (s) => s.sys?.cpu.toFixed(1)], ['app_mem_mb', (s) => s.sys?.appMemoryMb.toFixed(0)],
    ['gpu_pct', (s) => s.sys?.gpu?.utilization], ['gpu_enc_pct', (s) => s.sys?.gpu?.encoderUtilization],
  ];
  const lines = [cols.map(([name]) => name).join(',')];
  for (const s of samples) lines.push(cols.map(([, get]) => get(s) ?? '').join(','));
  return lines.join('\n');
}
