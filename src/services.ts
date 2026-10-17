import type { AppContext } from './app.js';
import { ApiKeysService } from './modules/apiKeys/service.js';
import { CardsService } from './modules/cards/service.js';
import { CardVault } from './modules/cards/vault.js';
import { MerchantsService } from './modules/merchants/service.js';
import { EventsService } from './modules/events/service.js';
import { PaymentsService } from './modules/payments/service.js';
import { WebhooksService } from './modules/webhooks/service.js';
import { systemResolver } from './modules/webhooks/ssrf.js';
import { TokensService } from './modules/tokens/service.js';

/** Business modules, built once and shared by the HTTP layer and background loops. */
export interface Services {
  apiKeys: ApiKeysService;
  merchants: MerchantsService;
  vault: CardVault;
  tokens: TokensService;
  cards: CardsService;
  payments: PaymentsService;
  webhooks: WebhooksService;
  events: EventsService;
}

export function createServices(ctx: AppContext): Services {
  const apiKeys = new ApiKeysService(ctx.db, ctx.hasher, ctx.clock);
  const merchants = new MerchantsService(ctx.db, apiKeys, ctx.clock);
  const vault = new CardVault(ctx.encryptor, ctx.hasher, ctx.clock);
  const tokens = new TokensService(ctx.db, vault, ctx.clock);
  const cards = new CardsService(ctx.db, vault, ctx.clock);
  const payments = new PaymentsService(ctx.db, vault, ctx.clock);
  const webhooks = new WebhooksService(ctx.db, ctx.encryptor, ctx.clock, {
    allowInsecureUrls: ctx.config.webhookAllowInsecureUrls,
    resolver: ctx.resolveHost ?? systemResolver,
  });
  const events = new EventsService(ctx.db);
  return { apiKeys, merchants, vault, tokens, cards, payments, webhooks, events };
}
