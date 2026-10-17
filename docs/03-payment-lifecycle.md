# 3. Payment Lifecycle

## 3.1 Why everything is asynchronous

Real card networks are slow and unreliable. They time out, rate-limit and have outages. If an HTTP request waited for the processor:

- the client's connection would stay open for the whole processor call, and might time out, leaving the client unsure whether it was charged;
- a processor outage would turn directly into failed API requests;
- retrying a failed processor call would mean the *client* has to retry the whole request.

So every operation that talks to the processor (**authorize, capture, refund, cancel**) is **queued as a job**, and the API responds immediately with `202 Accepted`. A background worker does the slow part, retries temporary failures itself, and reports the outcome through webhooks and the payment's `status`.

## 3.2 State machine

```mermaid
stateDiagram-v2
    [*] --> pending: POST /payments

    pending --> authorized: authorize job approved (manual capture)
    pending --> capturing: authorize job approved (automatic capture)
    pending --> failed: declined, or retries exhausted

    authorized --> capturing: POST /capture
    authorized --> cancelling: POST /cancel

    capturing --> captured: capture job succeeded
    capturing --> authorized: capture failed (retries exhausted)

    cancelling --> cancelled: cancel job succeeded
    cancelling --> authorized: cancel failed

    captured --> refunding: POST /refund
    partially_refunded --> refunding: POST /refund

    refunding --> partially_refunded: succeeded, money left to refund
    refunding --> refunded: succeeded, fully refunded
    refunding --> captured: failed (was captured)
    refunding --> partially_refunded: failed (was partially_refunded)

    failed --> [*]
    cancelled --> [*]
    refunded --> [*]
```

`failed`, `cancelled` and `refunded` are **terminal**: no further actions are possible.

### Allowed actions per status

| Status | capture | refund | cancel | PATCH (description/metadata) |
|---|:-:|:-:|:-:|:-:|
| `pending` | ✗ | ✗ | ✗ | ✓ |
| `authorized` | ✓ | ✗ | ✓ | ✓ |
| `capturing` / `refunding` / `cancelling` | ✗ | ✗ | ✗ | ✓ |
| `captured` | ✗ | ✓ | ✗ | ✓ |
| `partially_refunded` | ✗ | ✓ | ✗ | ✓ |
| `failed` / `cancelled` / `refunded` | ✗ | ✗ | ✗ | ✓ |

A disallowed action returns `409 invalid_state`, with a message naming the current status.

| Rule | Why |
|---|---|
| **No cancel while `pending`** | The worker may already be talking to the processor. Allowing cancel here would create a race between "cancelled" and "authorized". The client waits for `authorized`, then cancels |
| **No actions while an action is in flight** | Prevents, for example, two refunds that together exceed the captured amount. One pending action at a time makes the amount checks reliable |
| **PATCH is always allowed** | Description and metadata are the merchant's own labels. They don't affect money, so there's no reason to lock them |
| **Status can only change through actions** | `PATCH` can't set `status` or `amount`, so nobody can bypass the state machine |
| **Partial capture releases the rest** | Matches how card networks behave: one capture per authorization. Capturing $6 of a $10 authorization leaves $4 that can't be captured later |

### Amount rules

| Action | `amount` | Rule |
|---|---|---|
| capture | optional, defaults to the full `amount` | `1 ≤ amount ≤ payment.amount` |
| refund | optional, defaults to everything still refundable | `1 ≤ amount ≤ amountCaptured − amountRefunded` |

**Why the amount checks happen when the request is made (not in the worker):** the client gets an immediate `400` for an impossible amount, instead of an accepted request that fails a few seconds later.

## 3.3 Creating a payment

A payment needs a card from **exactly one** of three sources:

| Source | Field | Typical caller | Notes |
|---|---|---|---|
| Token | `token: "tok_…"` | Merchant server, after the browser tokenized the card with the `pk` | **Recommended.** The raw card number never touches the merchant's server |
| Saved card | `cardId: "card_…"` | Merchant server, for a returning customer | No CVC is needed: it was checked when the card was saved, and it's never stored (see [Security §4.5](04-security.md#45-cvc)) |
| Raw card | `card: { number, expMonth, expYear, cvc }` | Merchant server (secret key only) | For server-side testing and simple integrations |

`saveCard: true` (with a `token` or `card`) also saves the card to the vault, tagged with `customerId` if one is given, **but only if the authorization is approved**. A declined card is discarded like any unsaved card, and `paymentMethod.cardId` is set only once the card is actually saved.

