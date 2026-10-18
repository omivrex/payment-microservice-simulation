import type { Request, RequestHandler, Response } from 'express';
import { addMs, isoNow, type Clock } from '../../clock.js';
import { canonicalJson, type Hasher } from '../../crypto/hashing.js';
import { getOwn, plain, type InTransaction, type JsonDb } from '../../db/jsonDb.js';
import type { IdempotencyRecord, MerchantData } from '../../db/schema.js';
import { IdempotencyInProgressError, IdempotencyKeyReusedError, ValidationError } from '../../errors.js';
import '../types.js';

/**
 * Idempotency-Key support. See docs/05-api.md §5.1 and docs/08-error-handling.md §8.11.
 *
 * - Scoped per merchant (records live in the merchant's scope) and per request path.
 * - Same key + same canonical body → stored response replayed (Idempotent-Replayed: true).
 * - Same key + different body → 422. Same key while the first is running → 409.
 * - The body is compared by keyed hash (HMAC), never stored: it can hold a card number and CVC.
 * - A successful response is stored in the same transaction as the action (`storeResponse`), so an
 *   action can never commit without its record. Error responses are stored afterwards.
 * - A reservation older than 60 s that never completed is treated as abandoned. If the original
 *   request then finishes after all, its transaction is rolled back (409) instead of acting twice.
 * - 5xx responses are never stored: the reservation is released so a retry runs again.
 * - Records expire after 24 h.
 */

const TTL_MS = 24 * 60 * 60 * 1000;
const ABANDON_AFTER_MS = 60 * 1000;
const VALID_KEY = /^[\x21-\x7E]{1,255}$/;

type Decision = { kind: 'proceed' } | { kind: 'replay'; status: number; body: unknown };

export const idempotency =
  (db: JsonDb, clock: Clock, hasher: Hasher): RequestHandler =>
  async (req, res, next) => {
    const key = req.get('idempotency-key');
    if (key === undefined) return next();
    if (!VALID_KEY.test(key)) {
      throw new ValidationError([{ field: 'Idempotency-Key', message: 'must be 1 to 255 visible ASCII characters' }]);
    }

    const merchantId = req.auth!.merchantId;
    const recordId = `${req.method}:${req.originalUrl.split('?')[0]}:${key}`;
    const requestHash = hasher.hashRequestBody(canonicalJson(req.body ?? null));
    const now = isoNow(clock);
    // A reclaimed reservation is replaced by one with a later createdAt (at least 60 s later),
    // so createdAt identifies this request's reservation.
    const isOurs = (record: IdempotencyRecord | undefined): record is IdempotencyRecord =>
      record !== undefined && record.createdAt === now && record.requestHash === requestHash;

    const decision = await db.transact<Decision>(merchantId, (d) => {
      let record = getOwn(d.idempotency, recordId);
      if (record && (record.expiresAt <= now || (record.status === 'in_progress' && Date.parse(now) - Date.parse(record.createdAt) > ABANDON_AFTER_MS))) {
        delete d.idempotency[recordId];
        record = undefined;
      }
      if (record) {
        if (record.requestHash !== requestHash) throw new IdempotencyKeyReusedError();
        if (record.status === 'in_progress') throw new IdempotencyInProgressError();
        return { kind: 'replay', status: record.responseStatus!, body: record.responseBody };
      }
      d.idempotency[recordId] = {
        id: recordId,
        merchantId,
        requestHash,
        status: 'in_progress',
        responseStatus: null,
        responseBody: null,
        createdAt: now,
        expiresAt: addMs(now, TTL_MS),
      };
      return { kind: 'proceed' };
    });

    if (decision.kind === 'replay') {
      res.setHeader('Idempotent-Replayed', 'true');
      res.status(decision.status).json(decision.body);
      return;
    }

    req.idempotency = {
      commit(d, status, body) {
        const record = getOwn(d.idempotency, recordId);
        // Our reservation was reclaimed by a retry that is now running the action: roll ours back.
        if (!isOurs(record) || record.status !== 'in_progress') throw new IdempotencyInProgressError();
        Object.assign(record, { status: 'completed', responseStatus: status, responseBody: plain(body) });
      },
    };

    interceptJson(res, async (status, body) => {
      // Usually already completed by storeResponse in the action's own transaction.
      const pending = (d: Readonly<MerchantData>) => {
        const record = getOwn(d.idempotency, recordId);
        return isOurs(record) && record.status === 'in_progress';
      };
      if (!db.read(merchantId, pending)) return;
      await db
        .transact(merchantId, (d) => {
          if (!pending(d)) return;
          if (status >= 500) delete d.idempotency[recordId];
          else Object.assign(d.idempotency[recordId]!, { status: 'completed', responseStatus: status, responseBody: body });
        })
        .catch((err) => req.log.error('could not store idempotent response', { err }));
    });
    next();
  };

/**
 * For routes behind `idempotency`: an in-transaction hook that stores the successful response in the
 * same transaction as the action. Undefined when the request has no Idempotency-Key.
 */
export function storeResponse<R>(
  req: Request,
  status: number | ((result: R) => number),
  body: (result: R) => unknown = (result) => result,
): InTransaction<R> | undefined {
  const scope = req.idempotency;
  if (!scope) return undefined;
  return (d, result) => scope.commit(d, typeof status === 'number' ? status : status(result), body(result));
}

/** Runs `beforeSend` (awaited) before the JSON body is actually written, so a stored response always matches what was sent. */
function interceptJson(res: Response, beforeSend: (status: number, body: unknown) => Promise<void>): void {
  const original = res.json.bind(res);
  res.json = ((body: unknown) => {
    void beforeSend(res.statusCode, body).finally(() => original(body));
    return res;
  }) as Response['json'];
}
