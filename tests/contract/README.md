# Contract suite

Black-box tests (pytest + httpx) that run against a live backend over HTTP: the TS server today
(`apps/server`), the Python backend (`apps/api`) once it exists. Nothing runs in process: the server
talks to a real Postgres and to a fake pey over HTTP, and payments arrive as real Standard Webhooks
signed by the fake. What differs between the backends lives in `targets.py`; the tests never branch
on the backend.

```
conftest.py      fixtures: target, anonymous client, signed-in owner client, fake pey control
targets.py       Target protocol, TsTarget, PyTarget (prefix, webhook path, login, reset_db)
support.py       the seeded business's calendar, booking helpers, fake pey control, SSE reader
fake_pey/        the fake pey server (stdlib ThreadingHTTPServer)
web_root/        the SPA build the target serves for test_static.py
run-ts.sh        one-command run against a fresh TS server
test_*.py        the cases
```

## Run against the TS server

Needs Docker, `pnpm install` done at the repo root, and uv.

```sh
tests/contract/run-ts.sh            # extra arguments go to pytest, e.g. -k webhooks -x
```

It starts the test Postgres (`docker-compose.test.yml`, port 54329), builds `@pialy/server`, runs its
migrations and seed, starts the fake pey and the server with throwaway secrets generated for the run
(a random PIN, cookie secret, phone salt and `whsec_` webhook secret, none written to the repo),
runs the suite and stops both processes. Logs stay in the temporary directory it prints. Stop the
database afterwards with `docker compose -f docker-compose.test.yml down`.

The same by hand, with every value synthetic and yours to pick:

```sh
# every terminal starts at the repo root
export DATABASE_URL=postgres://postgres:postgres@localhost:54329/pialy_test
docker compose -f docker-compose.test.yml up -d --wait
pnpm --filter @pialy/server build
(cd apps/server && node dist/migrate.js && node dist/seed.js)
(umask 077 && printf '%s' "whsec_$(openssl rand -base64 32)" > /tmp/pey-secret)   # owner-only, outside the repo

# terminal 1: fake pey
cd tests/contract && uv run python -m fake_pey --port 4010 --secret-file /tmp/pey-secret
# terminal 2: TS server (DATABASE_URL as above)
cd apps/server && NODE_ENV=development PORT=3000 PEY_API_KEY=fake-pey-key \
  PEY_BASE_URL=http://127.0.0.1:4010 PEY_WEBHOOK_SECRET="$(cat /tmp/pey-secret)" BUSINESS_PIN=123456 \
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

`CONTRACT_TARGET=py` with the variables above, against the app seeded by `pialy seed` (Task 18).
`PyTarget.reset_db` truncates the same tables as TS plus `rate_limits`; confirm that list against the
Python schema when it lands. Cases about the login itself are marked `ts_only` (PIN session) or
`py_only` (account session) and skipped on the other target.

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
| `POST /_control/pay` | `provider_ref` (push `transactionId` or QR id), `amount`, optional `fee`, `late`, `bank_code` (`null` omits it), `external_metadata`, `webhook_url`, `send` | records the payment (pey then reports it `PAID`) and delivers its signed `codi.pn`/`codi.qr.payment_received` webhook; the webhook amount is `amount + fee`, the rail's base is `amount`; `late` dates it one second after the charge expired |
| `POST /_control/deliver` | `body` (JSON or a raw string), optional `webhook_id`, `webhook_url`, `send` | signs and delivers any body |
| `POST /_control/fail-next` | `status` (400–599), optional `times` | the next API calls answer that status with a pey error body |
| `POST /_control/stall-next` | | the next API call waits (up to 30 s) until `/_control/release` |
| `POST /_control/release` | | lets stalled calls answer |
| `POST /_control/reset` | | forgets charges, payments, recorded calls, failures and stalls |
| `GET /_control/requests` | | every API call with its body and answer |

`pay` and `deliver` answer `{delivery: {url, headers, body}, response: {status, content_type, body}}`
(`pay` adds `transaction_id`, `tracking_key`, `date_paid`); with `"send": false` the signed delivery
is returned without posting it, for a test to tamper with or post itself.

## Not covered here

Cases of `apps/server/test` that need control of the clock are ported in process with an injected
clock (Task 15, `docs/superpowers/plans/ts-to-py-time-tests.md`). Also left out: unit tests of
internals (the SSE hub, the outbox relay, the unit of work), assertions on server logs or on stored
rows that no route exposes, states no route can reach (`expired` with a token, `canceled`), and
cases that need another server configuration (production cookies, no web root, a 500-listener hub,
shutdown). A few TS tests mix both halves; their contract test keeps the half that needs no clock
and says so in its docstring.
