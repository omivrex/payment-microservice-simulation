import type { EventType, MerchantData, StoredEvent, WebhookDelivery } from '../../db/schema.js';
import { newId } from '../../ids.js';

/**
 * Records an event and fans it out to every matching enabled endpoint, inside
 * the caller's transaction (transactional outbox, docs/06-webhooks.md §6.3).
 * The state change, the event and its deliveries commit together or not at all.
 */
export function recordEvent(
  d: MerchantData,
  merchantId: string,
  type: EventType,
  object: Record<string, unknown>,
  now: string,
  extra: Omit<StoredEvent['data'], 'object'> = {},
): StoredEvent {
  const event: StoredEvent = { id: newId('evt'), merchantId, type, data: { object: structuredClone(object), ...extra }, createdAt: now };
  d.events[event.id] = event;

  for (const endpoint of Object.values(d.webhookEndpoints)) {
    if (!endpoint.enabled) continue;
    const subscribed = endpoint.events.includes('*' as never) || (endpoint.events as string[]).includes(type);
    if (!subscribed) continue;
    const delivery: WebhookDelivery = {
      id: newId('whd'),
      merchantId,
      endpointId: endpoint.id,
      eventId: event.id,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: now,
      lockedUntil: null,
      lastAttemptAt: null,
      lastResponseStatus: null,
      lastError: null,
      createdAt: now,
      completedAt: null,
    };
    d.webhookDeliveries[delivery.id] = delivery;
  }
  return event;
}
