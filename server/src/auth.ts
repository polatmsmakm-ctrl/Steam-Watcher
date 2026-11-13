import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { PublicUser } from '../../shared/protocol.ts';
import type { Config } from './config.ts';

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** scrypt password hash: `scrypt$N$salt$hash`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt);
  return `scrypt$16384$${b64u(salt)}$${b64u(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, , saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64url');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64url'));
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function scrypt(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    crypto.scrypt(password.normalize('NFKC'), salt, 32, { N: 16384, r: 8, p: 1 }, (e, k) =>
      e ? reject(e) : resolve(k),
    ),
  );
}

export interface TokenPayload {
  sub: string;
  exp: number;
  /** Guests are not stored server-side; their profile travels in the token. */
  guest?: PublicUser;
}

/** Minimal HS256 JWT. */
export class Tokens {
  private secret: Buffer;

  constructor(config: Config) {
    this.secret = Buffer.from(config.jwtSecret || loadOrCreateSecret(config.dataDir));
    this.ttl = config.tokenTtlSec;
  }
  private ttl: number;

  sign(payload: Omit<TokenPayload, 'exp'>, ttlSec = this.ttl): string {
    const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const body = b64u(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec }));
    return `${head}.${body}.${this.mac(`${head}.${body}`)}`;
  }

  verify(token: string): TokenPayload | null {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [head, body, sig] = parts as [string, string, string];
    const expected = Buffer.from(this.mac(`${head}.${body}`));
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
    try {
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as TokenPayload;
      if (typeof payload.sub !== 'string' || typeof payload.exp !== 'number') return null;
      if (payload.exp * 1000 < Date.now()) return null;
      return payload;
    } catch {
      return null;
    }
  }

  private mac(data: string): string {
    return crypto.createHmac('sha256', this.secret).update(data).digest('base64url');
  }
}

function loadOrCreateSecret(dataDir: string): string {
  const file = path.join(dataDir, 'jwt.secret');
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    fs.mkdirSync(dataDir, { recursive: true });
    const secret = crypto.randomBytes(48).toString('base64url');
    fs.writeFileSync(file, secret, { mode: 0o600 });
    return secret;
  }
}

const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; // no 0/O/1/I/L
export function randomCode(length: number): string {
  let out = '';
  while (out.length < length) {
    for (const byte of crypto.randomBytes(length * 2)) {
      // rejection sampling keeps the distribution uniform
      if (byte < 248 && out.length < length) out += ALPHABET[byte % 31];
    }
  }
  return out;
}

export function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Sliding-window limiter keyed by an arbitrary string (IP, connection id…). */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private max: number, private windowMs: number) {}

  allow(key: string): boolean {
    const now = Date.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) this.hits.clear();
    return true;
  }
}
