import http from 'node:http';
import https from 'node:https';
import type { AppContext } from '../app.js';
import { addMs, isoNow } from '../clock.js';
import { aadFor } from '../crypto/encryption.js';
import type { StoredEvent, WebhookDelivery, WebhookEndpoint } from '../db/schema.js';
import { SecurityError } from '../errors.js';
import { signWebhook } from '../modules/webhooks/signature.js';
import { assertSafeWebhookUrl, safeLookup, systemResolver, UnsafeUrlError, type HostResolver } from '../modules/webhooks/ssrf.js';
import { createPollingLoop, type BackgroundLoop } from './background.js';

/**
 * Webhook dispatcher: claims due deliveries, sends signed POSTs, retries on a
 * long schedule. See docs/06-webhooks.md §6.4–6.5 and docs/08-error-handling.md §8.8.
 */

export const DISPATCHER_INTERVAL_MS = 1000;
export const DELIVERY_LEASE_MS = 30_000;
export const MAX_DELIVERY_ATTEMPTS = 8;
export const DELIVERY_CONCURRENCY = 10;
const MAX_RESPONSE_BYTES = 1024;
/** Delay before attempt N+1, measured from attempt N (index = attempts already made − 1). */
export const RETRY_SCHEDULE_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 6 * 3_600_000, 12 * 3_600_000, 24 * 3_600_000];

interface Claimed {
  merchantId: string;
  delivery: WebhookDelivery;
  event: StoredEvent;
  endpoint: WebhookEndpoint;
}

type SendResult = { ok: true; status: number } | { ok: false; status: number | null; error: string };

export interface DispatcherOptions {
  timeoutMs?: number;
  resolver?: HostResolver;
}

