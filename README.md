# Pialy

Appointments with an advance deposit, so no-shows stop costing the business.

## What it is

An online agenda for businesses that work by appointment (barbershops, salons, clinics, workshops). The customer books a slot and pays a deposit from their own bank app with CoDi: no card, no account. The slot is held only while the bank request is alive and is confirmed only when the bank confirms the payment. The customer gets a pass; the business sees paid bookings arrive on its agenda in real time and checks the customer in by scanning the pass.

## Try it in 2 minutes

Live: https://pialy-production.up.railway.app

1. Open `/estudio-demo`, pick a slot and type your phone number. **Your phone must be registered in CoDi in your bank app.** The demo charges a real, non-refundable **$0.01 MXN**.
2. Approve the CoDi request that arrives in your bank app. If it doesn't arrive within 40 seconds, the page shows a CoDi QR you can scan from your bank app (on desktop the QR is shown from the start).
3. As soon as the bank confirms, the page turns into a pass with a QR, the bank and the tracking key.
4. The business side lives at `/negocio` (PIN shared privately): the booking turns green, a toast appears and the agenda says "Anticipo recibido" out loud. "Escanear pase" opens the camera inside the agenda to verify the pass and mark the arrival; a pass can only be used once.

## How it uses CoDi (via pey)

Only the server talks to pey (`packages/connector-pey`):

- `POST /codi/pn`: CoDi request pushed to the phone the customer typed (expires in 360 s).
- `POST /codi/qr`: CoDi QR fallback for the same booking (up to 3 charge attempts per booking, including the push).
- `GET /transaction/{id}` and `GET /transaction/codi/qr/{idc}`: status lookup for a push or QR charge.
- GETs are retried on network errors or 5xx; a POST is retried only when the response proves pey did not process it.

Payment confirmation:

- **Signed webhook** at `POST /api/webhooks/pey`: the Standard Webhooks signature is verified over the raw body (401 if invalid). Each `webhook-id` is recorded in an inbox in the same transaction as its effect, so a repeated webhook does nothing. The same payment is never applied twice, even if it arrives by both webhook and status lookup.
- **Sweeper every 15 s** (Postgres advisory lock, single active instance): before releasing an expired hold it asks pey for the status; if paid it applies the payment, otherwise it expires the hold and frees the slot. Every fourth run it also rechecks attempts that expired in the last 40 min, in case the payment arrived late.

Payment policy:

- Paid while the slot is still held: confirmed.
- Late payment: confirmed and marked late if the slot is still free; if someone else took it, a refund is flagged.
- Duplicate payment, payment on an already paid or canceled booking, or a payment with no booking: refund flagged on the business agenda.
- Refunds are sent manually by SPEI and recorded with a note on the agenda.

## Architecture

```
Customer phone ─┐                         ┌─ pey API (CoDi push, QR, status)
Business phone ─┤ HTTP + SSE              │
                ▼                         │
       Fastify (API /api/*, SSE, SPA) ────┤
         ├─ sweeper every 15 s            │
         └─ outbox → SSE                  │
                │                         │
                ▼                         │
            Postgres          pey ── signed webhook ──▶ Fastify
```

- `packages/payments`: payment domain with no I/O (payment intent, attempts, money, state machine, ports).
- `packages/connector-pey`: pey connector (HTTP client, Zod validation, webhook signatures).
- `apps/server`: Fastify; bookings, business session, agenda, webhook, sweeper, outbox and SSE; Drizzle on Postgres. Serves the built SPA.
- `apps/web`: React + Vite SPA (landing, booking, payment wait, pass, agenda, pass scanner and verification).

## Running locally

Requirements: Node 24 (`.nvmrc`), pnpm and Docker (local Postgres).

```sh
pnpm install
cp .env.example .env   # fill in the secrets
docker compose -f docker-compose.test.yml up -d
pnpm -r build
node --env-file=.env apps/server/dist/migrate.js && node --env-file=.env apps/server/dist/seed.js && node --env-file=.env apps/server/dist/main.js
```

The `DATABASE_URL` in `.env.example` points to the Docker test database; `pnpm test` empties it.

Environment variables (`.env.example`). The server does not start without `DATABASE_URL`, `PEY_API_KEY`, `PEY_BASE_URL`, `PEY_WEBHOOK_SECRET`, `PHONE_HASH_SALT`, `BUSINESS_PIN` and `COOKIE_SECRET`, in any environment.

| Variable | Purpose |
|---|---|
| `NODE_ENV` | `development`, `test` or `production`. |
| `PORT` | HTTP port (default 3000). |
| `DATABASE_URL` | Postgres connection string. |
| `PEY_API_KEY` | pey API key. |
| `PEY_BASE_URL` | pey API base URL (`https://api.pey.mx`). |
| `PEY_WEBHOOK_SECRET` | Secret used to verify pey webhook signatures. |
| `BUSINESS_PIN` | Business agenda PIN (6 digits or more). |
| `COOKIE_SECRET` | Signs the business session cookie (32 characters or more). |
| `PHONE_HASH_SALT` | Salt for the phone hash (per-number limits). |
| `DEMO_DEPOSIT_CENTS` | Deposit amount in cents; only `1` is accepted. |
| `WEB_ROOT` | Built SPA folder (default `apps/web/dist`). |

Tests (Postgres on port 54329; use another database with `TEST_DATABASE_URL`):

```sh
docker compose -f docker-compose.test.yml up -d
pnpm test
pnpm -r typecheck
pnpm lint
```

## Privacy

- Only the last 4 digits of the phone and a salted hash are stored; the full number is never stored or logged.
- Only the last 4 digits of the payer's account (CLABE) are stored, and logs show truncated booking tokens.
- The server sets the amount; no client request carries an amount.
- The client never confirms a payment: only the verified webhook or the pey status lookup does.

## Known limitations

- Single business.
- Refunds are manual (SPEI).
- Logging out only clears the business cookie; the session lasts 12 h.
- After 20 wrong PINs in 10 min (from any source), nobody can log in to the agenda for that window.
- Someone who types another person's phone number can keep them from holding a slot with that number for up to 10 min.

## Pre-existing components

None.

## License

Functional Source License 1.1 with MIT future license (FSL-1.1-MIT). See `LICENSE.md`.

---

Built during Hackatón México 2026 (CoDi + pey API). Not affiliated with or endorsed by pey or Banco de México.
