import type { Processor, ProcessorResult } from '../../src/processor/processor.ts';

type Op = 'authorize' | 'capture' | 'refund' | 'cancel';
export type Scripted = ProcessorResult<{ authorizationCode?: string }> | { outcome: 'throw'; message: string };

/**
 * Test processor: returns queued outcomes per operation (default: success),
 * can hold calls open ("blocking") and records peak concurrency.
 */
export class ScriptedProcessor implements Processor {
  readonly queue: Record<Op, Scripted[]> = { authorize: [], capture: [], refund: [], cancel: [] };
  readonly calls: Array<{ op: Op; reference: string }> = [];
  blocking = false;
  inFlight = 0;
  maxInFlight = 0;
  #waiters: Array<() => void> = [];

  script(op: Op, ...outcomes: Scripted[]): this {
    this.queue[op].push(...outcomes);
    return this;
  }

  /** Releases every call currently held open. */
  release(): void {
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const w of waiters) w();
  }

  async #run(op: Op, reference: string): Promise<ProcessorResult<{ authorizationCode: string }>> {
    this.calls.push({ op, reference });
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.blocking) await new Promise<void>((resolve) => this.#waiters.push(resolve));
      const next = this.queue[op].shift() ?? { outcome: 'success' };
      if (next.outcome === 'throw') throw new TypeError(next.message);
      if (next.outcome === 'success') return { outcome: 'success', authorizationCode: (next as { authorizationCode?: string }).authorizationCode ?? 'AUTH42' };
      return next;
    } finally {
      this.inFlight--;
    }
  }

  authorize(input: { reference: string }) {
    return this.#run('authorize', input.reference);
  }
  capture(input: { reference: string }) {
    return this.#run('capture', input.reference);
  }
  refund(input: { reference: string }) {
    return this.#run('refund', input.reference);
  }
  cancel(input: { reference: string }) {
    return this.#run('cancel', input.reference);
  }
}

export const transient = (code = 'processing_error'): Scripted => ({ outcome: 'error', code, message: 'temporarily unavailable' });
export const declined = (code = 'card_declined'): Scripted => ({ outcome: 'declined', code, message: 'declined' });
export const crash = (message = 'simulated bug'): Scripted => ({ outcome: 'throw', message });
