# Payment Service (simulator)

A Node.js/TypeScript microservice that **simulates** card payment processing. Clients create payments through a REST API, a background worker processes them **asynchronously** against a simulated card processor, and every status change is recorded and sent to the merchant as a **signed webhook**. All data lives in a single **JSON file**, written with transactional (ACID-like) guarantees.

> Simulation only: no real card network is involved, and nothing here is PCI DSS certified. Merchant sign-up is **intentionally open**, because user authentication is out of scope (see [docs/README.md](docs/README.md#intentional-decision-open-merchant-sign-up)).

## Core features

| Feature | Where | Tests |
|---|---|---|
| Express server | [src/app.ts](src/app.ts), [src/server.ts](src/server.ts) | `test/process/server.test.ts` |
| Create a payment | `POST /payments` → [src/modules/payments/](src/modules/payments/) | `test/api/payments.test.ts` › *POST /payments* |
| Retrieve a payment by ID | `GET /payments/:id` | `test/api/payments.test.ts` › *listing and isolation* |
| Update a payment's status | `PATCH /payments/:id` with `status`: `captured`, `refunded` or `cancelled`. It goes through the same state machine as the action endpoints, so an invalid transition returns `409` | `test/api/payments.test.ts` › *PATCH status*, *state machine (every status × every action)* |
| Asynchronous payment processing | Create returns `202` with status `pending`. A background worker calls the simulated processor, with retries, backoff, a time limit per call and leases → [src/workers/paymentWorker.ts](src/workers/paymentWorker.ts) | `test/integration/paymentWorker.test.ts` |
| File-based JSON persistence | [src/db/jsonDb.ts](src/db/jsonDb.ts): queued all-or-nothing transactions, crash-safe writes (temp file, then rename), single-process lock | `test/integration/jsonDb.test.ts` |
| Error responses | One shape for every error (see [Errors](#errors)) → [src/http/middleware/errorHandler.ts](src/http/middleware/errorHandler.ts) | `test/api/foundation.test.ts`, plus 4xx cases in every API test file |
| Logging | Structured JSON logs; card data and secrets are redacted → [src/logging/](src/logging/) | `test/unit/logger.test.ts`, `test/unit/redact.test.ts` |
| API documentation | Swagger UI at `/docs`, `/openapi.json`, and [docs/05-api.md](docs/05-api.md) | `test/api/foundation.test.ts` › *every registered route is documented* |

**Beyond the core, on purpose:** merchants and API keys, card tokens and saved cards (encrypted), signed webhooks, idempotency keys and rate limits. Each one makes the simulation behave like a real payment gateway; the reasons are given in [docs/](docs/README.md).

## Getting started

**Prerequisites:** Node.js **≥ 22.3** and yarn 1.x.

```bash
yarn install
yarn gen:secrets                # creates .env from .env.example, with placeholder secrets filled in
yarn dev                        # watch mode; or: yarn build && yarn start
```

The server listens on `http://localhost:3000` and stores its data in `data/db.json`. Only one instance can use a database file at a time; a second one refuses to start.

The secrets `gen:secrets` writes are random placeholders, fine for local use. Replace them before any shared use (`openssl rand -base64 32`). Re-run `yarn gen:secrets` after pulling changes: it adds new settings to your `.env` without touching your values. Every setting is listed in [docs/01-architecture.md §1.6](docs/01-architecture.md#16-configuration).

## API overview

The full reference, with every endpoint, field and response, is the **Swagger UI at [`/docs`](http://localhost:3000/docs)** (or [`/openapi.json`](http://localhost:3000/openapi.json)) while the server is running, and [docs/05-api.md](docs/05-api.md). This section covers what you need to know before using it.

### Resources

| Resource | Purpose |
|---|---|
| `/merchants` | Sign up (no key needed). Returns the merchant and its first API keys |
| `/api-keys` | List keys and rotate them (the old key stops working immediately) |
| `/tokens` | Turn card details into a single-use token, using the publishable key, as a browser would |
| `/cards` | Save, list and delete cards (stored encrypted) |
| `/payments` | Create, list, retrieve and update payments; capture, refund and cancel them |
| `/webhooks` | Register endpoints that receive payment events, and view their delivery log |
| `/events` | Every event the service has recorded, for catching up on missed webhooks |
| `/health` | Liveness check |

### Authentication

Send an API key as `Authorization: Bearer <key>`. Each merchant has two:

- **Secret key (`sk_test_…`)**: for servers; allowed everywhere.
- **Publishable key (`pk_test_…`)**: safe to put in a browser; it can only create card tokens.

### Payments

- **Processing is asynchronous.** Creating a payment, and every capture, refund or cancel, returns `202` with a transitional status. The final status arrives by webhook, or by polling `GET /payments/:id`.
- **Statuses:** `pending` → `authorized` → `captured` → `partially_refunded` / `refunded`. By default a payment is captured as soon as it is authorized; with `"captureMethod":"manual"` it waits in `authorized` until you capture or cancel it. A declined payment ends `failed`. While an action runs, the status is `capturing`, `refunding` or `cancelling`.
- **Amounts are in minor units.** `amountMinor` is an integer in the currency's smallest unit: `2500` USD = $25.00, `1050` EUR = €10.50, and `2500` JPY = ¥2500 (JPY has no minor unit). Decimals are rejected.
- **Idempotency:** send an `Idempotency-Key` header on create, capture, refund, cancel or PATCH. A retry with the same key and body replays the original response; the same key with a different body returns `422`.

### Errors

Every error has the same shape:

```json
{ "error": { "code": "invalid_state", "message": "Cannot refund a payment with status \"pending\"", "requestId": "req_…" } }
```

Validation errors (`400`) add a `details` array naming each field. Main status codes: `400` invalid input · `401` bad API key · `403` wrong key type · `404` not found · `409` not allowed in the current status · `422` idempotency key reused · `429` rate limited · `500` unexpected error (details only in the logs, matched by `requestId`) · `503` storage unavailable.

## Walkthrough

With the server running (`yarn dev`), these `curl` commands go through the main flow. Replace the `…` placeholders with values from the previous responses.

### 1. Make a payment

**Sign up** and keep both keys from `apiKeys`:

```bash
curl -s -X POST localhost:3000/merchants -H 'content-type: application/json' \
  -d '{"name":"Acme","email":"dev@acme.test"}'
export SK=sk_test_...   # apiKeys.secret
export PK=pk_test_...   # apiKeys.publishable
```

**Tokenize a card** with the publishable key, as a browser would:

```bash
curl -s -X POST localhost:3000/tokens -H "authorization: Bearer $PK" -H 'content-type: application/json' \
  -d '{"card":{"number":"4242 4242 4242 4242","expMonth":12,"expYear":2030,"cvc":"123"}}'
```

**Pay** with the token. This returns `202` with status `pending`:

```bash
curl -s -X POST localhost:3000/payments -H "authorization: Bearer $SK" -H 'content-type: application/json' \
  -H 'Idempotency-Key: order-1' -d '{"amountMinor":2500,"currency":"usd","token":"tok_..."}'
```

**Retrieve it** a couple of seconds later. The worker authorizes and then captures it, so the status goes `pending` → `capturing` → `captured`. Wait for `captured` before the next step:

```bash
curl -s localhost:3000/payments/pay_... -H "authorization: Bearer $SK"
```

### 2. Update its status

**Refund part of it** by updating its status. This returns `202` with status `refunding`, which becomes `partially_refunded`:

```bash
curl -s -X PATCH localhost:3000/payments/pay_... -H "authorization: Bearer $SK" -H 'content-type: application/json' \
  -d '{"status":"refunded","amountMinor":1000}'
```

**Refund the rest** with the equivalent action endpoint. The status becomes `refunded`:

```bash
curl -s -X POST localhost:3000/payments/pay_.../refund -H "authorization: Bearer $SK"
```

### 3. Things that should fail cleanly

- refund more than was captured → `400`;
- cancel a `pending` payment → `409`;
- resend the payment request with the same `Idempotency-Key` → the original payment is replayed, not charged again;
- the same key with a different amount → `422`;
- use `$PK` on `/payments` → `403`;
- rotate the secret key (`POST /api-keys/rotate` with `{"type":"secret"}`), then reuse the old one → `401`;
- pay with one of the declining [test cards](#test-cards) → the payment ends `failed` with that card's code.

### 4. Receive webhooks (optional)

Webhook URLs must normally be public `https` addresses. For local testing, add `WEBHOOK_ALLOW_INSECURE_URLS=true` to `.env` and restart the server. **Never set it in production.**

**Start a receiver** in a second terminal. This small script prints every event it receives:

<!-- webhook-receiver -->
```bash
node -e '
const http = require("http");
const port = process.env.PORT || 4000;
const path = process.env.WEBHOOK_PATH || "/webhooks/payments";
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const { pathname } = new URL(req.url, "http://localhost");
    if (req.method !== "POST" || pathname !== path) {
      console.log(`404: got ${req.method} ${pathname}, but this receiver only accepts POST ${path}`);
      return res.writeHead(404).end();
    }
    const event = JSON.parse(body);
    console.log(`${event.type}  ${event.data.object.id}  status=${event.data.object.status}`);
    res.writeHead(200).end("ok");
  });
});
// Refuse to start if another program already uses this port: deliveries would go to it, not here.
const portTaken = () => {
  console.error(`Port ${port} is already in use by another program, so webhook deliveries would go there instead of here.`);
  console.error(`Start the receiver on a free port, e.g. PORT=4001, and register that URL.`);
  process.exit(1);
};
const isTaken = (host) => new Promise((resolve) => {
  const probe = require("net").createServer();
  probe.once("error", (err) => resolve(err.code === "EADDRINUSE"));
  probe.listen(port, host, () => probe.close(() => resolve(false)));
});
(async () => {
  if (Number(port) !== 0 && ((await isTaken("127.0.0.1")) || (await isTaken("::1")))) portTaken();
  server.on("error", (err) => (err.code === "EADDRINUSE" ? portTaken() : console.error(err)));
  server.listen(port, () => console.log(`Receiver listening on http://localhost:${server.address().port}${path}`));
})();
'
```

It prints the URL it listens on, by default `http://localhost:4000/webhooks/payments`. Set `PORT` or `WEBHOOK_PATH` before `node` to change it; if the port is taken, the receiver refuses to start and says so.

**Register the printed URL.** It must match exactly, because the service posts to exactly the URL you register:

```bash
curl -s -X POST localhost:3000/webhooks -H "authorization: Bearer $SK" -H 'content-type: application/json' \
  -d '{"url":"http://localhost:4000/webhooks/payments","events":["*"]}'
```

The response includes `secret` (`whsec_…`), **shown only once**, which a real receiver uses to verify the `Webhook-Signature` header. Make another payment, and the receiver prints `payment.created`, `payment.authorized` and `payment.captured`. If nothing arrives, the delivery log says why:

```bash
curl -s localhost:3000/webhooks/we_.../deliveries -H "authorization: Bearer $SK"
```

Signature verification code, a complete receiver and a troubleshooting table are in [docs/06-webhooks.md §6.6](docs/06-webhooks.md#66-receiving-and-verifying-webhooks).

### Test cards

| Number | Result |
|---|---|
| `4242 4242 4242 4242`, `5555 5555 5555 4444` | Approved |
| `4000 0000 0000 0002` | `card_declined` |
| `4000 0000 0000 9995` | `insufficient_funds` |
| `4000 0000 0000 0069` | `expired_card` |
| `4000 0000 0000 0127` | `incorrect_cvc` |
| `4000 0000 0000 0119` | `processing_error`: retried for about 30 s, then `failed` |

## Testing

Tests use Node's built-in test runner (`node:test`), so there is no test framework to install. The reasons, the strategy and the per-module test plans are in [docs/09-testing.md](docs/09-testing.md).

| Command | What it does |
|---|---|
| `yarn test` | All automated tests |
| `yarn test:unit` · `test:integration` · `test:api` · `test:process` | One level: pure functions · the database and workers · HTTP endpoints · the real server process |
| `yarn test:coverage` | All tests, with a coverage report |
| `yarn smoke` | Starts the real server on a random port with a temporary database and runs every scenario against it, including attempts to break it. `yarn smoke payments` runs one scenario |
| `PROCESSOR_FAILURE_RATE=0.3 yarn smoke` | The same, with 30% random processor failures |
| `yarn typecheck` | TypeScript check |

What each smoke scenario covers is listed in [docs/09-testing.md §9.8](docs/09-testing.md#98-smoke-tests).

## Operations

- **Logs:** one JSON line per entry on stdout (`warn`, `error` and `fatal` on stderr), always with a `requestId`. Card numbers, CVCs, keys and secrets are redacted. To follow one request: `yarn start | jq 'select(.requestId=="req_...")'`.
- **Process supervisor:** after an unexpected error the service logs a `fatal` line and exits with code 1 on purpose. Run it under systemd, pm2 or a container restart policy; restarting is safe.
- **Capacity:** designed for about 2,000 payments (about 10 MB) in the worst case, with a warning logged above `DB_WARN_SIZE_MB`. `yarn bench:db` measures commit time at 1k, 10k and 50k payments. The measurements and the upgrade path are in [docs/07-persistence.md §7.9–7.11](docs/07-persistence.md#79-performance-and-capacity).
- **Master-key rotation:** `yarn reencrypt` re-encrypts stored data with the active key. Stop the server first.

## Project layout

```
src/
  server.ts, app.ts     entry point, Express app
  config.ts             settings from environment variables
  modules/              one folder per resource: routes (HTTP) + service (business logic)
  workers/              payment worker, webhook dispatcher, housekeeping
  processor/            the simulated card processor
  db/                   the JSON file database
  crypto/               encryption and hashing
  http/                 middleware: auth, validation, idempotency, errors, rate limits
  logging/              logger and redaction
test/                   unit, integration, api and process tests
scripts/                secrets generator, smoke tests, benchmark, re-encryption
docs/                   design documentation
```

The design docs explain every decision and the alternatives considered. Start at [docs/README.md](docs/README.md):

[Architecture](docs/01-architecture.md) · [Data model](docs/02-data-model.md) · [Payment lifecycle](docs/03-payment-lifecycle.md) · [Security](docs/04-security.md) · [API](docs/05-api.md) · [Webhooks](docs/06-webhooks.md) · [Persistence](docs/07-persistence.md) · [Error handling](docs/08-error-handling.md) · [Testing](docs/09-testing.md)
