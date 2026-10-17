import type { RequestHandler, Response } from 'express';
import { addMs, isoNow, type Clock } from '../../clock.js';
import { canonicalJson, sha256Hex } from '../../crypto/hashing.js';
import type { JsonDb } from '../../db/jsonDb.js';
import { IdempotencyInProgressError, IdempotencyKeyReusedError, ValidationError } from '../../errors.js';
import '../types.js';

/**
 * Idempotency-Key support. See docs/05-api.md §5.1 and docs/08-error-handling.md §8.11.
 *
 * - Scoped per merchant (records live in the merchant's scope) and per request path.
 * - Same key + same canonical body → stored response replayed (Idempotent-Replayed: true).
 * - Same key + different body → 422. Same key while the first is running → 409.
 * - A reservation older than 60 s that never completed is treated as abandoned.
 * - 5xx responses are never stored: the reservation is released so a retry runs again.
 * - Records expire after 24 h.
 */

const TTL_MS = 24 * 60 * 60 * 1000;
const ABANDON_AFTER_MS = 60 * 1000;
const VALID_KEY = /^[\x21-\x7E]{1,255}$/;

type Decision = { kind: 'proceed' } | { kind: 'replay'; status: number; body: unknown };

export const idempotency =
  (db: JsonDb, clock: Clock): RequestHandler =>
  async (req, res, next) => {
    const key = req.get('idempotency-key');
    if (key === undefined) return next();
    if (!VALID_KEY.test(key)) {
      throw new ValidationError([{ field: 'Idempotency-Key', message: 'must be 1 to 255 visible ASCII characters' }]);
    }

    const merchantId = req.auth!.merchantId;
    const recordId = `${req.method}:${req.originalUrl.split('?')[0]}:${key}`;
    const requestHash = sha256Hex(canonicalJson(req.body ?? null));
    const now = isoNow(clock);

    const decision = await db.transact<Decision>(merchantId, (d) => {
      let record = d.idempotency[recordId];
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

    interceptJson(res, async (status, body) => {
      await db
        .transact(merchantId, (d) => {
          const record = d.idempotency[recordId];
          if (!record || record.requestHash !== requestHash) return;
          if (status >= 500) delete d.idempotency[recordId];
          else Object.assign(record, { status: 'completed', responseStatus: status, responseBody: body });
        })
        .catch((err) => req.log.error('could not store idempotent response', { err }));
    });
    next();
  };

/** Runs `beforeSend` (awaited) before the JSON body is actually written, so a stored response always matches what was sent. */
function interceptJson(res: Response, beforeSend: (status: number, body: unknown) => Promise<void>): void {
  const original = res.json.bind(res);
  res.json = ((body: unknown) => {
    void beforeSend(res.statusCode, body).finally(() => original(body));
    return res;
  }) as Response['json'];
}
