import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Webhook signatures: `Webhook-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`.
 * `verifyWebhookSignature` is the exact receiver-side code documented in docs/06-webhooks.md §6.6,
 * so tests prove the documented example works against what we send.
 */

export function signWebhook(secret: string, rawBody: string, timestampSeconds: number): string {
  const v1 = createHmac('sha256', secret).update(`${timestampSeconds}.`).update(rawBody).digest('hex');
  return `t=${timestampSeconds},v1=${v1}`;
}

export function verifyWebhookSignature(
  rawBody: Buffer | string,
  header: string | undefined,
  secret: string,
  options: { toleranceSeconds?: number; nowSeconds?: number } = {},
): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=') as [string, string]));
  const timestamp = Number(parts.t);
  if (!Number.isInteger(timestamp) || !parts.v1) return false;
  const now = options.nowSeconds ?? Date.now() / 1000;
  if (Math.abs(now - timestamp) > (options.toleranceSeconds ?? 300)) return false;

  const expected = createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest();
  const received = Buffer.from(parts.v1, 'hex');
  return received.length === expected.length && timingSafeEqual(received, expected);
}