**Why save only on approval:** a card that was just declined (insufficient funds, card declined, expired) is very likely to be declined again. Saving it would give the merchant a "saved card" that doesn't work, and keep encrypted card data that serves no purpose.

**Why three sources instead of tokens only:** tokens are the secure default for real checkouts, but requiring them for every test would mean two calls per payment. Raw cards are allowed **only with the secret key**, so the browser-facing publishable key can never create payments directly.

```mermaid
sequenceDiagram
    autonumber
    participant B as Browser
    participant M as Merchant server
    participant API as Payment service
    participant DB as JsonDb
    participant W as Payment worker
    participant P as Simulated processor
    participant R as Webhook receiver

    B->>API: POST /tokens (pk) { card }
    API->>DB: transact: unsaved Card (encrypted number) + Token
    API-->>B: 201 { id: tok_... }
    B->>M: tok_...
    M->>API: POST /payments (sk) { token, amount, currency }
    API->>DB: transact: consume token, Payment(pending), Job(authorize), Event(payment.created), deliveries
    API-->>M: 202 { id: pay_..., status: pending }

    W->>DB: transact: claim job (lease 30s)
    W->>DB: read + decrypt card number
    W->>P: authorize(number, amount)
    P-->>W: approved, authCode
    W->>DB: transact: Payment(capturing), Job(capture), Event(payment.authorized), delete unsaved card
    W->>DB: transact: claim capture job
    W->>P: capture(authCode, amount)
    P-->>W: ok
    W->>DB: transact: Payment(captured), Event(payment.captured)

    Note over API,R: Webhook dispatcher delivers each event independently
    API-->>R: payment.created, payment.authorized, payment.captured
```

### What happens to the card number

```mermaid
flowchart LR
    A["Card number arrives<br/>POST /tokens or /payments"] --> B["Validated<br/>Luhn, expiry, CVC format"]
    B --> C["CVC discarded<br/>never written to disk"]
    B --> D["Number encrypted<br/>AES-256-GCM into Card record"]
    D --> E{"Already saved, or<br/>saveCard and approved?"}
    E -->|"no"| F["Deleted right after<br/>authorization"]
    E -->|"yes"| G["Kept encrypted until<br/>DELETE /cards/:id"]
```

## 3.4 The payment worker

### Loop

```mermaid
flowchart TD
    T["Tick every 500 ms"] --> Q{"Free slots?<br/>running < WORKER_CONCURRENCY"}
    Q -->|"no"| T
    Q -->|"yes"| S["Find due jobs:<br/>queued and runAt <= now,<br/>or running with an expired lease"]
    S --> C["transact: claim job<br/>status = running, attempts + 1,<br/>lockedUntil = now + 30s"]
    C --> X["Call processor<br/>outside any transaction"]
    X --> R{"Result"}
    R -->|"success"| OK["transact: apply transition,<br/>emit event, mark job succeeded"]
    R -->|"permanent decline"| DEC["transact: apply failure,<br/>emit event, mark job succeeded"]
    R -->|"transient error"| RT{"attempts < maxAttempts?"}
    RT -->|"yes"| RS["transact: status = queued,<br/>runAt = now + backoff"]
    RT -->|"no"| FAIL["transact: give up,<br/>revert or fail payment,<br/>emit event, job failed"]
```

