# Contract suite

Black-box tests (pytest + httpx) that run against a live backend over HTTP: the TS server today
(`apps/server`), the Python backend (`apps/api`) once it exists. Nothing runs in process: the server
talks to a real Postgres and to a fake pey over HTTP, and payments arrive as real Standard Webhooks
signed by the fake. What differs between the backends lives in `targets.py`; the tests never branch
on the backend.

```
conftest.py      fixtures: target, clients, fake pey control, and the day and slot each test books
targets.py       Target protocol, TsTarget, PyTarget (routes, health and readiness, login, reset_db)
support.py       the seeded business's calendar, booking helpers, races, fake pey control, SSE reader
currency.py      the business's currency and pesos conversion, shared with the fake (stdlib only)
fake_pey/        the fake pey server (stdlib ThreadingHTTPServer) and its own tests, run in process
web_root/        the SPA build the target serves for test_static.py
run-ts.sh        one-command run against a fresh TS server
test_*.py        the cases
```

## Run against the TS server

Needs Docker, `pnpm install` done at the repo root, and uv.

```sh
tests/contract/run-ts.sh                       # extra arguments go to pytest, e.g. -k webhooks -x
RUN_DIR=out/contract tests/contract/run-ts.sh  # keeps the server and fake pey logs there (CI)
```

It starts the test Postgres (`docker-compose.test.yml`, port 54329), builds `@pialy/server`, runs its
migrations and seed, starts the fake pey and the server with throwaway secrets generated for the run
(a random PIN, cookie secret, phone salt and `whsec_` webhook secret, none written to the repo),
runs the suite and stops both processes. The logs go to `RUN_DIR`, or to a new temporary directory it
prints. The webhook secret lives in a separate private temporary directory, deleted on exit, so a log
directory uploaded from CI never holds it. Stop the database afterwards with
`docker compose -f docker-compose.test.yml down`.

The same by hand, with every value synthetic and yours to pick:

```sh
# every terminal starts at the repo root
export DATABASE_URL=postgres://postgres:postgres@localhost:54329/pialy_test
docker compose -f docker-compose.test.yml up -d --wait
pnpm --filter @pialy/server build
(cd apps/server && node dist/migrate.js && node dist/seed.js)
# mktemp -d makes a new owner-only (0700) directory with an unpredictable name: nothing can be
# planted or read there, unlike a fixed /tmp path. Export the path in the other terminals too.
export PEY_SECRET_FILE="$(mktemp -d)/pey-secret"
(umask 077 && printf '%s' "whsec_$(openssl rand -base64 32)" > "$PEY_SECRET_FILE")
echo "$PEY_SECRET_FILE"

# terminal 1: fake pey
cd tests/contract && uv run python -m fake_pey --port 4010 --secret-file "$PEY_SECRET_FILE"
# terminal 2: TS server (DATABASE_URL and PEY_SECRET_FILE as above)
cd apps/server && NODE_ENV=development PORT=3000 PEY_API_KEY=fake-pey-key \
  PEY_BASE_URL=http://127.0.0.1:4010 PEY_WEBHOOK_SECRET="$(cat "$PEY_SECRET_FILE")" BUSINESS_PIN=123456 \
  COOKIE_SECRET="$(openssl rand -hex 32)" PHONE_HASH_SALT="$(openssl rand -hex 16)" \
  WEB_ROOT="$PWD/../../tests/contract/web_root" node dist/main.js
# terminal 3: the suite
cd tests/contract && CONTRACT_TARGET=ts CONTRACT_DB_URL="$DATABASE_URL" CONTRACT_PIN=123456 uv run pytest
```

`run-ts.sh` is preferred: the TS server keeps its PIN lockout in memory, and the wrong-PIN case adds 5
failures per run toward a global cap of 20 per 10 minutes, so a server reused across more than three
runs in that window locks the owner out.

## Environment

| Variable | Target | Meaning |
|---|---|---|
| `CONTRACT_TARGET` | both | `ts` or `py` |
| `BASE_URL` | both | the backend, default `http://127.0.0.1:3000` |
| `FAKE_PEY_URL` | both | the fake pey, default `http://127.0.0.1:4010` |
| `CONTRACT_DB_URL` | both | the backend's database; booking and payment tables are truncated before each test |
| `CONTRACT_PIN` | ts | the server's `BUSINESS_PIN` |
| `CONTRACT_SLUG` | py | the seeded business, default `estudio-demo` |
| `CONTRACT_CONNECTION_ID` | py | its pey connection, for `/api/webhooks/pey/{id}` |
| `CONTRACT_OWNER_EMAIL`, `CONTRACT_OWNER_PASSWORD` | py | the seeded owner |

The backend's `PEY_BASE_URL` points at the fake pey, its webhook secret is the one in the fake's
`--secret-file`, and it serves `tests/contract/web_root` as its SPA (`WEB_ROOT` on TS).

