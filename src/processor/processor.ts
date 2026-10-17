/**
 * The card processor interface. The worker depends on this, not on the
 * simulator, so a real gateway adapter could be added later (docs/03-payment-lifecycle.md §3.5).
 * `reference` is the job ID, passed as an idempotency reference.
 */

export type ProcessorResult<T = object> =
  | ({ outcome: 'success' } & T)
  | { outcome: 'declined'; code: string; message: string }
  | { outcome: 'error'; code: string; message: string };

export interface Processor {
  authorize(input: {
    reference: string;
    cardNumber: string;
    expMonth: number;
    expYear: number;
    amount: number;
    currency: string;
  }): Promise<ProcessorResult<{ authorizationCode: string }>>;
  capture(input: { reference: string; authorizationCode: string; amount: number }): Promise<ProcessorResult>;
  refund(input: { reference: string; authorizationCode: string; amount: number }): Promise<ProcessorResult>;
  cancel(input: { reference: string; authorizationCode: string }): Promise<ProcessorResult>;
}
