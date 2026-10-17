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
cp .env.example .env
yarn gen:secrets          # prints ENCRYPTION_KEYS / ENCRYPTION_ACTIVE_KEY_ID / HASHING_SECRET
# paste the three lines into .env
```

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

## Manual walkthrough (curl)

Start the server with `WEBHOOK_ALLOW_INSECURE_URLS=true` and `PROCESSOR_LATENCY_MS=300`, then:

**1. Sign up** (no key needed) and save the keys:

```bash
curl -s -X POST localhost:3000/merchants -H 'content-type: application/json' \
  -d '{"name":"Acme","email":"dev@acme.test"}'
export SK=sk_test_...   # apiKeys.secret
export PK=pk_test_...   # apiKeys.publishable
```

**2. Start a webhook receiver** in another terminal. It prints whatever it receives:

```bash
node -e "require('http').createServer((q,s)=>{let b='';q.on('data',c=>b+=c);q.on('end',()=>{console.log(q.headers['webhook-event'],b);s.end()})}).listen(4000)"
```

Register it, and keep the `secret` from the response for verifying signatures:

```bash
curl -s -X POST localhost:3000/webhooks -H "authorization: Bearer $SK" -H 'content-type: application/json' \
  -d '{"url":"http://localhost:4000/hook","events":["*"]}'
```

**3. Tokenize a card** with the *publishable* key, which is what a browser would do:

```bash
curl -s -X POST localhost:3000/tokens -H "authorization: Bearer $PK" -H 'content-type: application/json' \
  -d '{"card":{"number":"4242 4242 4242 4242","expMonth":12,"expYear":2030,"cvc":"123"}}'
```

**4. Pay** with the token. This returns `202` with status `pending`:

```bash
curl -s -X POST localhost:3000/payments -H "authorization: Bearer $SK" -H 'content-type: application/json' \
  -H 'Idempotency-Key: order-1' -d '{"amount":2500,"currency":"usd","token":"tok_..."}'
```

Within about a second the receiver prints `payment.created`, `payment.authorized` and `payment.captured`. Then poll the payment:

```bash
curl -s localhost:3000/payments/pay_... -H "authorization: Bearer $SK"
```

**5. Refund** part of it, then the rest:

```bash
curl -s -X POST localhost:3000/payments/pay_.../refund -H "authorization: Bearer $SK" -H 'content-type: application/json' -d '{"amount":1000}'
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

Use the endpoint's `whsec_` secret (no API key needed). See [docs/06-webhooks.md §6.6](docs/06-webhooks.md#66-verifying-signatures) for a complete receiver.

## Logs

One JSON line per entry on stdout/stderr (`warn`/`error`/`fatal` go to stderr), always with a `requestId`. Card numbers, CVCs, keys and secrets are redacted. To filter one request: `yarn start | jq 'select(.requestId=="req_...")'`.

## Capacity

Designed for about 2,000 payments (about 10 MB) in the worst case, with a warning logged above `DB_WARN_SIZE_MB`. The measurements and the upgrade path are in [docs/07-persistence.md §7.9–7.11](docs/07-persistence.md#79-performance-and-capacity).
