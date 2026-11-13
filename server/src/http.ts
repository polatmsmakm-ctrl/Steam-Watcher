import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { AVATAR_COLORS, LIMITS, PROTOCOL_VERSION, type AuthResult, type PublicUser } from '../../shared/protocol.ts';
import { hashPassword, RateLimiter, verifyPassword, type Tokens } from './auth.ts';
import type { Config } from './config.ts';
import type { Db } from './db.ts';
import { bad, forbidden, RpcError, str } from './errors.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2', '.map': 'application/json',
};

const USERNAME_RE = /^[a-zA-Z0-9_.-]+$/;

export function createHttpHandler(deps: {
  config: Config;
  db: Db;
  tokens: Tokens;
  health: () => Promise<unknown>;
}): http.RequestListener {
  const { config, db, tokens } = deps;
  const authLimiter = new RateLimiter(config.authRateLimit, 60_000);

  const routes: Record<string, (body: Record<string, unknown>) => Promise<unknown>> = {
    'POST /api/auth/register': async (body) => {
      const username = str(body.username, 'Username', LIMITS.username.min, LIMITS.username.max);
      if (!USERNAME_RE.test(username)) throw bad('Username may contain letters, digits, _ . -');
      const password = str(body.password, 'Password', LIMITS.password.min, LIMITS.password.max);
      const displayName = str(body.displayName ?? username, 'Display name', LIMITS.displayName.min, LIMITS.displayName.max);
      const user = db.createUser(username, displayName, await hashPassword(password));
      if (!user) throw new RpcError('USERNAME_TAKEN', 'That username is taken');
      return { token: tokens.sign({ sub: user.id }), user } satisfies AuthResult;
    },
    'POST /api/auth/login': async (body) => {
      const creds = typeof body.username === 'string' ? db.credentials(body.username.trim()) : null;
      // Hash even for unknown users so response time does not reveal which usernames exist.
      const ok = await verifyPassword(String(body.password ?? ''), creds?.passHash ?? 'scrypt$16384$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
      if (!creds || !ok) throw new RpcError('BAD_CREDENTIALS', 'Wrong username or password');
      return { token: tokens.sign({ sub: creds.user.id }), user: creds.user } satisfies AuthResult;
    },
    'POST /api/auth/guest': async (body) => {
      if (!config.allowGuests) throw forbidden('Guest access is disabled on this server');
      const displayName = str(body.displayName, 'Display name', LIMITS.displayName.min, LIMITS.displayName.max);
      const id = `guest:${crypto.randomUUID()}`;
      const user: PublicUser = {
        id, username: `guest-${id.slice(6, 12)}`, displayName, guest: true,
        avatarColor: AVATAR_COLORS[crypto.randomInt(AVATAR_COLORS.length)]!,
      };
      return { token: tokens.sign({ sub: id, guest: user }, 60 * 60 * 24), user } satisfies AuthResult;
    },
  };

  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');

    if (url.pathname.startsWith('/api/')) {
      // Bearer tokens only (no cookies), so any origin may call the API — the desktop app's origin is tauri.localhost.
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('access-control-allow-headers', 'content-type');
      if (req.method === 'OPTIONS') return void res.writeHead(204).end();
      try {
        if (req.method === 'GET' && url.pathname === '/api/health') {
          return json(200, { ok: true, name: 'vision-stream', protocol: PROTOCOL_VERSION, allowGuests: config.allowGuests, ...(await deps.health() as object) });
        }
        const route = routes[`${req.method} ${url.pathname}`];
        if (!route) return json(404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
        const ip = req.socket.remoteAddress ?? '?';
        if (!authLimiter.allow(ip)) return json(429, { error: { code: 'RATE_LIMITED', message: 'Too many attempts. Wait a minute.' } });
        return json(200, await route(await readJson(req)));
      } catch (e) {
        if (e instanceof RpcError) return json(e.code === 'FORBIDDEN' ? 403 : 400, { error: { code: e.code, message: e.message } });
        console.error(e);
        return json(500, { error: { code: 'INTERNAL', message: 'Internal error' } });
      }
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return void res.writeHead(405).end();
    try {
      serveStatic(config.webDir, url.pathname, res);
    } catch {
      // e.g. malformed percent-encoding in the path
      if (!res.headersSent) res.writeHead(400);
      res.end();
    }
  };
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 16_384) throw bad('Request too large');
    chunks.push(chunk as Buffer);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw bad('Invalid JSON');
  }
}

/** Serves the built web client (app/dist) so invite links open in any browser. */
function serveStatic(root: string, pathname: string, res: http.ServerResponse): void {
  let file = path.join(root, path.normalize(decodeURIComponent(pathname)));
  if (file !== root && !file.startsWith(root + path.sep)) return void res.writeHead(403).end();
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'index.html');
  if (!fs.existsSync(file)) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return void res.end('VISION STREAM server is running. Web client not built (run `npm run build -w app`).');
  }
  const ext = path.extname(file);
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'cache-control': file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
}