The tests assume the seeded business: Estudio Demo, America/Mexico_City, 09:00 to 19:00, 45-minute
slots, a 1-centavo deposit. A pass checks in only on its own day, so the check-in cases book a slot
later today and are skipped from 18:40 Mexico City, when no slot is left.

## Python target

`CONTRACT_TARGET=py` with the variables above, against the app seeded by `pialy seed` (Task 18 of
`docs/superpowers/plans/2026-11-20-pialy-0-foundation.md`).
`PyTarget.reset_db` truncates the same tables as TS plus `rate_limits`; confirm that list against the
Python schema when it lands. Cases about the login itself are marked `ts_only` (PIN session) or
`py_only` (account session) and skipped on the other target.

There is no launcher for the Python app yet (Task 18 adds the run). `ENV=test` is meant for pytest
only (it generates random keys per process; newer backends refuse it outside pytest), so the suite
launches with `ENV=development` and explicit per-run keys. Generate throwaway values for each run
and export them, which keeps them out of any argv. Never write them to a file in the repo. The names
and formats come from `apps/api/src/pialy/config.py`:

```sh
# from apps/api; DATABASE_URL, the fake pey and the web root as for TS
export ENV=development PORT=3000 PEY_BASE_URL=http://127.0.0.1:4010 PUBLIC_ORIGIN=http://127.0.0.1:3000
export WEB_ROOT="$PWD/../../tests/contract/web_root"
SESSION_SECRET="$(openssl rand -hex 32)"       # at least 32 characters
AUDIT_HMAC_KEY="$(openssl rand -hex 32)"       # at least 32 characters
PHONE_HASH_SALT="$(openssl rand -hex 16)"      # at least 16 characters
CREDENTIALS_ENC_KEY="$(openssl rand -base64 32)"  # base64 of exactly 32 bytes
export SESSION_SECRET AUDIT_HMAC_KEY PHONE_HASH_SALT CREDENTIALS_ENC_KEY
uv run uvicorn pialy.main:app_factory --factory --port "$PORT"
```

### Python gaps and differences

Where TS departs from `.superpowers/industry-standards.md`, the contract keeps the standard for Python:

- **Idempotency.** Python compares the request as received. The same key with a differently formatted
  phone or extra spaces is a 409/422 problem, because Stripe treats different parameters under one key
  as an error. The TS leniency cases are `ts_only`.
- **QR attempts cap.** Python answers 409 `attempts-exhausted` (`Target.attempts_exhausted_status()`).
  A cap that never resets is not rate limiting (RFC 6585 §4), so 429 with `Retry-After` is kept for
  windowed limits only.
- **Not in TS, so no contract test yet:**
  - a `requestId` in every problem (RFC 9457; Task 2)
  - a same-Origin check on state-changing routes (OWASP CSRF cheat sheet)
  - several active webhook secrets per connection, for rotation
  - idempotency keys kept 24 h and scoped per business (Tasks 15 and 18)
  - provider retries with exponential backoff and full jitter

A pey 5xx is ambiguous: it may have charged. The rail-error cases assert only that the hold or attempt
ends; reconciliation settles the outcome later, and money that still arrives is a late payment.

The seeded connection's webhook secret must be the fake's `--secret-file` secret. `CREDENTIALS_ENC_KEY`
encrypts it at rest, so a key generated per run goes with a database seeded in the same run.

## Fake pey

```sh
uv run python -m fake_pey --port 4010 --secret-file FILE [--host 127.0.0.1] [--webhook-url URL]
```

`--secret-file` holds the `whsec_…` secret it signs webhooks with (read on every delivery);
`--webhook-url` is a default target that control bodies may override. The suite always sends
`webhook_url`, built from `BASE_URL` and the target's webhook path.

pey API, as `packages/connector-pey` calls it (Bearer key required, any value):

| Call | Answer |
|---|---|
| `POST /codi/pn` | 201 `{transactionId, codiId}` |
| `POST /codi/qr` | 201 `{id, qrString, qrImage}` |
| `GET /transaction/{id}` | the push transaction: `PENDING`, or `PAID` with `amount`, `amountBreakdown.base` and `datePaid` |
| `GET /transaction/codi/qr/{qrId}` | `{items: [paid transactions], nextToken: null}` |

Control endpoints (amounts in integer centavos):

