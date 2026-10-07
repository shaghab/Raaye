import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Opaque, unguessable action/invitation tokens (192 bits of entropy, base64url). */
export function generateToken(bytes = 24): string {
  return randomBytes(bytes).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
