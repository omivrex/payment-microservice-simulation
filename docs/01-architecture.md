# 1. Architecture

## 1.1 Overview

The service is a **single Node.js process** that contains three things:

1. An **HTTP API** that merchants and their clients call.
2. A **payment worker** that processes queued payment jobs in the background.
3. A **webhook dispatcher** that delivers events to merchants' callback URLs.

All three share **one in-memory database instance**, which is mirrored to a JSON file.

```mermaid
flowchart TB
    subgraph clients["Clients"]
        browser["Browser / mobile app<br/>uses pk_test_..."]
        mserver["Merchant server<br/>uses sk_test_..."]
        receiver["Merchant webhook receiver<br/>verifies with whsec_..."]
    end

    subgraph proc["payment-service (one Node.js process)"]
        direction TB
        http["HTTP layer<br/>Express: auth, validation, errors"]
        modules["Modules (business logic)<br/>merchants, apiKeys, tokens, cards,<br/>payments, webhooks, events"]
        worker["Payment worker<br/>polls jobs"]
        dispatcher["Webhook dispatcher<br/>polls deliveries"]
        housekeeping["Housekeeping<br/>prunes expired data"]
        processor["Simulated processor"]
        crypto["Crypto<br/>AES-GCM, HMAC"]
        db["JsonDb<br/>in-memory + transact()"]
    end

    file[("data/db.json")]

    browser -->|"POST /tokens"| http
    mserver -->|"payments, cards, webhooks, keys"| http
    http --> modules
    modules --> crypto
    modules --> db
    worker --> processor
    worker --> db
    dispatcher --> db
    dispatcher -->|"signed POST"| receiver
    housekeeping --> db
    db -->|"atomic write"| file
```

## 1.2 Layers

Each layer only calls the layer directly beneath it. Dependencies are passed in as arguments (dependency injection) instead of being imported as global singletons.

```mermaid
flowchart TB
    A["HTTP layer<br/>routes, middleware"] --> B["Validation<br/>zod schemas"]
    B --> C["Modules / services<br/>business rules, state machine"]
    C --> D["Infrastructure<br/>JsonDb, crypto, processor, HTTP client"]
```

| Layer | Responsibility | Knows nothing about |
|---|---|---|
| **HTTP** | Parse requests, authenticate the API key, map errors to status codes | Business rules, storage |
| **Validation** | Reject malformed input with field-level error messages | Storage, HTTP status codes |
| **Modules** | Business rules: state transitions, amount checks, encryption decisions, event emission | HTTP, file formats |
| **Infrastructure** | Storage, cryptography, the fake processor, outbound HTTP | Business rules |

**Why layered:**

- **Testability.** Modules can be tested with a temp database and a fake processor, without starting an HTTP server.
- **Replaceability.** If the JSON file is swapped for Postgres later, only the infrastructure layer changes.
- **Clarity.** When something breaks, its layer tells you where to look. A 400 error comes from validation; a 409 comes from a business rule.

**Why dependency injection rather than global imports:** tests need to substitute a temp DB file, a zero-latency processor or a fake clock. Passing dependencies in makes that trivial, with no mocking libraries.

## 1.3 Modules

| Module | Owns | Main operations |
|---|---|---|
| `merchants` | Merchant accounts | Sign up (creates the first key pair), get the current merchant |
| `apiKeys` | Publishable and secret keys | Authenticate a request, rotate a key, list keys |
| `tokens` | Single-use card tokens | Create a token from raw card details |
| `cards` | Encrypted card vault | Save, list, get, delete a card; decrypt for the worker only |
| `payments` | Payments and their jobs | Create, get, list, update, request capture/refund/cancel |
| `webhooks` | Endpoints and deliveries | Register, update, delete, rotate secret, list deliveries |
| `events` | The event log / outbox | Record an event and fan it out to endpoints; list events |

