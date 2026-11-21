# Pialy — design

Date: 2026-11-14 · Event: Cursor Hackatón México, CDMX kickoff · Delivery: Sun 2026-11-15 13:00 CDMX (internal target 11:00)
Product record: `PRODUCT.md` · Visual direction: `design/mockups/niman.html` (approved)

## 1. Intent

Pialy lets a business that works by appointment (barbería, estética, consultorio) require a CoDi deposit to hold a slot. The slot is held while the CoDi payment request is alive and becomes a confirmed appointment only when the bank confirms through pey. The owner learns about it without opening the bank app or trusting a screenshot.

Why: the hackathon scores CoDi/pey use 30%, impact 25%, technical execution 15%, UX 15%, originality 15%. The team chose to optimize for the pey/CoDi integration and for adoption by the business that collects. Deposits are a proven no-show remedy (Booksy reports 20% fewer cancellations; Fresha claims 89% fewer no-shows, both vendor figures); no Mexican booking tool was found charging deposits over CoDi.

Relationship to the national entry ("Seeb", due 2026-12-12): only the payment layer (`packages/core`, `packages/pey-adapter`) is meant to be reused. Seeb's product is decided later. Only one of the two may be submitted nationally.

## 2. Goals, non-goals, anti-goals

Goals (Sunday):
- A judge opens the public URL on a phone, picks a slot, pays $0.01 with CoDi push (or QR), and both the customer page and the owner board update live; the board speaks.
- Every edge case the organizers listed is a visible, demonstrable state: late payment, failure, expiry, duplicate webhook, double payment, refund due.
- Payment layer isolated so Seeb can import it.

Non-goals: multi-business/tenancy, accounts for customers, staff roles, services catalog editing, CFDI, refunds through an API (pey has none), voice input, native apps, hardware.

Anti-goals (fail even if it "works"):
- Any path where the client or a screenshot can mark something paid.
- A slot booked twice, or one webhook applied twice.
- A dead end for the customer (no next action while waiting).
- Secrets in the repo or client bundle; full phone numbers in DB or logs.

## 3. Constraints (verified)

