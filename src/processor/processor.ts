/**
 * The card processor interface. The worker depends on this, not on the
 * simulator, so a real gateway adapter could be added later (docs/03-payment-lifecycle.md §3.5).
 * `reference` is the job ID, passed as an idempotency reference.
 * `signal` is aborted when the worker's time limit (PROCESSOR_TIMEOUT_MS) is reached; implementations should stop
 * waiting when it fires. The worker gives up on the call at the limit either way.
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
    amountMinor: number;
    currency: string;
    signal?: AbortSignal;
  }): Promise<ProcessorResult<{ authorizationCode: string }>>;
  capture(input: { reference: string; authorizationCode: string; amountMinor: number; signal?: AbortSignal }): Promise<ProcessorResult>;
  refund(input: { reference: string; authorizationCode: string; amountMinor: number; signal?: AbortSignal }): Promise<ProcessorResult>;
  cancel(input: { reference: string; authorizationCode: string; signal?: AbortSignal }): Promise<ProcessorResult>;
}
