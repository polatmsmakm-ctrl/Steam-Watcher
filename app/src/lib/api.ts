import type { AuthResult } from '../../../shared/protocol.ts';

export interface ServerHealth {
  ok: boolean;
  name: string;
  protocol: number;
  allowGuests: boolean;
}

async function post<T>(serverUrl: string, path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(serverUrl.replace(/\/+$/, '') + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error(`Cannot reach the server at ${serverUrl}`);
  }
  const json = (await res.json().catch(() => null)) as (T & { error?: { message: string } }) | null;
  if (!res.ok || !json) throw new Error(json?.error?.message ?? `Server error (${res.status})`);
  return json;
}

export const register = (url: string, username: string, password: string, displayName: string) =>
  post<AuthResult>(url, '/api/auth/register', { username, password, displayName });
export const login = (url: string, username: string, password: string) =>
  post<AuthResult>(url, '/api/auth/login', { username, password });
export const guest = (url: string, displayName: string) => post<AuthResult>(url, '/api/auth/guest', { displayName });

export async function health(serverUrl: string): Promise<ServerHealth> {
  const res = await fetch(serverUrl.replace(/\/+$/, '') + '/api/health', { signal: AbortSignal.timeout(5000) });
  const json = (await res.json()) as ServerHealth;
  if (json.name !== 'vision-stream') throw new Error('Not a VISION STREAM server');
  return json;
}