- pey API, production only, base `https://api.pey.mx`, Bearer API key. All charges $0.01 MXN, fixed server-side.
- `POST /codi/pn`: `amount`, `phoneNumber` (10 digits), `concept`, `expiration` ≥ 360 (default 360), `numRef` ≤ 7 digits, `metadata` ≤ 50 scalar pairs. Returns `transactionId` (ULID), `codiId`.
- `POST /codi/qr`: `amount`, `concept`, `expiration` 0 or ≥ 360, `numRef`, `metadata`. Returns `id` (Banxico IDC), `qrString`. A QR can be paid more than once.
- `GET /transaction/{id}` → `status` PENDING | PAID, `amountBreakdown.base`, `metadata.trackingKey`. `GET /transaction/codi/qr/{idc}` → up to 20 transactions of a QR.
- Webhooks: Standard Webhooks signature; `webhook-id` header is the idempotency key. Events `codi.pn.payment_received` (`transactionId`, `numRef`, `amount`, `datePaid`, `metadata` with `trackingKey`, `bankCode`, `clabe`, `externalMetadata` = what we sent) and `codi.qr.payment_received` (adds `codiQrId`). Tracking key and payer bank code therefore arrive in the webhook itself (per pey's documented example; confirm with the first real capture). Retry policy undocumented: the sweeper is a primary confirmation path, not only a fallback. No expired/rejected event, no refund endpoint. 503 = maintenance.
- Hackathon sheet: register the pre-authorized CLABEs in portal.pey.mx; test payments are not refunded. Rules §7: no unsolicited mass charges, no charging on behalf of third parties; name must not include "pey"/"CoDi".
- Railway Hobby plan (verified in dashboard). Vercel Hobby crons are daily-only (verified), one reason serverless was rejected.

## 4. Approaches considered

| Decision | Options | Chosen | Why |
|---|---|---|---|
| Product | Listo (orders), split bill, voice charge + receipt, deposit booking (idea 4), quote (3), collections (19) | **Deposit booking** | Uses CoDi expiry as the hold; edge cases natural; many payers per business; voice input dropped as unreliable |
| Projects | Pialy = core of Seeb; two unrelated projects; shared payment layer | **Shared payment layer** | Seeb free to be any product; hard part reused |
| Runtime | Next.js on Vercel; single Node server; NestJS + separate SPA | **Single Node server (Fastify) on Railway** | SSE, in-process sweeper and raw-body webhook with no extra services; one origin |
| DB | Supabase; Railway Postgres | **Railway Postgres** | One provider, private network; standard Postgres keeps a later move open |
| Visual | 4 directions + canon | **Retícula** (Crouwel grid), neutral multi-giro | User choice |

## 5. Architecture

```
Customer phone ──HTTP/SSE──┐                 ┌── pey webhook (signed)
Owner phone ────HTTP/SSE──┤                 │
                          ▼                 ▼
        Railway service: Fastify (TS) — serves built React SPA
          ├─ routes: public booking, board (PIN), webhook, health
          ├─ packages/core: booking + payment state machine (pure)
          ├─ packages/pey-adapter: pey client, webhook verify/map
          ├─ sweeper (setInterval 15 s, pg advisory lock)
          └─ SSE hub (in-process EventEmitter)
                          ▼
                  Railway Postgres
```

Repo (pnpm workspaces): `packages/core`, `packages/pey-adapter`, `apps/server`, `apps/web`, `docs/`, `design/`.

- `packages/core` has no I/O imports. It defines `RailAdapter` (`createPushCharge`, `createQrCharge`, `getChargeStatus`, `verifyAndParseWebhook`), domain types and pure transition functions. Persistence goes through a small repository interface implemented in `apps/server`.
- `packages/pey-adapter` implements `RailAdapter` for pey: fetch with timeout, retries with backoff (max 3) on 5xx/503/network only, never on 4xx.
- Single Railway replica today. Scaling note: SSE fan-out moves to Postgres LISTEN/NOTIFY when there is more than one instance; the sweeper already takes an advisory lock.


## 5b. Core architecture (industry references)

Principle: engineered enough, not over-abstracted. Every pattern below exists because it removes a real failure mode in payments or booking.

| Reference | What we take | Where it lands |
|---|---|---|
| Domain-Driven Hexagon (Sairyss) | Modules by domain; each with `domain` (pure), `application` (use cases + ports), `infrastructure` (adapters). Dependencies point inward | Repo layout, lint-enforced boundaries |
| Stripe PaymentIntent | One intent per thing being paid, explicit lifecycle, many attempts | `PaymentIntent` (requires_payment → processing → succeeded / expired / canceled) with N `PaymentAttempt`s (push, qr) |
| Hyperswitch (Juspay) | Connector trait per processor; core never knows the processor; payment_intent vs payment_attempt split | `RailConnector` port; `@pialy/connector-pey` is connector #1 |
| Medusa payment providers | Provider normalizes webhooks into a domain action (`getWebhookActionAndData`) | `connector.parseWebhook(raw, headers) → { action: 'succeeded' \| 'ignored', attemptRef, amount, trackingKey }` |
| Brandur / Stripe idempotency keys | Atomic phases: commit local state before and after each foreign call; recovery points; client `Idempotency-Key` | `POST /bookings` and `/qr` take `Idempotency-Key`; phase 1 (hold+attempt) → pey call → phase 2 (store provider ids); sweeper recovers stuck attempts |
| Inbox / idempotent consumer | Insert event id with the side effect, same transaction | `webhook_inbox` + unique `provider_tx_id` |
| Transactional outbox | Events written in the same transaction as the change; relay publishes after commit | `outbox` table → relay → SSE (later: WhatsApp/email) |
| Standard Webhooks spec | Raw body, constant-time signature check, timestamp tolerance (5 min), `webhook-id` dedupe, fast 2xx | Webhook route |
| Postgres range exclusion | DB is the final gate against overlaps | Exclusion constraint above |
| Stripe money model | Integer minor units + currency | `Money` value object (`{ amountMinor: bigint-safe int, currency: 'MXN' }`) |
| RFC 9457 problem details | One error shape for the API | Error mapper in Fastify |

Packages:

- `packages/payments` — generic, no Pialy concepts. Domain: `PaymentIntent`, `PaymentAttempt`, `Money`, state machine, domain events (`PaymentSucceeded`, `PaymentExpired`, `LatePaymentReceived`). Application: `CreateIntent`, `StartAttempt`, `ApplyProviderEvent`, `ReconcileAttempt`. Ports: `RailConnector`, `PaymentRepository`, `UnitOfWork`, `Clock`, `EventPublisher`. Reused by Seeb.
- `packages/connector-pey` — implements `RailConnector`; HTTP client with timeout, retries on 5xx/503/network only, Zod-validated responses, maps pey payloads to domain actions. Fixture-based contract tests.
- `apps/server` — modules: `booking` (Pialy domain: `Booking`, `Slot`, hold/confirm/check-in rules, listens to payment events in the same unit of work), `business`, `realtime` (outbox relay → SSE), `http` (Fastify routes, auth, rate limits, problem details). Infrastructure: Drizzle repositories, migrations.
- `apps/web` — React SPA; talks only to the HTTP API.

Rules:

- Domain code is pure TypeScript: no Fastify, Drizzle, fetch or `Date.now()` (time comes from `Clock`).
- Cross-module calls go through application services or domain events, never another module's repository.
- Boundaries enforced with ESLint `import/no-restricted-paths` (CI fails on violation).
- Inputs validated with Zod at every edge (HTTP, env at boot, pey responses, webhooks). Env invalid → process exits.
- Structured logs (pino) with `requestId`, `bookingId`, `attemptId`; redaction of secrets and phone numbers.
- Strict TypeScript (`strict`, `noUncheckedIndexedAccess`), no `any`.

## 6. Domain model

Time zone `America/Mexico_City`. Amounts stored as integer cents.

| Table | Key columns |
|---|---|
| `business` | id, name, service_name, service_minutes, deposit_cents (=1), slot_minutes, hours (jsonb) — one seeded row |
| `bookings` | id, public_token (≥128-bit, unique), slot_start (timestamptz), status, customer_name?, phone_last4, phone_hash, hold_expires_at, confirmed_at, checked_in_at, late (bool), created_at |
| `payment_attempts` | id, booking_id, mode (`push`/`qr`), provider_tx_id?, provider_qr_id?, codi_id?, status (`awaiting`/`paid`/`expired`/`failed`), expires_at, created_at |
| `payment_events` | id, attempt_id?, booking_id?, provider_tx_id (unique), amount_cents, tracking_key, late, raw (jsonb), created_at |
| `webhook_inbox` | webhook_id (PK), event_type, received_at, processed_at, outcome |
| `flags` | id, booking_id, kind (`refund_due`, `unmatched_payment`), note, resolved_at, resolution_note |

Invariants enforced by the database:
- Exclusion constraint (`btree_gist`): `EXCLUDE USING gist (resource_id WITH =, during WITH &&) WHERE (status IN ('holding','confirmed','checked_in'))`, `during` = `tstzrange(start, end)`. No overlapping bookings even when services have different durations (multi-giro).
- `webhook_inbox.webhook_id` PK — a webhook is processed once.
- `payment_events.provider_tx_id` unique — the same bank payment applies once even if it arrives by webhook and by reconcile.

Booking states: `holding → confirmed → checked_in`; `holding → expired`; `expired → confirmed` (late, slot still free); `confirmed`/`expired` + extra payment → `refund_due` flag.

## 7. Flows

1. **Hold + push.** Customer picks a slot and types phone → `POST /api/bookings` creates booking `holding` (insert fails on the partial unique index if taken → "Ese horario se acaba de ocupar") and attempt `push`; server calls `/codi/pn` with amount 0.01, expiration 360, `numRef` = short booking number, `metadata.bookingId`, `metadata.attemptId`. `hold_expires_at = attempt.expires_at`.
2. **Waiting.** Page `/c/:token` shows countdown and bank steps via SSE. After 40 s it offers QR; desktop shows QR first.
3. **QR fallback.** `POST /api/bookings/:token/qr` creates attempt `qr` (`/codi/qr`, expiration 360) and extends `hold_expires_at` to its expiry. Max 3 attempts per booking.
4. **Payment applied** (single function `applyPayment`, one transaction): resolve attempt by `transactionId` (push) or `codiQrId` (QR), fallback `metadata.attemptId`; insert `payment_events` (unique tx id); then:
   - booking `holding` → `confirmed`;
   - booking `expired` and slot free → `confirmed`, `late = true`;
   - booking `expired` and slot taken, or booking already `confirmed`/`checked_in` → `refund_due` flag;
   - no booking found → `unmatched_payment` flag.
   Emit SSE to board and booking channels.
5. **Webhook.** Raw body → verify signature (401 on failure, logged without body) → insert `webhook_inbox` (conflict → return 200, no-op) → `applyPayment` → 200. Responds fast; no external calls inside.
6. **Sweeper (15 s).** For holds past `hold_expires_at`: query pey for each awaiting attempt (`/transaction/{id}` for push, `/transaction/codi/qr/{idc}` for QR); PAID → `applyPayment`; otherwise mark attempt `expired` and booking `expired`, emit SSE. Also checks late payments for recently expired bookings for 30 min.
7. **Pass + check-in.** Confirmed booking page becomes the pass with QR of `/v/:token`. Owner scans → `POST /api/bookings/:token/check-in` (PIN) sets `checked_in` once; repeat returns the time it was used.
8. **Refund.** Owner records manual SPEI refund with a note; flag resolved. No money moves through Pialy.

## 8. Interfaces

Public: `GET /api/slots?date=`, `POST /api/bookings`, `GET /api/bookings/:token`, `POST /api/bookings/:token/qr`, `GET /api/bookings/:token/events` (SSE), `GET /v/:token` (pass status).
Owner (PIN cookie): `POST /api/session`, `GET /api/board?date=`, `GET /api/board/events` (SSE), `POST /api/bookings/:token/check-in`, `POST /api/flags/:id/resolve`, `POST /api/slots/block`.
Webhook: `POST /api/webhooks/pey`. Health: `GET /healthz`.

Screens (from the approved mockup): `/` slot picker + phone sheet, `/c/:token` waiting → pass, `/negocio` board with "Activar sonido" and alerts, `/negocio/verificar/:token` check-in.

## 9. Security and abuse

- Secrets only in Railway variables: `PEY_API_KEY`, `PEY_WEBHOOK_SECRET`, `DATABASE_URL`, `BUSINESS_PIN`, `COOKIE_SECRET`, `PHONE_HASH_SALT`. `.env.example` only in repo.
- Amount never accepted from the client.
- Rate limits: 3 holds per phone hash / 10 min, 10 per IP / 10 min, 3 attempts per booking.
- Push only to the number the customer typed (consent); privacy notice on the form.
- Tokens ≥128 bits; booking numbers never used as lookup keys.
- PIN cookie: httpOnly, signed, SameSite=Strict, rate-limited login.
- Logs never include API key, webhook secret or full phone.

## 10. Testing

- Unit (`packages/core`): transitions — first payment confirms; duplicate is no-op; late with free slot confirms `late`; late with taken slot → `refund_due`; payment on confirmed → `refund_due`; unmatched → flag.
- Integration (`apps/server` against real Postgres): webhook valid / tampered / duplicate `webhook-id`; concurrent holds on one slot → exactly one wins; sweeper expiry and reconcile-paid path with a fake `RailAdapter`.
- Adapter mapping: fixtures captured from the first real webhook.
- Manual: real $0.01 push and QR on at least two banks; results in `docs/bank-matrix.md`.

## 11. Decided by the user

Deposit-booking product; multi-giro neutral UI; Retícula direction; mockup approved; shared payment layer with Seeb; Fastify single server on Railway; owner board on the owner's phone; es-MX only; high contrast/large type; name Pialy.

## 12. Calls made by the builder (correctable)

- Data access: **Drizzle ORM + drizzle-kit migrations** (SQL-first, light). TypeORM is the alternative the user knows.
- Web: React + Vite + TypeScript, React Router, plain CSS with tokens ported from the mockup; fonts Archivo + Doto self-hosted via Fontsource.
- Webhook verification: `standardwebhooks` npm package. Validation: Zod. Tests: Vitest.
- Seeded demo business "Estudio Demo", 45-min slots, 09:00–19:00.

- Customer form adds an optional name field ("Tu nombre", shown on the board). Payer bank shown on the board from `metadata.bankCode` mapped to a short bank list; unknown codes show nothing.
- "Darle otro horario" is out of scope: the late-payment alert offers only "Registrar devolución SPEI". The button is removed from the build.
- No "Simular pago" in the deployed app and no demo mode that can mark anything paid. Tests use a fake `RailAdapter`. Mitigation for pey/bank outages during judging: a recorded backup video of a real payment.
- Deploy to Railway first (hour one), because webhooks need a public URL and every real test costs $0.01.

## 13. Open

- Licence: FSL-1.1-MIT recommended (needs team OK before the first public push).
- Repo name and GitHub account (personal `jovandyaz` assumed).
- Which teammate is the pey "integradora" (credentials owner) and which CLABE is registered.
- Questions for pey staff: webhook retry policy; whether `api.dev.pey.mx` (listed in their llms.txt) is usable for testing.

## 14. Left to the builder

Exact component breakdown, SSE message shapes, migration ordering, retry/backoff constants, copy polish, error page designs within the mockup's language.
