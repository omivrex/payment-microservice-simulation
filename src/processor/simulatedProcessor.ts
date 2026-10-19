import { randomBytes } from 'node:crypto';
import { isExpired } from '../cardNumber.js';
import type { Clock } from '../clock.js';
import type { Processor, ProcessorResult } from './processor.js';

/** Deterministic test cards (docs/03-payment-lifecycle.md §3.5). Any other valid card is approved. */
export const TEST_CARD_OUTCOMES: Record<string, { outcome: 'declined' | 'error'; code: string; message: string }> = {
  '4000000000000002': { outcome: 'declined', code: 'card_declined', message: 'The card was declined.' },
  '4000000000009995': { outcome: 'declined', code: 'insufficient_funds', message: 'The card has insufficient funds.' },
  '4000000000000069': { outcome: 'declined', code: 'expired_card', message: 'The card has expired.' },
  '4000000000000127': { outcome: 'declined', code: 'incorrect_cvc', message: "The card's security code is incorrect." },
  '4000000000000119': { outcome: 'error', code: 'processing_error', message: 'An error occurred while processing the card.' },
};

const EXPIRED = TEST_CARD_OUTCOMES['4000000000000069']!;
const TRANSIENT = { outcome: 'error' as const, code: 'processing_error', message: 'The processor is temporarily unavailable.' };

export function createSimulatedProcessor(options: { latencyMs: number; failureRate: number; clock: Clock; random?: () => number }): Processor {
  const random = options.random ?? Math.random;
  /** Simulated network latency. Stops early (rejects) if the worker's time limit aborts the call. */
  const delay = (signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      if (options.latencyMs <= 0) return resolve();
      const timer = setTimeout(resolve, options.latencyMs);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(signal.reason);
      }, { once: true });
    });
  const randomFailure = (): ProcessorResult | null => (random() < options.failureRate ? TRANSIENT : null);

  return {
    async authorize(input) {
      await delay(input.signal);
      const failure = randomFailure();
      if (failure) return failure as ProcessorResult<{ authorizationCode: string }>;
      const scripted = TEST_CARD_OUTCOMES[input.cardNumber];
      if (scripted) return { ...scripted };
      if (isExpired(input.expMonth, input.expYear, options.clock.now())) return { ...EXPIRED };
      return { outcome: 'success', authorizationCode: randomBytes(3).toString('hex').toUpperCase() };
    },
    async capture(input) {
      await delay(input.signal);
      return randomFailure() ?? { outcome: 'success' };
    },
    async refund(input) {
      await delay(input.signal);
      return randomFailure() ?? { outcome: 'success' };
    },
    async cancel(input) {
      await delay(input.signal);
      return randomFailure() ?? { outcome: 'success' };
    },
  };
}
