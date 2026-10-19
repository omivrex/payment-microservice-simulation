# Payment Service (simulator)

A Node.js/TypeScript microservice that **simulates** card payment processing. Merchants sign up, get API keys, tokenize and save cards, and create payments that are processed **asynchronously** by a background worker. Every state change is delivered to the merchant's endpoints as a **signed webhook**. All data lives in a single **JSON file**, with transactional (ACID-like) writes.

> Simulation only: no real card network is involved, and nothing here is PCI DSS certified. Merchant sign-up is **intentionally open**, because user authentication is out of scope (see [docs/README.md](docs/README.md)).

- **Design docs:** [docs/](docs/README.md) (architecture, data model, lifecycle, security, API, webhooks, persistence, error handling, testing)
- **Interactive API docs:** `http://localhost:3000/docs` (Swagger UI) and `/openapi.json`, once the server is running

## Requirements

- Node.js **≥ 22.3**
- yarn 1.x

## Setup

```bash
yarn install
yarn gen:secrets          # creates .env (from .env.example) with placeholder secrets filled in
```

The generated `ENCRYPTION_KEYS` and `HASHING_SECRET` are **placeholders**: random values that are fine for local use. Replace them with your own random values before any shared or production use (`openssl rand -base64 32` gives a valid value). They must be base64-encoded: exactly 32 bytes for an encryption key, at least 32 bytes for the hashing secret. Re-running the script keeps existing keys (`yarn gen:secrets --force` replaces them, which makes existing encrypted data unreadable). It also adds any settings introduced since your `.env` was created, commented out with their defaults, so **re-run `yarn gen:secrets` after pulling changes** to see new options. Your values are never changed.

For local webhook testing against `http://localhost`, add `WEBHOOK_ALLOW_INSECURE_URLS=true` to `.env`. Never set it in production. All variables are listed in [docs/01-architecture.md §1.6](docs/01-architecture.md#16-configuration).

## Run

```bash
yarn dev                  # watch mode (tsx)
# or
yarn build && yarn start  # compiled
```

The server reads `.env` automatically. Data is stored in `data/db.json` (`DB_FILE`). Only one instance can use a database file at a time: a second instance refuses to start.

**Run it under a process supervisor** (systemd, pm2, or a container restart policy). After an unexpected error the service logs a `fatal` line and exits with code 1 on purpose, and restarting is safe.

## Commands

| Command | What it does |
|---|---|
| `yarn test` | All automated tests (unit, integration, API, process) |
| `yarn test:unit` · `test:integration` · `test:api` · `test:process` | One test level |
| `yarn test:coverage` | Tests with a coverage report |
| `yarn smoke` | Starts the **real server** on a random port with a temp database and runs every smoke scenario against it, including attempts to break it |
| `yarn smoke payments` | One scenario (prerequisites are added automatically) |
| `PROCESSOR_FAILURE_RATE=0.3 yarn smoke` | Chaos mode: 30% random processor failures |
| `yarn bench:db` | Measures database commit time at 1k / 10k / 50k payments |
| `yarn reencrypt` | Re-encrypts stored data with the active key (master-key rotation step; stop the server first) |
| `yarn typecheck` | TypeScript check |

What each smoke scenario covers (happy paths and the edge cases it attacks) is listed in [docs/09-testing.md §9.8](docs/09-testing.md#98-smoke-tests).

## Manual walkthrough (curl)

**Before you start:** add these two lines to `.env`, then start the server with `yarn dev`.

```bash
WEBHOOK_ALLOW_INSECURE_URLS=true   # lets you register http://localhost webhook URLs (local development only)
PROCESSOR_LATENCY_MS=300
```

**1. Sign up** (no key needed) and save the keys:

```bash
curl -s -X POST localhost:3000/merchants -H 'content-type: application/json' \
  -d '{"name":"Acme","email":"dev@acme.test"}'
export SK=sk_test_...   # apiKeys.secret
export PK=pk_test_...   # apiKeys.publishable
```

**2. Start a webhook receiver and register its URL.**

**a) Start the receiver** in a second terminal. It's a small script that prints every event it receives:

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

It prints `Receiver listening on http://localhost:4000/webhooks/payments`. **That printed URL is the one to register.**

The path and port are your choice. To use a different path, set it before `node`, for example `WEBHOOK_PATH=/api/pms/payment PORT=5000 node -e '…'`. The receiver then prints `http://localhost:5000/api/pms/payment`. If the port is already used by another program, the receiver refuses to start and says so (otherwise deliveries would silently go to that program and get `404`). Start it on a free port with `PORT`, and register the URL it prints.

**b) Register the URL** the receiver printed:

