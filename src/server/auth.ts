import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split(':');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(actual, expected);
}

export const SESSION_COOKIE = 'uptrue_session';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Valor do cookie (assinado pelo @fastify/cookie): "<userId>.<expiraEm>". */
export function encodeSession(userId: number, now = Date.now()): string {
  return `${userId}.${now + SESSION_TTL_MS}`;
}

export function decodeSession(value: string, now = Date.now()): number | null {
  const [id, exp] = value.split('.').map(Number);
  if (!Number.isInteger(id) || !Number.isFinite(exp) || exp < now) return null;
  return id;
}
