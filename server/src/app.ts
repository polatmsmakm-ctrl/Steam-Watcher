import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { Tokens } from './auth.ts';
import type { Config } from './config.ts';
import { Db } from './db.ts';
import { Hub } from './hub.ts';
import { createHttpHandler } from './http.ts';
import { RoomManager } from './rooms.ts';
import { Sfu } from './sfu.ts';

export interface App {
  port: number;
  close(): Promise<void>;
}

export async function startApp(config: Config, opts: { memoryDb?: boolean } = {}): Promise<App> {
  const log = (msg: string) => {
    if (config.logLevel !== 'silent') console.log(`[${new Date().toISOString()}] ${msg}`);
  };
  const db = new Db(opts.memoryDb ? ':memory:' : config.dataDir);
  const tokens = new Tokens(config);
  const sfu = new Sfu(config, log);
  await sfu.start();
  const rooms = new RoomManager(config, sfu, log);
  const hub = new Hub(db, tokens, rooms, sfu, log);

  const handler = createHttpHandler({
    config, db, tokens,
    health: async () => ({ ...hub.stats, uptimeSec: Math.round(process.uptime()), workers: await sfu.resourceUsage() }),
  });
  const tls = Boolean(config.tlsCert && config.tlsKey);
  const server = tls
    ? https.createServer({ cert: fs.readFileSync(config.tlsCert), key: fs.readFileSync(config.tlsKey) }, handler)
    : http.createServer(handler);

  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url ?? '/', 'http://x').pathname !== '/ws') return socket.destroy();
    const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0] ?? (tls ? 'https' : 'http');
    const origin = `${proto}://${req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost'}`;
    wss.handleUpgrade(req, socket, head, (ws) => hub.accept(ws, origin));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });
  const port = (server.address() as AddressInfo).port;
  log(`VISION STREAM server listening on ${tls ? 'https' : 'http'}://${config.host}:${port}`);
  if (!tls) log('TLS is off: terminate HTTPS/WSS at a reverse proxy (or set TLS_CERT/TLS_KEY) before exposing this to the internet.');

  return {
    port,
    async close() {
      hub.close();
      rooms.closeAll();
      wss.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      sfu.close();
      db.close();
    },
  };
}
