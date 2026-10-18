/**
 * Schema migrations, run when a file with an older `meta.schemaVersion` is opened
 * (docs/07-persistence.md §7.8). Each step upgrades the document by one version, in place.
 */

type Doc = { meta: { schemaVersion: number }; merchants: Record<string, Record<string, Record<string, any>>> };

/** True for objects shaped like a payment (stored record or public view), never for merchant metadata. */
const isPaymentShape = (o: unknown): o is Record<string, any> =>
  typeof o === 'object' && o !== null && 'currency' in o && 'captureMethod' in o && 'amountCaptured' in o;

const rename = (o: Record<string, any>, from: string, to: string): void => {
  if (from in o) {
    o[to] = o[from];
    delete o[from];
  }
};

function paymentV1toV2(p: Record<string, any>): void {
  rename(p, 'amount', 'amountMinor');
  rename(p, 'amountCaptured', 'amountCapturedMinor');
  rename(p, 'amountRefunded', 'amountRefundedMinor');
  if (p.pendingAction && typeof p.pendingAction === 'object') rename(p.pendingAction, 'amount', 'amountMinor');
  if (Array.isArray(p.history)) for (const h of p.history) if (h && typeof h === 'object') rename(h, 'amount', 'amountMinor');
}

/** v1 → v2: money fields renamed to say their unit (amount → amountMinor, …). */
function v1toV2(doc: Doc): void {
  for (const m of Object.values(doc.merchants)) {
    for (const p of Object.values(m.payments ?? {})) paymentV1toV2(p);
    for (const j of Object.values(m.jobs ?? {})) rename(j, 'amount', 'amountMinor');
    // Event snapshots and stored idempotent responses are delivered/replayed later, so they get the new names too.
    for (const e of Object.values(m.events ?? {})) if (isPaymentShape(e.data?.object)) paymentV1toV2(e.data.object);
    for (const r of Object.values(m.idempotency ?? {})) if (isPaymentShape(r.responseBody)) paymentV1toV2(r.responseBody);
  }
}

const STEPS: Record<number, (doc: Doc) => void> = { 1: v1toV2 };

/** Upgrades `doc` to `target`. Returns the versions it migrated through (empty if already current). */
export function migrate(doc: Doc, target: number): number[] {
  const applied: number[] = [];
  while (doc.meta.schemaVersion < target) {
    const step = STEPS[doc.meta.schemaVersion];
    if (!step) throw new Error(`No migration from schema version ${doc.meta.schemaVersion}`);
    step(doc);
    doc.meta.schemaVersion += 1;
    applied.push(doc.meta.schemaVersion);
  }
  return applied;
}
