import type { RequestHandler } from 'express';
import type { ApiKeyType } from '../../db/schema.js';
import { ForbiddenError } from '../../errors.js';
import type { ApiKeysService } from '../../modules/apiKeys/service.js';
import '../types.js';

/**
 * Authenticates `Authorization: Bearer <key>` and checks the key type is allowed
 * on this route. Failure modes: 401 (any bad key), 403 (wrong key type).
 * See docs/04-security.md §4.3.
 */
export const requireKey =
  (apiKeys: ApiKeysService, allowed: ApiKeyType[] = ['secret']): RequestHandler =>
  (req, _res, next) => {
    const header = req.get('authorization') ?? '';
    const match = /^Bearer[ ]+(\S+)[ ]*$/i.exec(header);
    req.auth = apiKeys.authenticate(match?.[1]);
    if (!allowed.includes(req.auth.keyType)) {
      throw new ForbiddenError(
        req.auth.keyType === 'publishable'
          ? 'Publishable keys can only create card tokens. Use your secret key.'
          : 'This API key is not allowed to perform this request',
      );
    }
    next();
  };
