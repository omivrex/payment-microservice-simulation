import { isoNow, type Clock } from '../../clock.js';
import { aadFor, type Encryptor } from '../../crypto/encryption.js';
import { randomSecret } from '../../crypto/hashing.js';
import type { JsonDb } from '../../db/jsonDb.js';
import type { EventType, MerchantData, WebhookDelivery, WebhookEndpoint } from '../../db/schema.js';
import { ConflictError, NotFoundError, ValidationError } from '../../errors.js';
import { newId } from '../../ids.js';
import { paginate, type Page } from '../../http/validate.js';
import { assertSafeWebhookUrl, UnsafeUrlError, type HostResolver } from './ssrf.js';

/**
 * At most 5 endpoints per merchant. Every event creates one delivery per matching endpoint, and every
 * delivery is a write to the single database file plus an outbound request, so this caps the per-event
 * fan-out. See docs/05-api.md §5.9.
 */
export const MAX_ENDPOINTS_PER_MERCHANT = 5;

export interface WebhookEndpointView {
  id: string;
  url: string;
  events: EventType[] | ['*'];
  enabled: boolean;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookDeliveryView {
  id: string;
  eventId: string;
  status: WebhookDelivery['status'];
  attempts: number;
  lastResponseStatus: number | null;
  lastError: string | null;
  lastAttemptAt: string | null;
  nextAttemptAt: string | null;
  createdAt: string;
  completedAt: string | null;
}

/** Webhook endpoints and their delivery log. See docs/05-api.md §5.9 and docs/06-webhooks.md. */
export class WebhooksService {
  constructor(
    private readonly db: JsonDb,
    private readonly encryptor: Encryptor,
    private readonly clock: Clock,
    private readonly options: { allowInsecureUrls: boolean; resolver: HostResolver },
  ) {}

  async create(merchantId: string, input: { url: string; events: EventType[] | ['*']; description: string | null }): Promise<{ endpoint: WebhookEndpointView; secret: string }> {
    const url = await this.#checkUrl(input.url);
    const now = isoNow(this.clock);
    const id = newId('we');
    const secret = `whsec_${randomSecret()}`;
    const endpoint: WebhookEndpoint = {
      id,
      merchantId,
      url,
      events: input.events,
      enabled: true,
      description: input.description,
      secretEncrypted: this.encryptor.encrypt(secret, aadFor('webhookEndpoints', id, 'secret')),
      createdAt: now,
      updatedAt: now,
    };
    await this.db.transact(merchantId, (d) => {
      assertUrlNotRegistered(d, url, null);
      if (Object.keys(d.webhookEndpoints).length >= MAX_ENDPOINTS_PER_MERCHANT) {
        throw new ConflictError(`A merchant can have at most ${MAX_ENDPOINTS_PER_MERCHANT} webhook endpoints`);
      }
      d.webhookEndpoints[id] = endpoint;
    });
    return { endpoint: toEndpointView(endpoint), secret };
  }

