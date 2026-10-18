import { addMs, isoNow, type Clock } from '../../clock.js';
import { getOwn, type InTransaction, type JsonDb } from '../../db/jsonDb.js';
import type { Card, MerchantData, Token } from '../../db/schema.js';
import { ValidationError } from '../../errors.js';
import { newId } from '../../ids.js';
import type { CardInput } from '../cards/cardInput.js';
import type { CardVault } from '../cards/vault.js';

export const TOKEN_TTL_MS = 15 * 60 * 1000;

export interface TokenView {
  id: string;
  card: { brand: Card['brand']; last4: string; expMonth: number; expYear: number };
  expiresAt: string;
  createdAt: string;
}

/** Single-use, short-lived card tokens. See docs/02-data-model.md (Token). */
export class TokensService {
  constructor(
    private readonly db: JsonDb,
    private readonly vault: CardVault,
    private readonly clock: Clock,
  ) {}

  async create(merchantId: string, input: CardInput, inTx?: InTransaction<TokenView>): Promise<TokenView> {
    const card = this.vault.build(merchantId, input, { saved: false, customerId: null });
    const now = isoNow(this.clock);
    const token: Token = { id: newId('tok'), merchantId, cardId: card.id, expiresAt: addMs(now, TOKEN_TTL_MS), usedAt: null, createdAt: now };
    const view = toTokenView(token, card);
    await this.db.transact(merchantId, (d) => {
      d.cards[card.id] = card;
      d.tokens[token.id] = token;
      inTx?.(d, view);
    });
    return view;
  }
}

/**
 * Marks a token used and returns its vault card. Call inside a merchant transaction.
 * Unknown, other-merchant, expired and used tokens all fail identically (no existence leak).
 */
export function consumeToken(d: MerchantData, tokenId: string, now: string): Card {
  const token = getOwn(d.tokens, tokenId);
  const card = token ? d.cards[token.cardId] : undefined;
  if (!token || !card || token.usedAt !== null || token.expiresAt <= now) {
    throw new ValidationError([{ field: 'token', message: 'is invalid, expired or already used' }]);
  }
  token.usedAt = now;
  return card;
}

const toTokenView = (t: Token, c: Card): TokenView => ({
  id: t.id,
  card: { brand: c.brand, last4: c.last4, expMonth: c.expMonth, expYear: c.expYear },
  expiresAt: t.expiresAt,
  createdAt: t.createdAt,
});
