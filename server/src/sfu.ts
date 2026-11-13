import * as mediasoup from 'mediasoup';
import type { types as ms } from 'mediasoup';
import type { Config } from './config.ts';

/**
 * Codecs the SFU can route, in preference order. mediasoup (3.32) does not
 * route H.265, so HEVC is only available in direct P2P rooms.
 */
const MEDIA_CODECS: ms.RouterRtpCodecCapability[] = [
  { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
  { kind: 'video', mimeType: 'video/AV1', clockRate: 90000 },
  {
    kind: 'video',
    mimeType: 'video/H264',
    clockRate: 90000,
    parameters: { 'packetization-mode': 1, 'profile-level-id': '64001f', 'level-asymmetry-allowed': 1 },
  },
  {
    kind: 'video',
    mimeType: 'video/H264',
    clockRate: 90000,
    parameters: { 'packetization-mode': 1, 'profile-level-id': '4d001f', 'level-asymmetry-allowed': 1 },
  },
  {
    kind: 'video',
    mimeType: 'video/H264',
    clockRate: 90000,
    parameters: { 'packetization-mode': 1, 'profile-level-id': '42e01f', 'level-asymmetry-allowed': 1 },
  },
  { kind: 'video', mimeType: 'video/VP9', clockRate: 90000, parameters: { 'profile-id': 0 } },
  { kind: 'video', mimeType: 'video/VP8', clockRate: 90000 },
];

interface WorkerSlot {
  worker: ms.Worker;
  server: ms.WebRtcServer;
  routers: number;
}

/**
 * Pool of mediasoup workers. Each worker owns one WebRtcServer, so the whole
 * SFU needs exactly `numWorkers` UDP+TCP ports (basePort … basePort+n-1).
 */
export class Sfu {
  private slots: WorkerSlot[] = [];
  private closed = false;

  constructor(private config: Config, private log: (msg: string) => void) {}

  async start(): Promise<void> {
    const { listenIp, announcedAddress, basePort, numWorkers } = this.config.rtc;
    for (let i = 0; i < numWorkers; i++) {
      const worker = await mediasoup.createWorker({ logLevel: 'warn' });
      worker.on('died', () => {
        if (this.closed) return;
        // Rooms on this worker lose their router; clients see transports close and rejoin.
        this.log(`mediasoup worker ${worker.pid} died`);
        this.slots = this.slots.filter((s) => s.worker !== worker);
      });
      const listen = (protocol: 'udp' | 'tcp'): ms.TransportListenInfo => ({
        protocol,
        ip: listenIp,
        port: basePort + i,
        ...(announcedAddress ? { announcedAddress } : {}),
      });
      const server = await worker.createWebRtcServer({ listenInfos: [listen('udp'), listen('tcp')] });
      this.slots.push({ worker, server, routers: 0 });
    }
    this.log(`SFU ready: ${numWorkers} worker(s) on ports ${basePort}-${basePort + numWorkers - 1} (udp+tcp)`);
  }

  async createRouter(): Promise<{ router: ms.Router; webRtcServer: ms.WebRtcServer }> {
    const slot = [...this.slots].sort((a, b) => a.routers - b.routers)[0];
    if (!slot) throw new Error('No SFU workers available');
    const router = await slot.worker.createRouter({ mediaCodecs: MEDIA_CODECS });
    slot.routers++;
    router.observer.once('close', () => slot.routers--);
    return { router, webRtcServer: slot.server };
  }

  async createTransport(router: ms.Router, webRtcServer: ms.WebRtcServer, direction: 'send' | 'recv'): Promise<ms.WebRtcTransport> {
    const transport = await router.createWebRtcTransport({
      webRtcServer,
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      initialAvailableOutgoingBitrate: this.config.rtc.initialOutgoingBitrate,
      appData: { direction },
    });
    if (direction === 'send') await transport.setMaxIncomingBitrate(this.config.rtc.maxIncomingBitrate);
    return transport;
  }

  async resourceUsage(): Promise<{ pid: number; routers: number; cpuUserMs: number; cpuSystemMs: number; maxRssKb: number }[]> {
    return Promise.all(
      this.slots.map(async (s) => {
        const u = await s.worker.getResourceUsage();
        return { pid: s.worker.pid, routers: s.routers, cpuUserMs: u.ru_utime, cpuSystemMs: u.ru_stime, maxRssKb: u.ru_maxrss };
      }),
    );
  }

  close(): void {
    this.closed = true;
    for (const s of this.slots) s.worker.close();
    this.slots = [];
  }
}
