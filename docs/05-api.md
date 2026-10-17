# 5. API Reference

Base URL (local): `http://localhost:3000`. All request and response bodies are JSON.

## 5.1 Conventions

### Authentication

```
Authorization: Bearer sk_test_…   (or pk_test_… where allowed)
```

| Column value | Meaning |
|---|---|
| **none** | No key needed |
| **pk/sk** | Publishable or secret key |
| **sk** | Secret key only. A publishable key gets `403 forbidden` |

**Why Bearer tokens in the `Authorization` header:** it's the HTTP standard for API credentials, every client library supports it, and proxies and logging tools know to treat it as sensitive.

### Idempotency

Endpoints marked **⟳ idempotent** accept an optional `Idempotency-Key` header (1–255 chars):

| Situation | Response |
|---|---|
| First request with a key | Processed normally. The response is stored for 24 h |
| Same key, same body | The **stored response is replayed**, with header `Idempotent-Replayed: true` |
| Same key, different body | `422 idempotency_key_reused` |
| Same key while the first request is still running | `409 idempotency_in_progress` |
| Same key, but the first request's reservation is over 60 s old and never completed | Treated as **abandoned**: the request runs normally |
| First request failed with a **5xx** | **Not stored**: the key is released, so a retry runs again (see [Error handling §8.11](08-error-handling.md#811-errors-and-idempotency)) |

Keys are scoped per merchant **and** per endpoint.

**Why:** if a network timeout hides the response to `POST /payments`, the client doesn't know whether the customer was charged. Retrying with the same key is guaranteed not to charge twice.

**Why endpoints that return secrets are *not* idempotent** (`/api-keys/rotate`, `POST /webhooks`, `/webhooks/:id/rotate-secret`): replaying a response means storing it, and those responses contain a plain secret that we deliberately never store.

"Same body" is compared on **canonical JSON** (keys sorted), so `{"a":1,"b":2}` and `{"b":2,"a":1}` count as the same request.

**Why abandon reservations after 60 s:** if the process crashes mid-request, the reservation stays `in_progress`, and without this rule the key would answer `409` for 24 hours to a client that's just trying to retry. No request legitimately takes 60 s.

**Why canonical JSON:** different JSON libraries order keys differently, and a client retrying the *same* request must not get a `422`.

### Unknown fields

Request bodies are validated **strictly**: a field that isn't documented for that endpoint → `400 validation_error` naming the field.

**Why reject instead of ignoring:** a typo like `"ammount"` or `"captureMetod"` would otherwise be silently dropped. The request would succeed with defaults the client never intended, such as capturing immediately instead of manually.

### Pagination

List endpoints accept `limit` (1–100, default 20) and `offset` (≥ 0, default 0), and return newest first. Records with the same `createdAt` are ordered by `id`, so the order is always deterministic:

```json
{ "data": [ … ], "total": 42, "limit": 20, "offset": 0 }
```

**Why offset rather than cursor pagination:** it's simpler to implement and to use, and the data set is small (a single JSON file). The trade-off is that items can shift between pages if new records arrive while paging. That's acceptable for a simulator.

### Errors

See the [error model in Architecture](01-architecture.md#18-error-model). Every error looks like `{ "error": { "code", "message", "details?", "requestId" } }`, and every response carries an `X-Request-Id` header. `429` and `503` responses include `Retry-After` (in seconds). For what clients can and can't expect from error bodies, see [Error handling §8.4](08-error-handling.md#84-what-the-client-receives).

## 5.2 Endpoint index

| Method | Path | Auth | ⟳ | Purpose |
|---|---|---|:-:|---|
| GET | `/health` | none | | Liveness check |
| POST | `/merchants` | none | | Sign up, receive first key pair |
| GET | `/merchants/me` | sk | | Current merchant |
| GET | `/api-keys` | sk | | List keys |
| POST | `/api-keys/rotate` | sk | | Rotate one key (old key revoked immediately) |
| POST | `/tokens` | pk/sk | ⟳ | Tokenize a card |
| POST | `/cards` | sk | ⟳ | Save a card |
| GET | `/cards` | sk | | List saved cards |
| GET | `/cards/:id` | sk | | Get a saved card |
| DELETE | `/cards/:id` | sk | | Delete a saved card |
| POST | `/payments` | sk | ⟳ | Create a payment (async) |
| GET | `/payments` | sk | | List payments |
| GET | `/payments/:id` | sk | | Get a payment |
| PATCH | `/payments/:id` | sk | | Update description / metadata |
| POST | `/payments/:id/capture` | sk | ⟳ | Request capture (async) |
| POST | `/payments/:id/refund` | sk | ⟳ | Request refund (async) |
| POST | `/payments/:id/cancel` | sk | ⟳ | Request cancellation (async) |
| POST | `/webhooks` | sk | | Register an endpoint |
| GET | `/webhooks` | sk | | List endpoints |
| GET | `/webhooks/:id` | sk | | Get an endpoint |
| PATCH | `/webhooks/:id` | sk | | Update url / events / enabled |
| DELETE | `/webhooks/:id` | sk | | Delete an endpoint |
| POST | `/webhooks/:id/rotate-secret` | sk | | New signing secret (old one stops working immediately) |
| GET | `/webhooks/:id/deliveries` | sk | | Delivery log |
| GET | `/events` | sk | | List events |
| GET | `/events/:id` | sk | | Get one event |

## 5.3 Health

### `GET /health` → `200`

```json
{ "status": "ok" }
```

## 5.4 Merchants

### `POST /merchants`: sign up

> ⚠️ **Intentionally unauthenticated.** User authentication is outside this project's scope. See the [README](README.md#intentional-decision-open-merchant-sign-up). Rate-limited to 5 per hour per IP.

Request:

```json
{ "name": "Acme Store", "email": "dev@acme.test" }
```

Response `201`:

```json
{
  "merchant": { "id": "mer_7c1e…", "name": "Acme Store", "email": "dev@acme.test", "createdAt": "…" },
  "apiKeys": {
    "publishable": "pk_test_4f1a9c0d2b3e5f60_Qm9vb…",
    "secret":      "sk_test_a81b77c2d4e09f13_Zx3Lr…"
  }
}
```

Errors: `400` invalid name/email · `409 conflict` email already registered · `429` rate limited.

**Why keys are returned at sign-up:** without them the merchant couldn't make a single authenticated call. This is the **only** time the secret key is shown.

### `GET /merchants/me` → `200`

Returns the `merchant` object for the calling key.

## 5.5 API keys

### `GET /api-keys` → `200`

```json
{
  "data": [
    { "id": "key_4f1a9c0d2b3e5f60", "type": "publishable", "status": "active",
      "key": "pk_test_4f1a9c0d2b3e5f60_Qm9vb…", "createdAt": "…", "revokedAt": null },
    { "id": "key_a81b77c2d4e09f13", "type": "secret", "status": "active",
      "key": "sk_test_…r9Xa", "createdAt": "…", "revokedAt": null }
  ]
}
```

Revoked keys are included, for audit. Secret keys only ever show their last 4 characters.

### `POST /api-keys/rotate`

Request:

```json
{ "type": "secret" }
```

Response `200`:

```json
{ "id": "key_0e4d…", "type": "secret", "status": "active", "key": "sk_test_0e4d…_Pq7…", "createdAt": "…" }
```

The previous key of that type is **revoked immediately**. If you rotate the secret key you're calling with, that key stops working as soon as this response is sent. See [Security](04-security.md#api-key-rotation).

## 5.6 Tokens

### `POST /tokens` ⟳: tokenize a card (pk/sk)

Request:

```json
{ "card": { "number": "4242 4242 4242 4242", "expMonth": 12, "expYear": 2030, "cvc": "123" } }
```

Response `201`:

```json
{
  "id": "tok_51d0…",
  "card": { "brand": "visa", "last4": "4242", "expMonth": 12, "expYear": 2030 },
  "expiresAt": "2026-10-15T09:45:00.000Z",
  "createdAt": "2026-10-15T09:30:00.000Z"
}
```

Validation: number passes the Luhn check (spaces and dashes are allowed); `expMonth` 1–12; `expYear` four digits, not in the past; `cvc` 3–4 digits. Rate-limited to 60/min per key.

**Why the expiry date is checked here but test-card declines aren't:** an obviously invalid card should fail immediately at the browser. Whether a valid card is *approved* is the processor's decision, which happens asynchronously.

## 5.7 Cards

### `POST /cards` ⟳: save a card

Request: exactly one of `token` or `card`:

```json
{ "token": "tok_51d0…", "customerId": "cus_from_my_system_42" }
```

Response `201` (new) or `200` (this customer already has this card, so the existing one is returned):

```json
{
  "id": "card_9f2e…",
  "customerId": "cus_from_my_system_42",
  "brand": "visa", "last4": "4242", "expMonth": 12, "expYear": 2030,
  "createdAt": "…"
}
```

**Why return the existing card instead of an error:** a customer saving the same card twice is a normal thing to do, not a mistake. Returning the existing card (matched by fingerprint within the same `customerId`) keeps the customer's card list free of duplicates without making the merchant handle an error.

### `GET /cards?customerId=…` → paginated list of cards

### `GET /cards/:id` → card

### `DELETE /cards/:id` → `204`

Permanently deletes the encrypted card number. Payments made with it keep their display snapshot (`brand`, `last4`).

Errors: `409 conflict` if a `pending` payment is still waiting to be authorized with this card.
**Why block deletion then:** the worker needs the card number to authorize. Deleting it would make that payment fail for a reason the merchant didn't intend.

## 5.8 Payments

### Payment object

```json
{
  "id": "pay_3f9c…",
  "status": "captured",
  "amount": 2500,
  "currency": "USD",
  "captureMethod": "automatic",
  "amountCaptured": 2500,
  "amountRefunded": 0,
  "customerId": "cus_from_my_system_42",
  "description": "Order #1042",
  "metadata": { "orderId": "1042" },
  "paymentMethod": { "type": "card", "cardId": "card_9f2e…", "brand": "visa", "last4": "4242", "expMonth": 12, "expYear": 2030 },
  "authorizationCode": "A1B2C3",
  "failure": null,
  "pendingAction": null,
  "history": [
    { "type": "created",    "at": "…" },
    { "type": "authorized", "at": "…", "amount": 2500 },
    { "type": "captured",   "at": "…", "amount": 2500 }
  ],
  "createdAt": "…",
  "updatedAt": "…"
}
```

### `POST /payments` ⟳: create

Request:

```json
{
  "amount": 2500,
  "currency": "usd",
  "token": "tok_51d0…",
  "saveCard": true,
  "customerId": "cus_from_my_system_42",
  "captureMethod": "automatic",
  "description": "Order #1042",
  "metadata": { "orderId": "1042" }
}
```

| Field | Required | Rules |
|---|---|---|
| `amount` | ✓ | Integer, 1 – 99,999,999 (minor units) |
| `currency` | ✓ | One of the supported codes (case-insensitive) |
| `token` \| `cardId` \| `card` | exactly one | See [Lifecycle §3.3](03-payment-lifecycle.md#33-creating-a-payment) |
| `saveCard` | – | Boolean, default `false`. Not allowed with `cardId` |
| `customerId` | – | String ≤ 100 chars |
| `captureMethod` | – | `automatic` (default) or `manual` |
| `description` | – | String ≤ 500 chars |
| `metadata` | – | ≤ 20 string keys/values |

Response **`202 Accepted`**: the payment with `"status": "pending"`. The outcome arrives by webhook, or by polling `GET /payments/:id`.

Errors: `400` validation · `400` token expired or already used · `404` unknown `cardId`.

### `GET /payments?status=&customerId=&limit=&offset=` → paginated list

### `GET /payments/:id` → payment

### `PATCH /payments/:id`

Request (at least one field):

```json
{ "description": "Order #1042 (gift)", "metadata": { "giftWrap": "yes", "orderId": null } }
```

- `metadata` is **merged** into the existing metadata. Setting a key to `null` deletes it.
- Any other field (`amount`, `status`, …) → `400` naming the field.
- Emits `payment.updated`. Response `200` with the payment.

**Why merge instead of replace:** two systems can each manage their own metadata keys without overwriting each other's.

### `POST /payments/:id/capture` ⟳

```json
{ "amount": 2000 }
```

`amount` is optional and defaults to the full authorized amount. Response **`202`** with `status: "capturing"` and `pendingAction` filled in.
Errors: `409 invalid_state` unless the payment is `authorized` · `400` amount above the authorized amount.

### `POST /payments/:id/refund` ⟳

```json
{ "amount": 500 }
```

`amount` is optional and defaults to the remaining refundable amount. Response **`202`** with `status: "refunding"`.
Errors: `409 invalid_state` unless the payment is `captured` or `partially_refunded` · `400` amount above the refundable amount.

### `POST /payments/:id/cancel` ⟳

No body. Response **`202`** with `status: "cancelling"`.
Errors: `409 invalid_state` unless the payment is `authorized`.

## 5.9 Webhooks

### Webhook endpoint object

```json
{
  "id": "we_b20c…",
  "url": "https://acme.test/webhooks/payments",
  "events": ["payment.captured", "payment.failed"],
  "enabled": true,
  "description": "Order fulfilment",
  "createdAt": "…",
  "updatedAt": "…"
}
```

### `POST /webhooks`: register

Request:

```json
{ "url": "https://acme.test/webhooks/payments", "events": ["*"], "description": "All events" }
```

Response `201`: the endpoint plus **`"secret": "whsec_…"`, shown only this once**.

Validation: URL rules in [Security §4.8](04-security.md#48-ssrf-protection-for-webhook-urls); `events` is `["*"]` or a non-empty list of known event types; at most **10 endpoints per merchant** (an 11th → `409 conflict`).

**Why cap at 10:** every event creates one delivery per matching endpoint. Without a cap, one merchant could multiply the write load on the shared database file.

### `GET /webhooks` · `GET /webhooks/:id`

Return endpoints. The secret is **never** included.

### `PATCH /webhooks/:id`

Any of `url`, `events`, `enabled`, `description`. Disabling (`enabled: false`) stops new deliveries from being created for that endpoint, **and** pending deliveries to it are marked `failed` ("endpoint disabled") instead of being sent. The events stay available through `GET /events`.

**Why not send deliveries that were already queued:** a merchant usually disables an endpoint because it's broken or being replaced, and sending to it anyway would surprise them. Nothing is lost: the events can be fetched for reconciliation.

### `DELETE /webhooks/:id` → `204`

Pending deliveries to that endpoint are marked `failed` ("endpoint deleted") and not sent.

### `POST /webhooks/:id/rotate-secret` → `200`

`{ "secret": "whsec_…" }`. The old secret stops working **immediately**: deliveries from now on are signed with the new one.

### `GET /webhooks/:id/deliveries?status=&limit=&offset=` → paginated list

```json
{
  "id": "whd_e81a…", "eventId": "evt_44c2…", "status": "failed",
  "attempts": 8, "lastResponseStatus": 500, "lastError": "HTTP 500",
  "lastAttemptAt": "…", "nextAttemptAt": null, "createdAt": "…"
}
```

**Why expose the delivery log:** when a merchant says "we never got the webhook", this shows exactly what happened (status codes, errors, timings) without anyone digging through server logs.

## 5.10 Events

### `GET /events?type=&limit=&offset=` · `GET /events/:id`

```json
{
  "id": "evt_44c2…",
  "type": "payment.captured",
  "data": { "object": { "id": "pay_3f9c…", "status": "captured", "…": "…" } },
  "createdAt": "…"
}
```

Events are kept for `RETENTION_DAYS` (default 7).

**Why an events API when webhooks exist:** webhooks can be missed (receiver down, all retries exhausted). The events list lets a merchant **reconcile**: fetch everything since their last processed event and catch up.

## 5.11 Tests

These are API-level tests: the real app over HTTP. Payment states are tested in [Lifecycle §3.6](03-payment-lifecycle.md#36-tests), security rules in [Security §4.13](04-security.md#413-tests), webhooks in [Webhooks §6.8](06-webhooks.md#68-tests).

### Auth matrix and status codes

| Test | Checks | Edge case guarded |
|---|---|---|
| **Every endpoint × {no key, pk, sk}**, table-driven, against the index in §5.2 | Auth column of the endpoint index | An endpoint added without auth, or with the wrong key type |
| `/health` and `POST /merchants` work with no key, and ignore a key if one is sent | Public endpoints | – |
| Every endpoint returns its documented success status (`200`/`201`/`202`/`204`) | Status codes | A `200` where clients expect a `202`, and clients misreading the outcome |
| The body of each success response matches the documented example's keys | Response shapes | Docs and responses drifting apart |

### Request validation

| Test | Checks | Edge case guarded |
|---|---|---|
| Unknown body field (e.g. `ammount`) → 400 naming it, on every endpoint that has a body | Strict validation | Typos silently ignored |
| Body that isn't a JSON object (`[]`, `"x"`, `null`) → 400 | Top-level shape | A crash on unexpected JSON types |
| Missing or non-JSON `Content-Type` with a body → 400 | Body parsing | A request processed with an empty body |
| Body over 100 kb → `413` | Size limit | Memory exhaustion via huge bodies |
| Repeated query parameter (`?status=a&status=b`) → 400 | Query validation | An array arriving where a string is expected |

### Pagination

| Test | Checks | Edge case guarded |
|---|---|---|
| `limit` 1 and 100 accepted. 0, 101, `abc`, `1.5` → 400 | Bounds | Unbounded responses |
| `offset` beyond `total` → empty `data` with the correct `total` | Paging past the end | An error, or a wrong total, on the last page |
| 25 records created within the same millisecond → paging through all pages returns each **exactly once**, in a stable order | `id` as a tie-breaker | Records skipped or repeated between pages |

### Idempotency

| Test | Checks | Edge case guarded |
|---|---|---|
| Same key + same body → same status and body, with `Idempotent-Replayed: true`. Only one payment exists | Replay | Double charge on retry |
| Same key + same fields in a different key order → replay, not 422 | Canonical JSON | Spurious 422s from different JSON libraries |
| Same key + different body → `422` | Misuse detection | Replaying a response for a different request |
| Same key while the first is still running (blocking processor) → `409 idempotency_in_progress` | In-progress guard | Two requests both doing the work |
| Reservation left `in_progress` (simulated crash), clock +61 s → the retry runs | Abandoned reservations | A key blocked for 24 h after a crash |
| Same key on two different endpoints → independent | Per-endpoint scope | A refund replaying a capture's response |
| Key reused after 24 h (fake clock) → processed again | Expiry | – |
| First request fails with a 5xx → the retry runs again | 5xx not stored ([Error handling §8.11](08-error-handling.md#811-errors-and-idempotency)) | A permanent replay of a temporary failure |

### Merchants, tokens and cards

| Test | Checks | Edge case guarded |
|---|---|---|
| Sign-up returns both keys, and they work immediately | Sign-up | – |
| `GET /api-keys` shows the full `pk` but only the last 4 characters of the `sk` | Key listing | Secret keys exposed after creation |
| Token response contains `brand`/`last4`, never the number or CVC | Token view | Card data echoed back to the browser |
| Token for an already-expired card → 400. Number failing Luhn → 400. `cvc` of 2 or 5 digits → 400 | Token validation | Obviously invalid cards reaching the worker |
| Same card saved twice for the same `customerId` → second call `200` with the **same** card. For a different `customerId` → a new card | Duplicate detection (§5.7) | Duplicate cards in a customer's wallet, or cards merged across customers |
| Same card saved twice with **no** `customerId` → deduplicated within the "no customer" group | `null` handled like any other value | Duplicates when merchants don't use customer IDs |
| `DELETE` the same card twice → `204`, then `404` | Deletion | – |
| `GET /cards?customerId=x` returns only that customer's cards | Filter | – |

### Payments and webhook endpoints

| Test | Checks | Edge case guarded |
|---|---|---|
| `PATCH` metadata merge: `null` deletes, new keys are added, existing keys are overwritten. A merge that would exceed 20 keys → 400. Empty body → 400 | Merge rules | The 20-key cap bypassed through repeated merges |
| `GET /payments?status=…&customerId=…` filters correctly, and combined filters intersect | Filters | – |
| 11th webhook endpoint → `409 conflict` | Endpoint cap | Write amplification from unlimited endpoints |
| `POST /webhooks` returns `secret` once. `GET` never includes it | Secret shown once | Secret readable later via the API |
| `GET /events?type=payment.captured` returns only that type, newest first | Events filter | – |
