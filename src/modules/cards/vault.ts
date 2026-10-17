import { cardBrand, isExpired } from '../../cardNumber.js';
import { isoNow, type Clock } from '../../clock.js';
import { aadFor, type Encryptor } from '../../crypto/encryption.js';
import type { Hasher } from '../../crypto/hashing.js';
import type { Card } from '../../db/schema.js';
import { SecurityError, ValidationError } from '../../errors.js';
import { newId } from '../../ids.js';
import type { CardInput } from './cardInput.js';

/**
 * The card vault: every card number (saved or not) is stored encrypted in a Card
 * record, bound to that record by AAD. See docs/02-data-model.md (Card) and §4.4.
 */
export class CardVault {
  constructor(
    private readonly encryptor: Encryptor,
    private readonly hasher: Hasher,
    private readonly clock: Clock,
  ) {}

  /** Builds an encrypted Card record. Pure: callers insert it inside their own transaction. CVC is dropped here. */
  build(merchantId: string, input: CardInput, options: { saved: boolean; customerId: string | null }): Card {
    if (isExpired(input.expMonth, input.expYear, this.clock.now())) {
      throw new ValidationError([{ field: 'card.expYear', message: 'card has expired' }]);
    }
    const id = newId('card');
    return {
      id,
      merchantId,
      customerId: options.customerId,
      saved: options.saved,
      numberEncrypted: this.encryptor.encrypt(input.number, aadFor('cards', id, 'number')),
      fingerprint: this.hasher.fingerprintCard(input.number),
      brand: cardBrand(input.number),
      last4: input.number.slice(-4),
      expMonth: input.expMonth,
      expYear: input.expYear,
      createdAt: isoNow(this.clock),
    };
  }

  /** Only the payment worker should call this. Throws SecurityError on tampering or a purged number. */
  decryptNumber(card: Card): string {
    if (!card.numberEncrypted) throw new SecurityError(`Card ${card.id} has no stored number`);
    return this.encryptor.decrypt(card.numberEncrypted, aadFor('cards', card.id, 'number'));
  }
}

export interface CardView {
  id: string;
  customerId: string | null;
  brand: Card['brand'];
  last4: string;
  expMonth: number;
  expYear: number;
  createdAt: string;
}

export const toCardView = (c: Card): CardView => ({
  id: c.id,
  customerId: c.customerId,
  brand: c.brand,
  last4: c.last4,
  expMonth: c.expMonth,
  expYear: c.expYear,
  createdAt: c.createdAt,
});
