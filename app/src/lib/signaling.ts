import { PROTOCOL_VERSION, type EventName, type Events, type MethodName, type Methods } from '../../../shared/protocol.ts';

export class RpcFailure extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export type SignalState = 'offline' | 'connecting' | 'online';

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: number;
}

/**
 * WebSocket RPC client. Reconnects with exponential backoff and
 * re-authenticates; `onState('online')` fires after every successful auth,
 * which is the cue for the room session to rejoin.
 */
export class Signaling {
  state: SignalState = 'offline';
  onState: (state: SignalState) => void = () => {};
  /** Token rejected or protocol mismatch: reconnecting will not help. */
  onFatal: (error: RpcFailure) => void = () => {};

  private ws?: WebSocket;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private listeners = new Map<string, Set<(data: never) => void>>();
  private wanted = false;
  private attempt = 0;
  private retryTimer = 0;
  private url = '';
  private token = '';

  start(serverUrl: string, token: string): void {
    this.stop();
    this.url = serverUrl.replace(/^http/, 'ws').replace(/\/+$/, '') + '/ws';
    this.token = token;
    this.wanted = true;
    this.attempt = 0;
    this.open();
  }

  stop(): void {
    this.wanted = false;
    clearTimeout(this.retryTimer);
    const ws = this.ws;
    this.ws = undefined;
    ws?.close();
    this.failPending('Disconnected');
    this.setState('offline');
  }

  /** Test hook / "simulate network drop": closes the socket but keeps auto-reconnect on. */
  dropConnection(): void {
    this.ws?.close();
  }

  on<E extends EventName>(event: E, fn: (data: Events[E]) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(fn as never);
    return () => set.delete(fn as never);
  }

  call<M extends MethodName>(method: M, data: Methods[M][0], timeoutMs = 12_000): Promise<Methods[M][1]> {
    if (this.state !== 'online') return Promise.reject(new RpcFailure('OFFLINE', 'Not connected to the server'));
    return this.send(method, data, timeoutMs);
  }

  private send<M extends MethodName>(method: M, data: Methods[M][0], timeoutMs: number): Promise<Methods[M][1]> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new RpcFailure('OFFLINE', 'Not connected to the server'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcFailure('TIMEOUT', `Server did not answer ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as never, reject, timer });
      ws.send(JSON.stringify({ id, method, data }));
    });
  }

  private open(): void {
    this.setState('connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      return this.scheduleRetry();
    }
    this.ws = ws;
    ws.onopen = async () => {
      try {
        await this.send('auth', { token: this.token, protocol: PROTOCOL_VERSION }, 8000);
        if (this.ws !== ws) return;
        this.attempt = 0;
        this.setState('online');
      } catch (e) {
        if (e instanceof RpcFailure && (e.code === 'UNAUTHENTICATED' || e.code === 'PROTOCOL_MISMATCH')) {
          this.stop();
          this.onFatal(e);
        } else ws.close();
      }
    };
    ws.onmessage = (ev) => {
      let msg: { id?: number; ok?: boolean; data?: unknown; error?: { code: string; message: string }; event?: string };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.event) {
        for (const fn of this.listeners.get(msg.event) ?? []) (fn as (d: unknown) => void)(msg.data);
        return;
      }
      const p = msg.id === undefined ? undefined : this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id!);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.data);
      else p.reject(new RpcFailure(msg.error?.code ?? 'ERROR', msg.error?.message ?? 'Request failed'));
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      this.failPending('Connection lost');
      if (this.wanted) this.scheduleRetry();
      else this.setState('offline');
    };
  }

  private scheduleRetry(): void {
    this.setState('connecting');
    const delay = Math.min(500 * 2 ** this.attempt++, 8000) * (0.75 + Math.random() * 0.5);
    this.retryTimer = window.setTimeout(() => this.wanted && this.open(), delay);
  }

  private failPending(reason: string): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new RpcFailure('OFFLINE', reason));
    }
    this.pending.clear();
  }

  private setState(state: SignalState): void {
    if (this.state === state) return;
    this.state = state;
    this.onState(state);
  }
}
