import type { CardBrand } from './db/schema.js';

/** Card-number helpers shared by validation, the vault and log redaction. */

export function passesLuhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let digit = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (digit < 0 || digit > 9) return false;
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return digits.length > 0 && sum % 10 === 0;
}

export function cardBrand(digits: string): CardBrand {
  if (/^4/.test(digits)) return 'visa';
  if (/^(5[1-5]|2(2[2-9]|[3-6]\d|7[01]|720))/.test(digits)) return 'mastercard';
  if (/^3[47]/.test(digits)) return 'amex';
  if (/^(6011|65|64[4-9])/.test(digits)) return 'discover';
  return 'unknown';
}

/** True if the card's expiry month is before `now`'s month (cards are valid through the end of their month). */
export function isExpired(expMonth: number, expYear: number, now: Date): boolean {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  return expYear < year || (expYear === year && expMonth < month);
}
