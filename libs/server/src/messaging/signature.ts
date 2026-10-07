import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verify Meta's X-Hub-Signature-256 header over the exact raw body bytes using a
 * timing-safe comparison. Never parse and re-serialize JSON before hashing.
 */
export function verifyWebhookSignature(rawBody: Buffer | Uint8Array, header: string | undefined, appSecret: string): boolean {
  if (!header || !header.startsWith('sha256=')) return false;
  const provided = header.slice('sha256='.length).trim();
  if (!/^[0-9a-f]{64}$/i.test(provided)) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const left = Buffer.from(provided.toLowerCase(), 'utf8');
  const right = Buffer.from(expected, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

export function signWebhookBody(rawBody: Buffer | Uint8Array, appSecret: string): string {
  return `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
}
