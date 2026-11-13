export class RpcError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}
export const bad = (message: string) => new RpcError('BAD_REQUEST', message);
export const forbidden = (message: string) => new RpcError('FORBIDDEN', message);
export const notFound = (message: string) => new RpcError('NOT_FOUND', message);

export function str(v: unknown, name: string, min: number, max: number): string {
  if (typeof v !== 'string') throw bad(`${name} is required`);
  const s = v.trim();
  if (s.length < min || s.length > max) throw bad(`${name} must be ${min}-${max} characters`);
  return s;
}
