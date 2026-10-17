/** Injected everywhere time matters, so tests can control it (docs/09-testing.md §9.3). */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export const isoNow = (clock: Clock): string => clock.now().toISOString();

export const addMs = (iso: string, ms: number): string => new Date(Date.parse(iso) + ms).toISOString();