**Why a separate `events` module:** every module that changes a payment must emit an event *in the same transaction* (see [Webhooks](06-webhooks.md#63-the-outbox-how-events-are-never-lost)). Putting that in one place guarantees every event has the same shape, and that no module forgets to create the deliveries.

## 1.4 Background processes

Three loops run inside the same process as the HTTP server:

| Loop | Default interval | What it does |
|---|---|---|
| **Payment worker** | every 500 ms | Claims due jobs, calls the simulated processor, applies the result |
| **Webhook dispatcher** | every 1 s | Claims due deliveries, sends signed HTTP POSTs, schedules retries |
| **Housekeeping** | every 10 min | Deletes expired tokens, expired idempotency records, and old completed jobs, events and deliveries |

**Why in-process instead of separate worker processes:** the JSON file database can only be safely owned by **one process** (see [Persistence](07-persistence.md#710-limitations)). A separate worker process would need a second writer on the same file, which would lose updates. Running the loops in-process keeps a single owner of the data.

**Why polling instead of an in-memory event emitter:** jobs and deliveries are stored in the database, so they **survive a crash or restart**. An in-memory queue would lose pending work if the process died. Polling an in-memory index of due jobs is cheap, so it costs almost nothing.

## 1.5 Request lifecycle

A typical authenticated request, creating a payment:

```mermaid
sequenceDiagram
    autonumber
    participant C as Merchant server
    participant H as HTTP layer
    participant A as Auth middleware
    participant I as Idempotency middleware
    participant V as Validation
    participant P as Payments module
    participant DB as JsonDb

    C->>H: POST /payments (Bearer sk_test_...)
    H->>A: authenticate key
    A->>DB: read apiKeys by keyId
    A-->>H: req.merchant, req.keyType = secret
    H->>I: check Idempotency-Key
    I->>DB: transact: reserve key (or replay stored response)
    H->>V: validate body (zod)
    V-->>H: typed input
    H->>P: createPayment(merchant, input)
    P->>DB: transact: payment (pending) + job + event + deliveries
    DB-->>P: committed (file written)
    P-->>H: payment
    H->>I: store response for replay
    H-->>C: 202 Accepted + payment
```

**Why 202 Accepted rather than 201 Created:** the payment record exists, but its outcome (approved or declined) **isn't known yet**. 202 tells the client the request was accepted for processing and the final result will arrive later, by webhook or by polling `GET /payments/:id`.

## 1.6 Configuration

All configuration comes from environment variables. The service **refuses to start** if a required variable is missing or invalid.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `PORT` | no | `3000` | HTTP port |
| `DB_FILE` | no | `data/db.json` | Path to the database file |
| `ENCRYPTION_KEYS` | **yes** | – | Versioned AES-256 keys, e.g. `v1:<base64>,v2:<base64>` |
| `ENCRYPTION_ACTIVE_KEY_ID` | **yes** | – | Which key encrypts new data, e.g. `v2` |
| `HASHING_SECRET` | **yes** | – | Secret for API key hashes and card fingerprints (≥ 32 bytes, base64) |
| `PROCESSOR_LATENCY_MS` | no | `300` | Simulated processor delay |
| `PROCESSOR_FAILURE_RATE` | no | `0` | Probability (0–1) of a simulated transient processor error, for exercising retries |
| `WORKER_CONCURRENCY` | no | `5` | Maximum jobs processed at the same time |
| `WEBHOOK_ALLOW_INSECURE_URLS` | no | `false` | Allow `http://` and private/loopback webhook URLs (local development only) |
| `RETENTION_DAYS` | no | `7` | How long completed jobs, events and deliveries are kept |
| `DB_WARN_SIZE_MB` | no | `20` | Log a warning when the database file outgrows the design capacity (see [Persistence §7.9](07-persistence.md#79-performance-and-capacity)) |

**Why fail fast on startup:** a payment service running with a missing encryption key would either crash on the first card, or worse, store data it can never decrypt. Failing at boot makes a misconfiguration obvious right away.

**Why environment variables:** this is the standard way to pass secrets to a process without committing them to the repository (the [twelve-factor](https://12factor.net/config) approach). A `yarn gen:secrets` script prints freshly generated values to paste into a local `.env` file.

## 1.7 Project layout

```
payment-service/
├── docs/                       ← you are here
├── src/
│   ├── server.ts               entry point: load config, open DB, start HTTP + loops
│   ├── app.ts                  builds the Express app (no listen, so tests can use it)
│   ├── config.ts               reads and validates environment variables
│   ├── errors.ts               AppError hierarchy → HTTP status codes
│   ├── crypto/
│   │   ├── encryption.ts       AES-256-GCM with key versions + AAD
│   │   └── hashing.ts          HMAC helpers, constant-time compare, key generation
│   ├── db/
│   │   ├── jsonDb.ts           transactional file-backed store
│   │   └── schema.ts           TypeScript types for every collection
│   ├── http/
│   │   ├── middleware/         auth, idempotency, rate limit, error handler
│   │   └── routes/             one router per module
│   ├── modules/
│   │   ├── merchants/  apiKeys/  tokens/  cards/
│   │   ├── payments/  webhooks/  events/
│   │   └── (each: service.ts + schemas.ts)
│   ├── processor/
│   │   └── simulatedProcessor.ts
│   └── workers/
│       ├── paymentWorker.ts
│       ├── webhookDispatcher.ts
│       └── housekeeping.ts
├── scripts/
│   ├── generate-secrets.ts
│   └── bench-db.ts             measures commit time at 1k / 10k / 50k payments
└── test/
```

**Why `app.ts` is separate from `server.ts`:** tests build the app on a random port with a temp database, without starting background loops or binding port 3000.

**Why each module folder has its own `schemas.ts`:** validation rules live next to the logic they protect, so changing a field means editing one folder.

## 1.8 Error model

Every error response has the same shape:

```json
{
  "error": {
    "code": "validation_error",
    "message": "Invalid request",
    "details": [{ "field": "amount", "message": "must be a positive integer" }]
  }
}
```

| Status | `code` | When |
|---|---|---|
| 400 | `validation_error`, `invalid_json` | Malformed or invalid input |
| 401 | `unauthorized` | Missing, malformed, unknown or revoked API key |
| 403 | `forbidden` | Valid key, wrong type (e.g. a publishable key calling `/payments`) |
| 404 | `not_found` | The resource doesn't exist **or belongs to another merchant** |
| 409 | `invalid_state`, `idempotency_in_progress`, `conflict` | Not allowed in the current state |
| 422 | `idempotency_key_reused` | Same `Idempotency-Key` sent with a different request body |
| 429 | `rate_limited` | Too many requests |
| 500 | `internal_error` | Unexpected failure (details are logged, never returned) |

**Why 404 (not 403) for another merchant's resource:** a 403 would confirm that the ID exists. Returning 404 means one merchant can't discover anything about another merchant's data.

**Why a stable `code` field in addition to `message`:** client code should branch on `code`, which never changes. `message` is for humans and may be reworded.