export function createWebhookDispatcher(ctx: AppContext, options: DispatcherOptions = {}): BackgroundLoop {
  const { db, clock } = ctx;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const resolver = options.resolver ?? systemResolver;
  const inFlight = new Set<Promise<void>>();
  const log = ctx.logger.child({ loop: 'webhook-dispatcher' });

  const isDue = (x: WebhookDelivery, now: string) =>
    (x.status === 'pending' && x.nextAttemptAt !== null && x.nextAttemptAt <= now) ||
    (x.status === 'sending' && x.lockedUntil !== null && x.lockedUntil < now);

  async function tick(): Promise<void> {
    const free = DELIVERY_CONCURRENCY - inFlight.size;
    if (free <= 0) return;
    const now = isoNow(clock);
    const due = db
      .scanMerchants((merchantId, d) =>
        Object.values(d.webhookDeliveries).filter((x) => isDue(x, now)).map((x) => ({ merchantId, id: x.id, at: x.nextAttemptAt ?? x.createdAt })),
      )
      .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
      .slice(0, free);

    const byMerchant = new Map<string, string[]>();
    for (const { merchantId, id } of due) byMerchant.set(merchantId, [...(byMerchant.get(merchantId) ?? []), id]);

    for (const [merchantId, ids] of byMerchant) {
      const claimed = await db.transact(merchantId, (d) => {
        const out: Claimed[] = [];
        for (const id of ids) {
          const delivery = d.webhookDeliveries[id];
          if (!delivery || !isDue(delivery, now)) continue;
          const endpoint = d.webhookEndpoints[delivery.endpointId];
          const event = d.events[delivery.eventId];
          if (!endpoint || !endpoint.enabled || !event) {
            const reason = !endpoint ? 'endpoint deleted' : !endpoint.enabled ? 'endpoint disabled' : 'event no longer available';
            Object.assign(delivery, { status: 'failed', lastError: reason, nextAttemptAt: null, lockedUntil: null, completedAt: now });
            continue;
          }
          Object.assign(delivery, { status: 'sending', attempts: delivery.attempts + 1, lockedUntil: addMs(now, DELIVERY_LEASE_MS) });
          out.push({ merchantId, delivery: structuredClone(delivery), event: structuredClone(event), endpoint: structuredClone(endpoint) });
        }
        return out;
      });
      for (const c of claimed) {
        const run = deliver(c).finally(() => inFlight.delete(run));
        inFlight.add(run);
      }
    }
  }

  async function deliver(c: Claimed): Promise<void> {
    const dLog = log.child({ deliveryId: c.delivery.id, endpointId: c.endpoint.id, eventId: c.event.id, merchantId: c.merchantId, attempt: c.delivery.attempts });
    let result: SendResult;
    try {
      const secret = ctx.encryptor.decrypt(c.endpoint.secretEncrypted, aadFor('webhookEndpoints', c.endpoint.id, 'secret'));
      const url = await assertSafeWebhookUrl(c.endpoint.url, { allowInsecure: ctx.config.webhookAllowInsecureUrls, resolver });
      const body = JSON.stringify({ id: c.event.id, type: c.event.type, createdAt: c.event.createdAt, data: c.event.data });
      const timestamp = Math.floor(clock.now().getTime() / 1000);
      result = await send(url, body, {
        'content-type': 'application/json',
        'user-agent': 'payment-service-webhooks/1.0',
        'webhook-id': c.event.id,
        'webhook-event': c.event.type,
        'webhook-signature': signWebhook(secret, body, timestamp),
      });
    } catch (err) {
      if (err instanceof SecurityError) {
        dLog.error('could not decrypt webhook signing secret', { security: true, err });
        result = { ok: false, status: null, error: 'internal error' };
      } else if (err instanceof UnsafeUrlError) {
        result = { ok: false, status: null, error: `blocked: ${err.message}` };
      } else {
        dLog.error('webhook delivery crashed', { err });
        result = { ok: false, status: null, error: 'internal error' };
      }
    }

    if (result.ok) dLog.info('webhook delivered', { status: result.status });
    else dLog.warn('webhook delivery failed', { status: result.status, error: result.error });

    try {
      const outcome = await db.transact(c.merchantId, (d) => {
        const now = isoNow(clock);
        const x = d.webhookDeliveries[c.delivery.id];
        if (!x || x.status !== 'sending' || x.attempts !== c.delivery.attempts || x.lockedUntil !== c.delivery.lockedUntil) return 'stale';
        Object.assign(x, { lastAttemptAt: now, lastResponseStatus: result.status, lockedUntil: null });
        if (result.ok) {
          Object.assign(x, { status: 'succeeded', lastError: null, nextAttemptAt: null, completedAt: now });
          return 'succeeded';
        }
        x.lastError = result.error;
        if (x.attempts >= MAX_DELIVERY_ATTEMPTS) {
          Object.assign(x, { status: 'failed', nextAttemptAt: null, completedAt: now });
          return 'gave_up';
        }
        Object.assign(x, { status: 'pending', nextAttemptAt: addMs(now, RETRY_SCHEDULE_MS[x.attempts - 1]!) });
        return 'retry';
      });
      if (outcome === 'stale') dLog.warn('stale delivery result discarded (lease expired and delivery was reclaimed)');
      if (outcome === 'gave_up') dLog.warn('webhook delivery failed permanently after all attempts');
    } catch (err) {
      dLog.error('could not record delivery result', { err });
    }
  }

  function send(url: URL, body: string, headers: Record<string, string>): Promise<SendResult> {
    const mod = url.protocol === 'https:' ? https : http;
    return new Promise((resolve) => {
      let settled = false;
      const done = (r: SendResult) => {
        if (!settled) {
          settled = true;
          resolve(r);
        }
      };
      const req = mod.request(
        url,
        {
          method: 'POST',
          headers: { ...headers, 'content-length': Buffer.byteLength(body) },
          timeout: timeoutMs,
          signal: AbortSignal.timeout(timeoutMs),
          // In secure mode the address is checked inside DNS lookup, so check and connect use the same IP.
          ...(ctx.config.webhookAllowInsecureUrls ? {} : { lookup: safeLookup(resolver) }),
        },
        (res) => {
          const status = res.statusCode ?? 0;
          // Only the status matters; read at most 1 KB, then drop the connection.
          let received = 0;
          res.on('data', (chunk: Buffer) => {
            received += chunk.length;
            if (received > MAX_RESPONSE_BYTES) res.destroy();
          });
          res.on('error', () => {});
          if (status >= 200 && status < 300) done({ ok: true, status });
          else if (status >= 300 && status < 400) done({ ok: false, status, error: `redirect not followed (HTTP ${status})` });
          else done({ ok: false, status, error: `HTTP ${status}` });
          res.resume();
        },
      );
      req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
      req.on('error', (err: NodeJS.ErrnoException) => done({ ok: false, status: null, error: describeNetworkError(err) }));
      req.end(body);
    });
  }

  return createPollingLoop({
    name: 'webhook-dispatcher',
    intervalMs: DISPATCHER_INTERVAL_MS,
    logger: log,
    tick,
    drain: async () => {
      await Promise.allSettled([...inFlight]);
    },
  });
}

function describeNetworkError(err: NodeJS.ErrnoException): string {
  if (err.code === 'EBLOCKED') return 'blocked: resolves to a private address';
  if (err.code === 'ECONNREFUSED') return 'connection refused';
  if (err.code === 'ENOTFOUND') return 'DNS lookup failed';
  if (err.code === 'ETIMEDOUT' || err.name === 'AbortError' || err.name === 'TimeoutError') return 'timeout';
  if (err.code === 'ECONNRESET') return 'connection reset';
  return 'network error';
}