  list(merchantId: string): WebhookEndpointView[] {
    return this.db
      .read(merchantId, (d) => Object.values(d.webhookEndpoints))
      .sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1))
      .map(toEndpointView);
  }

  get(merchantId: string, id: string): WebhookEndpointView {
    const endpoint = this.db.read(merchantId, (d) => d.webhookEndpoints[id]);
    if (!endpoint) throw new NotFoundError('Webhook endpoint', id);
    return toEndpointView(endpoint);
  }

  async update(
    merchantId: string,
    id: string,
    input: { url?: string | undefined; events?: EventType[] | ['*'] | undefined; enabled?: boolean | undefined; description?: string | null | undefined },
  ): Promise<WebhookEndpointView> {
    const url = input.url === undefined ? undefined : await this.#checkUrl(input.url);
    const now = isoNow(this.clock);
    return this.db.transact(merchantId, (d) => {
      const endpoint = findEndpoint(d, id);
      if (url !== undefined) {
        assertUrlNotRegistered(d, url, id);
        endpoint.url = url;
      }
      if (input.events !== undefined) endpoint.events = input.events;
      if (input.description !== undefined) endpoint.description = input.description;
      if (input.enabled !== undefined) {
        endpoint.enabled = input.enabled;
        // Disabled: queued deliveries are not sent either (docs/05-api.md §5.9); events stay in GET /events.
        if (!input.enabled) failPendingDeliveries(d, id, 'endpoint disabled', now);
      }
      endpoint.updatedAt = now;
      return toEndpointView(endpoint);
    });
  }

  async delete(merchantId: string, id: string): Promise<void> {
    const now = isoNow(this.clock);
    await this.db.transact(merchantId, (d) => {
      findEndpoint(d, id);
      failPendingDeliveries(d, id, 'endpoint deleted', now);
      delete d.webhookEndpoints[id];
    });
  }

  /** New signing secret; the old one stops working immediately. */
  async rotateSecret(merchantId: string, id: string): Promise<{ secret: string }> {
    const secret = `whsec_${randomSecret()}`;
    const now = isoNow(this.clock);
    await this.db.transact(merchantId, (d) => {
      const endpoint = findEndpoint(d, id);
      endpoint.secretEncrypted = this.encryptor.encrypt(secret, aadFor('webhookEndpoints', id, 'secret'));
      endpoint.updatedAt = now;
    });
    return { secret };
  }

  listDeliveries(merchantId: string, endpointId: string, query: { status?: WebhookDelivery['status'] | undefined; limit: number; offset: number }): Page<WebhookDeliveryView> {
    const { endpoint, deliveries } = this.db.read(merchantId, (d) => ({
      endpoint: d.webhookEndpoints[endpointId],
      deliveries: Object.values(d.webhookDeliveries).filter((x) => x.endpointId === endpointId && (query.status === undefined || x.status === query.status)),
    }));
    if (!endpoint) throw new NotFoundError('Webhook endpoint', endpointId);
    const page = paginate(deliveries, query.limit, query.offset);
    return { ...page, data: page.data.map(toDeliveryView) };
  }

  async #checkUrl(raw: string): Promise<string> {
    try {
      const url = await assertSafeWebhookUrl(raw, { allowInsecure: this.options.allowInsecureUrls, resolver: this.options.resolver });
      url.hash = ''; // never sent in a request, so it can't make two URLs different
      return url.toString(); // normalized: lowercase scheme/host, default port removed (used for uniqueness)
    } catch (err) {
      if (err instanceof UnsafeUrlError) throw new ValidationError([{ field: 'url', message: err.message }]);
      throw err;
    }
  }
}

/**
 * One endpoint per URL per merchant (disabled endpoints included): two endpoints with the same URL would
 * receive every event twice. URLs are compared in normalized form (see #checkUrl). Checked inside the
 * transaction, so two simultaneous registrations can't both succeed.
 */
function assertUrlNotRegistered(d: MerchantData, url: string, exceptId: string | null): void {
  const existing = Object.values(d.webhookEndpoints).find((e) => e.url === url && e.id !== exceptId);
  if (existing) {
    throw new ConflictError(
      `A webhook endpoint with this URL already exists (${existing.id}). To receive different events at this URL, update that endpoint's "events" instead.`,
    );
  }
}

function findEndpoint(d: MerchantData, id: string): WebhookEndpoint {
  const endpoint = d.webhookEndpoints[id];
  if (!endpoint) throw new NotFoundError('Webhook endpoint', id);
  return endpoint;
}

function failPendingDeliveries(d: MerchantData, endpointId: string, reason: string, now: string): void {
  for (const delivery of Object.values(d.webhookDeliveries)) {
    if (delivery.endpointId === endpointId && (delivery.status === 'pending' || delivery.status === 'sending')) {
      Object.assign(delivery, { status: 'failed', lastError: reason, nextAttemptAt: null, lockedUntil: null, completedAt: now });
    }
  }
}

export const toEndpointView = (e: WebhookEndpoint): WebhookEndpointView => ({
  id: e.id,
  url: e.url,
  events: [...e.events] as WebhookEndpointView['events'],
  enabled: e.enabled,
  description: e.description,
  createdAt: e.createdAt,
  updatedAt: e.updatedAt,
});

export const toDeliveryView = (x: WebhookDelivery): WebhookDeliveryView => ({
  id: x.id,
  eventId: x.eventId,
  status: x.status,
  attempts: x.attempts,
  lastResponseStatus: x.lastResponseStatus,
  lastError: x.lastError,
  lastAttemptAt: x.lastAttemptAt,
  nextAttemptAt: x.nextAttemptAt,
  createdAt: x.createdAt,
  completedAt: x.completedAt,
});
