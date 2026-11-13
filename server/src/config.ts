import os from 'node:os';
import path from 'node:path';

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  /** Empty => derived per request from the Host header. */
  publicUrl: string;
  jwtSecret: string;
  tokenTtlSec: number;
  allowGuests: boolean;
  /** Auth attempts allowed per IP per minute. */
  authRateLimit: number;
  tlsCert: string;
  tlsKey: string;
  webDir: string;
  maxRoomParticipants: number;
  emptyRoomTtlMs: number;
  rtc: {
    listenIp: string;
    announcedAddress: string;
    basePort: number;
    numWorkers: number;
    maxIncomingBitrate: number;
    initialOutgoingBitrate: number;
  };
  ice: {
    stunUrls: string[];
    turnUrls: string[];
    /** coturn `static-auth-secret`; credentials are minted per join and expire. */
    turnSecret: string;
    turnTtlSec: number;
  };
  logLevel: 'silent' | 'info' | 'debug';
}

const list = (v: string | undefined): string[] =>
  (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const int = (v: string | undefined, d: number): number => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : d;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    host: env.HOST ?? '0.0.0.0',
    port: int(env.PORT, 8080),
    dataDir: path.resolve(env.DATA_DIR ?? './data'),
    publicUrl: (env.PUBLIC_URL ?? '').replace(/\/+$/, ''),
    jwtSecret: env.JWT_SECRET ?? '',
    tokenTtlSec: int(env.TOKEN_TTL_SEC, 60 * 60 * 24 * 30),
    allowGuests: (env.ALLOW_GUESTS ?? 'true') !== 'false',
    authRateLimit: int(env.AUTH_RATE_LIMIT, 10),
    tlsCert: env.TLS_CERT ?? '',
    tlsKey: env.TLS_KEY ?? '',
    webDir: path.resolve(env.WEB_DIR ?? path.join(import.meta.dirname, '../../app/dist')),
    maxRoomParticipants: int(env.MAX_ROOM_PARTICIPANTS, 50),
    emptyRoomTtlMs: int(env.EMPTY_ROOM_TTL_SEC, 120) * 1000,
    rtc: {
      listenIp: env.RTC_LISTEN_IP ?? '0.0.0.0',
      announcedAddress: env.RTC_ANNOUNCED_ADDRESS ?? '',
      basePort: int(env.RTC_BASE_PORT, 40000),
      numWorkers: Math.max(1, int(env.RTC_WORKERS, Math.min(os.availableParallelism(), 4))),
      maxIncomingBitrate: int(env.RTC_MAX_INCOMING_BITRATE, 100_000_000),
      initialOutgoingBitrate: int(env.RTC_INITIAL_OUTGOING_BITRATE, 6_000_000),
    },
    ice: {
      stunUrls: list(env.STUN_URLS ?? 'stun:stun.l.google.com:19302'),
      turnUrls: list(env.TURN_URLS),
      turnSecret: env.TURN_SECRET ?? '',
      turnTtlSec: int(env.TURN_TTL_SEC, 6 * 60 * 60),
    },
    logLevel: (env.LOG_LEVEL as Config['logLevel']) ?? 'info',
  };
}
