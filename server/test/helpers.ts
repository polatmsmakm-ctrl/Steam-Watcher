import { WebSocket } from 'ws';
import type { AuthResult, EventName, Events, MethodName, Methods } from '../../shared/protocol.ts';
import { startApp, type App } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';

export async function startTestApp(env: Record<string, string> = {}): Promise<App & { url: string }> {
  const config = loadConfig({
    PORT: '0', HOST: '127.0.0.1', LOG_LEVEL: 'silent', JWT_SECRET: 'test-secret', RTC_WORKERS: '1',
    RTC_BASE_PORT: String(41000 + Math.floor(Math.random() * 2000)), RTC_LISTEN_IP: '127.0.0.1', STUN_URLS: '', AUTH_RATE_LIMIT: '1000', ...env,
  });
  const app = await startApp(config, { memoryDb: true });
  return Object.assign(app, { url: `http://127.0.0.1:${app.port}` });
}

export async function api<T = AuthResult>(url: string, path: string, body: unknown): Promise<{ status: number; body: T & { error?: { code: string } } }> {
  const res = await fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() as never };
}

export class Client {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error & { code?: string }) => void }>();
  events: { event: EventName; data: unknown }[] = [];
  private waiters: { event: EventName; resolve: (d: unknown) => void }[] = [];

  private constructor(readonly ws: WebSocket, readonly auth: AuthResult) {
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.event) {
        const i = this.waiters.findIndex((w) => w.event === msg.event);
        if (i >= 0) this.waiters.splice(i, 1)[0]!.resolve(msg.data);
        else this.events.push(msg);
        return;
      }
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.ok) p?.resolve(msg.data);
      else p?.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }));
    });
  }

  static async connect(url: string, auth: AuthResult): Promise<Client> {
    const ws = new WebSocket(url.replace('http', 'ws') + '/ws');
    await new Promise((resolve, reject) => ws.once('open', resolve).once('error', reject));
    const c = new Client(ws, auth);
    await c.call('auth', { token: auth.token, protocol: 1 });
    return c;
  }

  static async register(url: string, username: string): Promise<Client> {
    const r = await api(url, '/api/auth/register', { username, password: 'password123', displayName: username });
    if (r.status !== 200) throw new Error(`register failed: ${JSON.stringify(r.body)}`);
    return Client.connect(url, r.body);
  }

  call<M extends MethodName>(method: M, data: Methods[M][0]): Promise<Methods[M][1]> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as never, reject });
      this.ws.send(JSON.stringify({ id, method, data }));
    });
  }

  /** Resolves with the next (or an already buffered) notification of this type. */
  next<E extends EventName>(event: E, timeoutMs = 2000): Promise<Events[E]> {
    const i = this.events.findIndex((e) => e.event === event);
    if (i >= 0) return Promise.resolve(this.events.splice(i, 1)[0]!.data as Events[E]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs);
      this.waiters.push({ event, resolve: (d) => { clearTimeout(timer); resolve(d as Events[E]); } });
    });
  }

  close(): void {
    this.ws.close();
  }
}

export async function rejects(p: Promise<unknown>, code: string): Promise<void> {
  try {
    await p;
  } catch (e) {
    if ((e as { code?: string }).code === code) return;
    throw new Error(`expected ${code}, got ${(e as { code?: string }).code}: ${(e as Error).message}`);
  }
  throw new Error(`expected rejection with ${code}`);
}