| Call | Body | Effect |
|---|---|---|
| `POST /_control/pay` | `provider_ref` (push `transactionId` or QR id), `amount`, optional `fee`, `late`, `bank_code` (`null` omits it), `external_metadata`, `webhook_url`, `send` | records the payment (pey then reports it `PAID`) and delivers its signed `codi.pn`/`codi.qr.payment_received` webhook; the webhook amount is `amount + fee`, the rail's base is `amount`; `amount`, `fee` and `bank_code` must be JSON integers; `late` dates it one second after the charge expires (see below) |
| `POST /_control/deliver` | `body` (JSON or a raw string), optional `webhook_id` (non-empty string), `timestamp` (epoch seconds, default now), `webhook_url` (http or https), `send` (boolean) | signs and delivers any body; `timestamp` probes the target's 5-minute tolerance |
| `POST /_control/fail-next` | `status` (400–599), optional `times` | the next API calls answer that status with a pey error body |
| `POST /_control/clear-failures` | | drops the failures still queued by `fail-next` |
| `POST /_control/stall-next` | | the next API call waits (up to 30 s) until `/_control/release` |
| `POST /_control/release` | | lets stalled calls answer |
| `POST /_control/reset` | | forgets charges, payments, recorded calls, failures and stalls |
| `GET /_control/requests` | | every API call with its body and answer |

`pay` and `deliver` answer `{delivery: {url, headers, body}, response: {status, content_type, body}}`
(`pay` adds `transaction_id`, `tracking_key`, `date_paid`); with `"send": false` the signed delivery
is returned without posting it, for a test to tamper with or post itself. A delivery that fails in
transport (connection refused or reset, a response cut short, no answer within 10 s) makes the
control call answer 502. For `pay` the payment stays recorded: pey reports it `PAID`, paying the same
push again is a 409, and `/_control/deliver` can resend its webhook.

Malformed control or pey bodies get a 4xx answer (400 for a bad `content-length`, `webhook_url`,
`webhook_id`, `timestamp`, `send`, charge `expiration` or `metadata`), never a dropped connection;
`fake_pey/test_server.py` pins that, starting the fake in process with no target needed.

`late` only moves the payment's `datePaid` to one second after the charge's expiry. While the hold
lasts that instant is still in the future on the real clock, so `late` is meaningful only against a
target whose clock was moved past the expiry; no test here uses it.

## Not covered here

Cases of `apps/server/test` that need control of the clock are ported in process with an injected
clock (Task 15 of `docs/superpowers/plans/2026-11-20-pialy-0-foundation.md`). One case is left out
by name: `board.test.ts:115`, the cap of 20 wrong PINs across all IPs. Tripping it locks the owner
out of the shared server for the rest of the 10-minute window (every later login case would fail),
and its second half, the lockout lifting when the window passes, needs the clock.

Also left out: unit tests of internals (the SSE hub, the outbox relay, the unit of work), assertions
on server logs or on stored rows that no route exposes, states no route can reach (`expired` with a
token, `canceled`), and cases that need another server configuration (production cookies, no web
root, a 500-listener hub, shutdown). A few TS tests mix both halves; their contract test keeps the
half that needs no clock and says so in its docstring. Races release their requests together through
a barrier, which makes them overlap more often but cannot guarantee the server sees them at once.

## Contract tests with no same-named TS test

Most contract tests carry the name of the TS test they port; parametrized TS tests (`it.each` with
`%s`) map to one parametrized contract test. These have no same-named TS test:

| Contract test | Source |
|---|---|
| `test_holds.py::test_two_concurrent_holds_of_one_slot_with_different_keys_one_is_held_the_other_gets_slot_taken` | `hold-slot.test.ts:270` (RF2, an in-process use case test) run through HTTP |
| `test_webhooks.py::test_applies_one_of_two_concurrent_deliveries_of_the_same_webhook_id_and_answers_the_other_as_duplicate` | `apps/server/src/infrastructure/webhook-inbox.ts:12` (`onConflictDoNothing` on the webhook id), reached from `packages/payments/src/application/apply-provider-payment.ts:118-120` |
| `test_webhooks.py::test_answers_a_redelivery_of_a_no_payment_event_with_the_same_webhook_id_as_duplicate` | `packages/payments/src/application/apply-provider-payment.ts:84-92` (no-payment events dedupe on the inbox alone) |
| `test_webhooks.py::test_rejects_a_delivery_signed_more_than_5_minutes_from_now_with_401_and_records_nothing`, `test_accepts_a_delivery_signed_within_5_minutes_of_now` | Standard Webhooks timestamp tolerance; `packages/connector-pey/src/connector.ts:191-210` (`standardwebhooks` `verify`, 5 minutes) |
| `test_webhooks.py::test_accepts_a_signature_header_that_also_lists_a_signature_by_another_secret` | Standard Webhooks signature list for secret rotation; the same `verify` |
| `test_idempotency.py::test_replays_the_same_response_for_the_same_key_and_the_same_body` | `bookings-routes.test.ts:105` without the trimmed name, which is `ts_only` |
| `test_idempotency.py::test_keeps_no_result_for_a_request_that_failed_validation_so_the_key_can_be_retried` | Stripe idempotent requests; `apps/server/src/http/routes/bookings.ts:158-161` validates before the key is claimed |
| `fake_pey/test_server.py::*` | the fake's own input handling |