```bash
curl -s -X POST localhost:3000/webhooks -H "authorization: Bearer $SK" -H 'content-type: application/json' \
  -d '{"url":"http://localhost:4000/webhooks/payments","events":["*"]}'
```

**The registered URL must match the receiver's path exactly.** The service POSTs to exactly the URL you register. If the paths differ, the receiver answers `404` and prints the path it actually received. To fix a mismatch, `PATCH /webhooks/{id}` with the right `url`. Each URL can be registered only **once** per merchant (registering it again → `409`), and a merchant can have at most **5** endpoints.

From the response, keep `id` (`we_…`), which you'll need for the delivery log, and `secret` (`whsec_…`), which is **shown only once** and is needed to verify signatures (see [Verifying webhooks](#verifying-webhooks)). More detail and a troubleshooting table: [docs/06-webhooks.md §6.6](docs/06-webhooks.md#66-receiving-and-verifying-webhooks).

**3. Tokenize a card** with the *publishable* key, which is what a browser would do:

```bash
curl -s -X POST localhost:3000/tokens -H "authorization: Bearer $PK" -H 'content-type: application/json' \
  -d '{"card":{"number":"4242 4242 4242 4242","expMonth":12,"expYear":2030,"cvc":"123"}}'
```

**4. Pay** with the token. This returns `202` with status `pending`.

> **Amounts are in minor units.** `amountMinor` is an integer in the currency's smallest unit: `2500` with `usd` = **$25.00**, `1050` with `eur` = €10.50. JPY has no minor unit, so `2500` with `jpy` = ¥2500. Decimals such as `25.00` are rejected. Every amount field in responses and webhooks (`amountMinor`, `amountCapturedMinor`, `amountRefundedMinor`) uses the same unit.


```bash
curl -s -X POST localhost:3000/payments -H "authorization: Bearer $SK" -H 'content-type: application/json' \
  -H 'Idempotency-Key: order-1' -d '{"amountMinor":2500,"currency":"usd","token":"tok_..."}'
```

Within about a second the receiver prints `payment.created`, `payment.authorized` and `payment.captured` lines. If nothing arrives, check the delivery log: its `lastResponseStatus` and `lastError` say why (see the troubleshooting table in [§6.6](docs/06-webhooks.md#66-receiving-and-verifying-webhooks)):

```bash
curl -s localhost:3000/webhooks/we_.../deliveries -H "authorization: Bearer $SK"
```

Poll the payment:

```bash
curl -s localhost:3000/payments/pay_... -H "authorization: Bearer $SK"
```

**5. Refund** part of it, then the rest:

```bash
curl -s -X POST localhost:3000/payments/pay_.../refund -H "authorization: Bearer $SK" -H 'content-type: application/json' -d '{"amountMinor":1000}'
curl -s -X POST localhost:3000/payments/pay_.../refund -H "authorization: Bearer $SK"
```

**6. Things to try that should fail cleanly:**
- refund more than was captured → `400`;
- cancel a `pending` payment → `409`;
- resend step 4 with the same `Idempotency-Key` → the same payment is replayed;
- the same key with a different amount → `422`;
- use `$PK` on `/payments` → `403`;
- rotate the secret key (`POST /api-keys/rotate {"type":"secret"}`), then reuse the old key → `401`;
- create a payment with a raw `card` and the test number `4000000000000002` → it ends `failed` / `card_declined`.

### Test cards

| Number | Result |
|---|---|
| `4242 4242 4242 4242`, `5555 5555 5555 4444` | Approved |
| `4000 0000 0000 0002` | `card_declined` |
| `4000 0000 0000 9995` | `insufficient_funds` |
| `4000 0000 0000 0069` | `expired_card` |
| `4000 0000 0000 0127` | `incorrect_cvc` |
| `4000 0000 0000 0119` | `processing_error`: retried for ~30 s, then `failed` |

## Verifying webhooks

The receiver above only prints events. A real receiver must also verify the `Webhook-Signature` header using the endpoint's `whsec_` secret (no API key needed). [docs/06-webhooks.md §6.6](docs/06-webhooks.md#66-receiving-and-verifying-webhooks) has the verification code and a complete Express receiver.

## Logs

One JSON line per entry on stdout/stderr (`warn`/`error`/`fatal` go to stderr), always with a `requestId`. Card numbers, CVCs, keys and secrets are redacted. To filter one request: `yarn start | jq 'select(.requestId=="req_...")'`.

## Capacity

Designed for about 2,000 payments (about 10 MB) in the worst case, with a warning logged above `DB_WARN_SIZE_MB`. The measurements and the upgrade path are in [docs/07-persistence.md §7.9–7.11](docs/07-persistence.md#79-performance-and-capacity).
