import { isExpired } from '../../cardNumber.js';
import { isoNow, type Clock } from '../../clock.js';
import { getOwn, type InTransaction, type JsonDb } from '../../db/jsonDb.js';
import type { Card, MerchantData } from '../../db/schema.js';
import { ConflictError, NotFoundError, ValidationError } from '../../errors.js';
import { paginate, type Page } from '../../http/validate.js';
import { consumeToken } from '../tokens/service.js';
import type { CardInput } from './cardInput.js';
import { toCardView, type CardVault, type CardView } from './vault.js';

export interface SaveCardResult {
  card: CardView;
  created: boolean;
}

export type SaveCardInput = { customerId: string | null } & ({ token: string; card?: undefined } | { card: CardInput; token?: undefined });

/** Saved cards. Unsaved (temporary) vault cards are never visible through this API. See docs/05-api.md §5.7. */
export class CardsService {
  constructor(
    private readonly db: JsonDb,
    private readonly vault: CardVault,
    private readonly clock: Clock,
  ) {}

  /** Saves a card. If this customer already saved the same card (by fingerprint), returns it with created=false. */
  async save(merchantId: string, input: SaveCardInput, inTx?: InTransaction<SaveCardResult>): Promise<SaveCardResult> {
    const fromRaw = input.card ? this.vault.build(merchantId, input.card, { saved: true, customerId: input.customerId }) : null;
    const now = isoNow(this.clock);

    return this.db.transact(merchantId, (d) => {
      const result = this.#save(d, input, fromRaw, now);
      inTx?.(d, result);
      return result;
    });
  }

  #save(d: MerchantData, input: SaveCardInput, fromRaw: Card | null, now: string): SaveCardResult {
    const candidate = fromRaw ?? consumeToken(d, input.token!, now);
    if (isExpired(candidate.expMonth, candidate.expYear, this.clock.now())) {
      throw new ValidationError([{ field: 'card.expYear', message: 'card has expired' }]);
    }
    const existing = Object.values(d.cards).find(
      (c) => c.saved && c.id !== candidate.id && c.fingerprint === candidate.fingerprint && c.customerId === input.customerId,
    );
    if (existing) {
      // Duplicate: keep the existing card; a token's temporary card is no longer needed.
      if (!fromRaw) delete d.cards[candidate.id];
      return { card: toCardView(existing), created: false };
    }
    if (fromRaw) d.cards[fromRaw.id] = fromRaw;
    else {
      const card = d.cards[candidate.id]!;
      card.saved = true;
      card.customerId = input.customerId;
    }
    return { card: toCardView(d.cards[candidate.id]!), created: true };
  }

  list(merchantId: string, query: { customerId?: string | undefined; limit: number; offset: number }): Page<CardView> {
    const cards = this.db.read(merchantId, (d) =>
      Object.values(d.cards).filter((c) => c.saved && (query.customerId === undefined || c.customerId === query.customerId)),
    );
    const page = paginate(cards, query.limit, query.offset);
    return { ...page, data: page.data.map(toCardView) };
  }

  get(merchantId: string, cardId: string): CardView {
    const card = this.db.read(merchantId, (d) => getOwn(d.cards, cardId));
    if (!card || !card.saved) throw new NotFoundError('Card', cardId);
    return toCardView(card);
  }

  /** Permanently deletes a saved card (and its encrypted number). Blocked while a pending payment needs it. */
  async delete(merchantId: string, cardId: string): Promise<void> {
    await this.db.transact(merchantId, (d) => {
      const card = getOwn(d.cards, cardId);
      if (!card || !card.saved) throw new NotFoundError('Card', cardId);
      const inUse = Object.values(d.payments).some((p) => p.status === 'pending' && p.sourceCardId === cardId);
      if (inUse) throw new ConflictError('This card is still needed by a pending payment. Try again once it has been processed.');
      delete d.cards[cardId];
    });
  }
}
