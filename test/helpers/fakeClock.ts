import type { Clock } from '../../src/clock.ts';

export class FakeClock implements Clock {
  #ms: number;
  constructor(start = '2026-10-15T09:00:00.000Z') {
    this.#ms = Date.parse(start);
  }
  now(): Date {
    return new Date(this.#ms);
  }
  advance(ms: number): void {
    this.#ms += ms;
  }
  set(iso: string): void {
    this.#ms = Date.parse(iso);
  }
}

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
