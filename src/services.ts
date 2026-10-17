import type { AppContext } from './app.js';
import { ApiKeysService } from './modules/apiKeys/service.js';
import { MerchantsService } from './modules/merchants/service.js';

/** Business modules, built once and shared by the HTTP layer and background loops. */
export interface Services {
  apiKeys: ApiKeysService;
  merchants: MerchantsService;
}

export function createServices(ctx: AppContext): Services {
  const apiKeys = new ApiKeysService(ctx.db, ctx.hasher, ctx.clock);
  const merchants = new MerchantsService(ctx.db, apiKeys, ctx.clock);
  return { apiKeys, merchants };
}
