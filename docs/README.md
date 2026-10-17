# Payment Service: Design Documentation

A microservice that **simulates** card payment processing. Merchants sign up, get API keys, save customer cards, create payments that are processed **asynchronously**, and receive **webhooks** when a payment changes state. All data is stored in a single **JSON file** on disk.

> These documents are written *before* the code. Each one explains **what** we're building and **why** each decision was made, so anyone joining the project can follow the reasoning rather than just the result.

## How to read these docs

| # | Document | Answers |
|---|---|---|
| 1 | [Architecture](01-architecture.md) | What are the moving parts and how do they talk to each other? |
| 2 | [Data model](02-data-model.md) | What do we store, in what shape, and why? |
| 3 | [Payment lifecycle](03-payment-lifecycle.md) | What states does a payment go through, and how does async processing work? |
| 4 | [Security](04-security.md) | How are API keys, card data and secrets protected? |
| 5 | [API reference](05-api.md) | Every endpoint: who can call it, what it accepts, what it returns |
| 6 | [Webhooks](06-webhooks.md) | How events are produced, delivered, retried and verified |
| 7 | [Persistence](07-persistence.md) | How the JSON file database gives us transactional (ACID-like) behaviour |
| 8 | [Error handling](08-error-handling.md) | How errors are classified, returned to clients, logged securely, and handled in background processes |
| 9 | [Testing strategy](09-testing.md) | How tests are structured and kept deterministic. Each doc's **Tests** section lists what's tested and which edge case each test guards |

New to the project? Read 1 → 3 → 5 first. Then read 4, 6, 7 and 8 for the details.

## Scope

**In scope**

- Merchant sign-up, which issues the first API keys
- Publishable keys (`pk_…`) for client-side card tokenization, and secret keys (`sk_…`) for server-side operations
- API key rotation on demand, with immediate revocation of the old key
- Saving cards (encrypted at rest), optionally tagged with a merchant-supplied `customerId`
- Creating, retrieving, listing and updating payments
- Asynchronous authorization, capture, refund and cancellation
- Webhook endpoints that receive signed events for every payment state change
- A simulated card processor with deterministic test cards

**Out of scope (non-goals)**

| Non-goal | Why it's excluded |
|---|---|
| **User authentication / identity verification** | Outside the scope of this project. See the note on open sign-up below |
| Real card networks or acquirers | It's a simulator; the processor is fake by design |
| Payment methods other than cards | Kept narrow on purpose so the card flow can be done thoroughly. The data model leaves room for more later (`paymentMethod.type`) |
| Multiple instances / horizontal scaling | The JSON file database is single-process by nature. See [Persistence](07-persistence.md#710-limitations) |
| PCI DSS compliance | This service stores card numbers *as a simulation of a vault*. A real system storing card numbers must be PCI DSS certified |
| Dashboards / UI | API only |

## Intentional decision: open merchant sign-up

`POST /merchants` is **unauthenticated on purpose**. Anyone can create a merchant account and receive API keys.

**Why:** User authentication (accounts, passwords, email verification, MFA) is **not part of this project's scope**. Leaving sign-up open lets the service be used and tested end-to-end without building an identity system. Every merchant's data is still fully isolated from every other merchant's, because every request after sign-up is authenticated with that merchant's own API key.

**What this means:**

- This is **not a vulnerability that was missed**. It's a known, documented trade-off.
- The endpoint is rate-limited by IP so it can't be flooded trivially. See [Security](04-security.md#49-rate-limiting).
- **Before any real deployment**, put sign-up behind a proper identity layer (an admin token, an auth provider, or an invite flow).

## Glossary

| Term | Meaning |
|---|---|
| **Merchant** | A business using the service to accept payments. Owns all other resources |
| **Publishable key (`pk_test_…`)** | A public key, safe to put in a browser or mobile app. It can **only** create card tokens |
| **Secret key (`sk_test_…`)** | A private key for the merchant's server. Can do everything |
| **Token (`tok_…`)** | A single-use, short-lived reference to card details, created client-side with a publishable key |
| **Saved card (`card_…`)** | Card details stored encrypted for reuse, optionally tagged with a `customerId` |
| **Authorization** | The processor confirms the card can pay, and the funds are reserved |
| **Capture** | The reserved funds are actually taken |
| **Minor units** | The smallest unit of a currency (cents for USD). All amounts are integers in minor units |
| **Outbox** | A table of events written in the same transaction as the change that caused them, then delivered later |
| **Job** | A queued unit of async work (authorize, capture, refund, cancel) picked up by the payment worker |

> `test` appears in every key prefix (`pk_test_`, `sk_test_`) because this is a simulator, and nothing it does moves real money. The prefix makes that obvious wherever a key shows up: logs, config files, screenshots.

## Tech stack at a glance

| Choice | Why |
|---|---|
| **Node.js ≥ 20 + TypeScript (strict)** | Type safety across the layers. Catches whole classes of bugs, like mixing up amounts or IDs, at compile time |
| **Express 5** | Widely known, minimal, and v5 forwards errors from async handlers to the error middleware automatically, so there's no wrapper boilerplate |
| **zod** | One schema provides both runtime request validation and the TypeScript type, so they can't drift apart |
| **Hand-rolled JSON file DB** | Requirement for the project. Building it ourselves lets us guarantee serialized, all-or-nothing transactions. See [Persistence](07-persistence.md) |
| **Node `crypto`** | AES-256-GCM, HMAC-SHA256 and secure random values are built in, so no third-party crypto dependencies are needed |
| **`node:test`** | Built-in test runner, so there's no extra framework to install or configure |
| **yarn** | Package manager preferred by the project owner |
