import type { JsonDb } from '../../db/jsonDb.js';
import type { EventType, StoredEvent } from '../../db/schema.js';
import { NotFoundError } from '../../errors.js';
import { paginate, type Page } from '../../http/validate.js';

export interface EventView {
  id: string;
  type: EventType;
  data: StoredEvent['data'];
  createdAt: string;
}

export const toEventView = (e: StoredEvent): EventView => ({ id: e.id, type: e.type, data: structuredClone(e.data), createdAt: e.createdAt });

/** The event log, for reconciliation when webhooks were missed (docs/05-api.md §5.10). */
export class EventsService {
  constructor(private readonly db: JsonDb) {}

  list(merchantId: string, query: { type?: EventType | undefined; limit: number; offset: number }): Page<EventView> {
    const events = this.db.read(merchantId, (d) => Object.values(d.events).filter((e) => query.type === undefined || e.type === query.type));
    const page = paginate(events, query.limit, query.offset);
    return { ...page, data: page.data.map(toEventView) };
  }

  get(merchantId: string, id: string): EventView {
    const event = this.db.read(merchantId, (d) => d.events[id]);
    if (!event) throw new NotFoundError('Event', id);
    return toEventView(event);
  }
}