| Decision | Why |
|---|---|
| **Claim and apply in separate transactions; processor call outside both** | A transaction blocks every other write (see [Persistence](07-persistence.md#isolation)). Holding one open during a 300 ms processor call would stall the whole API |
| **Lease of 30 s** | If the process dies mid-job, the job becomes claimable again after 30 s. Nothing gets stuck forever |
| **Check ownership when applying** | The apply step checks that the job is still `running` with the same `attempts` number. If the lease expired and another run took over, the stale result is thrown away, so a transition is never applied twice |
| **Declines count as job success** | A decline is a valid *answer* from the processor, not a failure to get one, so retrying wouldn't change it. Only **transient** errors are retried |
| **Concurrency limit (default 5)** | Bounds memory use and the number of simultaneous processor calls |

### Retry schedule (transient errors)

| Attempt | Delay before it |
|---|---|
| 1 | immediately |
| 2 | 2 s |
| 3 | 4 s |
| 4 | 8 s |
| 5 | 16 s |

That's exponential backoff, `2^(attempt-1)` seconds, with up to 5 attempts in about 30 s.

**Why exponential backoff:** if the processor is overloaded, retrying straight away adds to the load. Waiting longer each time gives it room to recover.

### When retries run out

| Job type | Payment ends up | Event |
|---|---|---|
| authorize | `failed` with `failure.code = "processing_error"` | `payment.failed` |
| capture / refund / cancel | Back to `pendingAction.previousStatus` | `payment.action_failed` (includes which action failed and why) |

**Why revert instead of failing the payment:** a failed *refund* doesn't change the fact that the money was captured. Marking the payment `failed` would misrepresent where the money is. Reverting tells the truth: the action didn't happen, and the merchant can try again.

### At-least-once execution

Because of leases and retries, a job can occasionally **run more than once**, for example when the process crashes after calling the processor but before committing the result. Every processor call carries the `job.id` as an idempotency reference, so a real gateway would recognise the repeat. The simulated processor accepts it and stays consistent.

**Why not exactly-once:** exactly-once across a network call is impossible to guarantee in general. The standard, honest approach is at-least-once execution plus idempotent operations.

## 3.5 Simulated processor

The processor is a stand-in for a card network. It's deterministic, so every path can be tested on demand.

### Test cards

Any card number that passes the Luhn check and isn't listed below is **approved**.

| Card number | Result | Kind |
|---|---|---|
| `4242 4242 4242 4242` | Approved (Visa) | – |
| `5555 5555 5555 4444` | Approved (Mastercard) | – |
| `4000 0000 0000 0002` | `card_declined` | Permanent |
| `4000 0000 0000 9995` | `insufficient_funds` | Permanent |
| `4000 0000 0000 0069` | `expired_card` | Permanent |
| `4000 0000 0000 0127` | `incorrect_cvc` | Permanent |
| `4000 0000 0000 0119` | `processing_error` | **Transient**: retried until attempts run out, then `failed` |
| Any card with a past expiry date | `expired_card` | Permanent |

**Why these numbers:** they follow the widely used Stripe test-card convention, so they're familiar to anyone who has integrated a payment API, and they pass the Luhn check.

### Behaviour knobs

| Setting | Effect | Why it exists |
|---|---|---|
| `PROCESSOR_LATENCY_MS` (300) | Every call waits this long | Makes the async flow visible: you can watch `pending` change to `captured` |
| `PROCESSOR_FAILURE_RATE` (0) | Probability that **any** call (including capture, refund, cancel) returns a transient error | The only way to exercise the retry and revert paths for capture, refund and cancel, which otherwise always succeed |

### Interface

```ts
interface Processor {
  authorize(input: { reference: string; cardNumber: string; expMonth: number; expYear: number;
                     amount: number; currency: string }): Promise<ProcessorResult<{ authorizationCode: string }>>;
  capture(input: { reference: string; authorizationCode: string; amount: number }): Promise<ProcessorResult>;
  refund(input:  { reference: string; authorizationCode: string; amount: number }): Promise<ProcessorResult>;
  cancel(input:  { reference: string; authorizationCode: string }): Promise<ProcessorResult>;
}

type ProcessorResult<T = {}> =
  | ({ outcome: 'success' } & T)
  | { outcome: 'declined'; code: string; message: string }    // permanent
  | { outcome: 'error'; code: string; message: string };      // transient, retry
```

**Why an interface:** the worker depends on this interface, not on the simulator. A real gateway adapter could be added later without touching the worker.

## 3.6 Tests

Worker tests use the fake clock, `tickOnce()` and the scripted processor described in [Testing strategy §9.3](09-testing.md#93-determinism).

### State machine

| Test | Checks | Edge case guarded |
|---|---|---|
| **Every status × every action** (10 statuses × capture/refund/cancel), table-driven: allowed → `202` + transitional status. Disallowed → `409 invalid_state` naming the current status | The "allowed actions" table (§3.2), exhaustively | One forgotten combination letting money move from the wrong state |
| `PATCH` succeeds in every status, including terminal ones | Labels never lock | – |
| `PATCH` with `status` or `amount` → 400 naming the field | Status changes only through actions | Bypassing the state machine |
| Cancel while `pending` → 409 | No cancel during authorization | Race between "cancelled" and "authorized" |

### Creating payments

| Test | Checks | Edge case guarded |
|---|---|---|
| No card source → 400. Two sources (`token` + `cardId`) → 400 | Exactly one source | Ambiguity over which card gets charged |
| `saveCard` with `cardId` → 400 | Rule in [API §5.8](05-api.md#58-payments) | Re-saving an already saved card |
| Token already used → 400. Expired token (fake clock, +15 min 1 ms) → 400 | Single use + expiry | Replaying a token that leaked from a browser |
| Another merchant's token → same 400 as an unknown token | Isolation, without revealing that it exists | Learning about other merchants' tokens |
| Raw `card` with a **publishable** key → 403 | Browsers can't create payments | A public key creating charges directly |
| Response is `202` with `status: "pending"`. `payment.created` event recorded in the same transaction | Async creation (§3.1) | – |

### Outcomes (scripted processor)

| Test | Checks | Edge case guarded |
|---|---|---|
| Automatic capture: `pending` → `capturing` → `captured`. Events `authorized` then `captured`. Two jobs | Two-job automatic capture | Re-authorizing when only the capture failed |
| Manual capture: `pending` → `authorized`, then capture → `captured` | Manual flow | – |
| Decline → `failed` with the processor's code. **Exactly one attempt** | Declines aren't retried | Retrying a decline (pointless, and can look like card testing) |
| Every test card in §3.5 → its documented outcome | Test-card table | Docs and behaviour drifting apart |
| Card that expires this month, tokenized on the last day; fake clock moves into next month before the worker runs → `expired_card` | Expiry checked at authorization, not only at tokenization | A card expiring between checkout and processing |

### Amounts

| Test | Checks | Edge case guarded |
|---|---|---|
| Capture `amount` = authorized amount → OK. `amount + 1` → 400. `0` → 400 | Capture bounds | Capturing more than was authorized |
| Partial capture of 600/1000, then refund 601 → 400. Refund 600 → `refunded` | Refunds are bounded by **captured**, not authorized, amount | Refunding money that was never taken |
| Refunds 300 + 300 + 400 of 1000 → `partially_refunded`, `partially_refunded`, `refunded` | Running total | Off-by-one at the final refund |
| No `amount` on capture/refund → full / remaining amount | Defaults | – |
| Second capture after a partial capture → 409 | One capture per authorization | Capturing the released remainder |

### Concurrency

| Test | Checks | Edge case guarded |
|---|---|---|
| 10 simultaneous full refunds of one payment → exactly **one** `202`, nine `409`. Afterwards `amountRefunded ≤ amountCaptured` | One pending action at a time | Double refund through a race |
| Refund while `refunding` → 409 | Same rule, sequential | – |
| 20 due jobs, `WORKER_CONCURRENCY=5`, processor in blocking mode → never more than **5** calls in flight | Concurrency limit | The worker overwhelming the processor or memory |
| A slow tick (blocking processor) and another `tickOnce()` → second tick doesn't run concurrently | No overlapping ticks | Two ticks together claiming more than the limit |

### Retries, leases and recovery

| Test | Checks | Edge case guarded |
|---|---|---|
| Transient errors: retries at exactly +2 s, +4 s, +8 s, +16 s (fake clock). Not before | Backoff schedule (§3.4) | Hammering a struggling processor |
| 5 transient errors on authorize → `failed`, `failure.code = processing_error`, `payment.failed` | Giving up | Retrying forever |
| Capture fails permanently → back to `authorized`, `payment.action_failed` | Revert, not fail | Marking captured money as failed |
| Refund fails permanently from `partially_refunded` → back to `partially_refunded` | `previousStatus` restored precisely | Reverting to the wrong status |
| Job claimed, run never finishes; clock +31 s → job reclaimed and completed. The first run's late result is **discarded** | Lease + ownership check | A stuck job, or the same transition applied twice |
| Queued jobs in the DB file at startup → processed after restart | Durability | Work lost across restarts |

### Card handling

| Test | Checks | Edge case guarded |
|---|---|---|
| Unsaved card deleted after authorization, both on approval **and** on decline | Card data kept no longer than needed | Encrypted card numbers piling up |
| `saveCard: true` + approval → card saved with `customerId`, `paymentMethod.cardId` set | Save on approval | – |
| `saveCard: true` + **decline** → card not saved, `cardId` stays `null` | Save only on approval | Saving cards that don't work |
| After any payment, the DB file contains no CVC used in the request | CVC never stored ([Security §4.5](04-security.md#45-cvc)) | Storing data PCI DSS forbids |
| `DELETE /cards/:id` while a `pending` payment uses the card → 409. After authorization → 204 | Deletion guard | Deleting the card the worker is about to use |
