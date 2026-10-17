import type { AppContext } from '../app.js';
import { isoNow } from '../clock.js';
import type { MerchantData } from '../db/schema.js';
import { createPollingLoop, type BackgroundLoop } from './background.js';

/**
 * Deletes expired and old operational data so the database file (rewritten on
 * every commit) stays small. See docs/02-data-model.md §2.6.
 * Payments, saved cards, merchants, keys and endpoints are never deleted here.
 */

export const HOUSEKEEPING_INTERVAL_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface PruneCounts {
  tokens: number;
  cards: number;
  idempotency: number;
  jobs: number;
  events: number;
  deliveries: number;
}

/** Pure pruning of one merchant's data. Returns what was removed. */
export function pruneMerchant(d: MerchantData, now: string, retentionDays: number): PruneCounts {
  const counts: PruneCounts = { tokens: 0, cards: 0, idempotency: 0, jobs: 0, events: 0, deliveries: 0 };
  const cutoff = new Date(Date.parse(now) - retentionDays * DAY_MS).toISOString();

  for (const t of Object.values(d.tokens)) {
    if (t.expiresAt <= now) {
      delete d.tokens[t.id];
      counts.tokens++;
    }
  }

  // An unsaved card is only kept while something can still use it: a live unused token, or a pending payment.
  const neededCards = new Set<string>();
  for (const t of Object.values(d.tokens)) if (t.usedAt === null) neededCards.add(t.cardId);
  for (const p of Object.values(d.payments)) if (p.status === 'pending') neededCards.add(p.sourceCardId);
  for (const c of Object.values(d.cards)) {
    if (!c.saved && !neededCards.has(c.id)) {
      delete d.cards[c.id];
      counts.cards++;
    }
  }

  for (const r of Object.values(d.idempotency)) {
    if (r.expiresAt <= now) {
      delete d.idempotency[r.id];
      counts.idempotency++;
    }
  }

  for (const j of Object.values(d.jobs)) {
    if ((j.status === 'succeeded' || j.status === 'failed') && j.completedAt !== null && j.completedAt < cutoff) {
      delete d.jobs[j.id];
      counts.jobs++;
    }
  }

  const eventsInUse = new Set<string>();
  for (const x of Object.values(d.webhookDeliveries)) {
    const finished = x.status === 'succeeded' || x.status === 'failed';
    if (finished && x.createdAt < cutoff) {
      delete d.webhookDeliveries[x.id];
      counts.deliveries++;
    } else if (!finished) eventsInUse.add(x.eventId);
  }
  for (const e of Object.values(d.events)) {
    if (e.createdAt < cutoff && !eventsInUse.has(e.id)) {
      delete d.events[e.id];
      counts.events++;
    }
  }
  return counts;
}

const isEmpty = (c: PruneCounts) => Object.values(c).every((n) => n === 0);

export function createHousekeeping(ctx: AppContext): BackgroundLoop {
  const log = ctx.logger.child({ loop: 'housekeeping' });

  async function tick(): Promise<void> {
    const now = isoNow(ctx.clock);
    for (const merchantId of ctx.db.merchantIds()) {
      // Dry run on a copy first, so merchants with nothing to prune cost no write.
      const preview = ctx.db.read(merchantId, (d) => pruneMerchant(structuredClone(d) as MerchantData, now, ctx.config.retentionDays));
      if (isEmpty(preview)) continue;
      const counts = await ctx.db.transact(merchantId, (d) => pruneMerchant(d, now, ctx.config.retentionDays));
      log.info('pruned expired data', { merchantId, ...counts });
    }
  }

  return createPollingLoop({ name: 'housekeeping', intervalMs: HOUSEKEEPING_INTERVAL_MS, logger: log, tick });
}
