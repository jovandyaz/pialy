# Pialy layer 0: Python foundation — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Python backend in `apps/api` that does everything the TS server does today (booking, CoDi push and QR, webhooks, sweeper, agenda, SSE, static SPA) for businesses isolated by `business_id` and row-level security, with one seeded business and owner account, and the production requirements of spec §12b.

**Architecture:** FastAPI on uvicorn; sync domain and repositories on psycopg 3 run in the threadpool; async only for SSE. Pure booking domain; payment rules from `agent_toolkit.payments_core`; webhook verification and inbox from `agent_toolkit.webhooks`. Every tenant query runs inside `Database.tenant(ctx)`, which sets `app.business_id` for the transaction; Postgres policies enforce it a second time.

**Tech Stack:** Python 3.13, uv, FastAPI, uvicorn, psycopg 3 + psycopg_pool, Alembic (raw SQL revisions), pydantic v2 + pydantic-settings, httpx, argon2-cffi, cryptography, agent-toolkit `v0.1.0rc1` (git tag), pytest, ruff, mypy, import-linter. Postgres 16.

**Spec:** `docs/superpowers/specs/2026-11-20-pialy-python-backend-agent-design.md` (sections 3, 5, 5b, 6, 7, 10, 11, 12b, 13 layer 0). Behavior source of truth for every ported flow: the TS server in `apps/server/src` and its tests in `apps/server/test`. Where a task says "port", the Python behavior and its test assertions are those of the named TS file and test, with the changes listed in the task.

## Global Constraints

- Python ≥ 3.13; `mypy --strict`; ruff; no `Any` in module interfaces; pydantic models frozen + strict at boundaries.
- Money is `int` minor units plus ISO 4217 currency; never `float`.
- Domain modules (`pialy.booking.domain`) import no FastAPI, psycopg, httpx and never read the clock; time comes in as an argument. Enforced by `import-linter`.
- No query reads tenant data outside `Database.tenant(ctx)`; the service role (`pialy_app`) has no `BYPASSRLS` and does not own tables; migrations run as `pialy_owner`.
- Full phone numbers exist only in memory inside the request that triggers the pey call. Stored: `phone_hash` (HMAC-SHA256 with `PHONE_HASH_SALT`) and `phone_last4`. Payer CLABE stored masked to its last 4 digits.
- Logs: JSON lines through `pialy.observability.logging`; never a phone, email, token, key or raw webhook body. Booking tokens truncated to 4 characters.
- pey: `expiration` ≥ 360 seconds; a QR can be paid more than once; no expired or refund event; webhook retries undocumented, so the sweeper is a primary confirmation path.
- Deposit bounded by `DEPOSIT_MAX_MINOR` (1 during the hackathon).
- The repository is public: no secrets, no real CLABEs, names or pey operational details in code, fixtures or docs.
- agent-toolkit dependencies, one per package: `agent-toolkit-<name> @ git+https://github.com/jovandyaz/agent-toolkit@v0.1.0rc1#subdirectory=packages/<name>`.
- Tooling: pnpm workspaces for the JS side, uv for `apps/api` (its own `pyproject.toml` and `uv.lock`, no `package.json`, so pnpm ignores it). No Nx or Turborepo. Root `package.json` scripts are the single entry point for both.
- Conventional Commits, one line, English, no trailers. One branch per task group, PRs to `main`; never push to `main`.
- Money-path tasks (marked **[money]**): TDD, one fresh reviewer per task, never weaken a test.

## Review Focus

1. A request whose slug names business X carrying a booking token, flag id or connection id of business Y → 404, never Y's data (Task 18).
2. A pey webhook for connection X signed with connection Y's secret → 401 and nothing written (Task 11).
3. pey answers slowly or not at all during a push → the request ends within the pey timeout (10 s total) with the 502 problem, the hold ends, and no transaction stayed open meanwhile (Task 12).
4. The process receives SIGTERM with SSE clients connected → streams end with a retry hint and the process exits within 10 s (Task 14).
5. A log call receives a 10-digit phone, an email, a session token or a CLABE inside an exception message → none appears in the output (Task 2).

## Roles and order

| Role | Tasks |
|---|---|
| A (money path) | 9, 10, 11, 12, 15 |
| B (platform) | 1, 2, 3, 4, 5, 6, 8, 13, 14, 16, 17, 18 |
| B or a second person (contract suite, Nov 21–22) | 7 |
| D (web, CI) | 19, 20 |

Role C works on the agent plan from day one against in-memory ports. Order: 1 → 2 → 3+4 (one PR) → 5 → 6. Task 7 runs in parallel from day one. 8 needs 1; 9 and 10 need 4; 11 needs 6, 9, 10; 12 needs 11; 13 and 14 need 11; 15 needs 12; 16 needs 5; 17 needs 12, 13, 14, 16; 18 needs 17; 19 needs 16 and 17; 20 can start after 1.

## File map

```
apps/api/
  pyproject.toml  uv.lock  .python-version  alembic.ini  .importlinter
  migrations/versions/0001_tables.py  0002_rls.py
  src/pialy/
    config.py                  Settings
    main.py                    create_app(settings, clock) -> FastAPI; uvicorn entry
    clock.py                   Clock = Callable[[], datetime]; system_clock
    observability/logging.py   JSON formatter, redaction filter, request id contextvar
    observability/errors.py    optional Sentry init
    db/database.py             Database (pools, tenant/system transactions, advisory locks)
    db/locks.py                advisory lock keys
    tenancy/context.py         TenantContext, Actor
    tenancy/crypto.py          CredentialCipher
    tenancy/businesses.py      Business read model, slug lookup
    tenancy/pey_connections.py PeyConnection repository
    booking/domain/{slots,booking,phone,banks}.py
    booking/application/{hold_slot,start_qr_attempt,check_in,resolve_flag,on_payment,get_slots,board}.py
    booking/repository.py      bookings, flags, board queries
    payments/pey.py            PeyConnector(RailConnector)
    payments/repository.py     PostgresIntentRepository, PostgresUnitOfWork
    payments/apply.py          apply_payment
    payments/read_model.py     API attempt fields over payments-core statuses
    webhooks/inbox.py          PostgresInbox
    webhooks/route.py
    realtime/{outbox,relay,hub}.py
    jobs/{sweeper,retention,runner}.py
    identity/{passwords,sessions,users,rate_limits}.py
    audit/platform.py          append_platform_event
    http/{app,deps,problems,security_headers,idempotency,client_ip,static}.py
    http/routes/{health,auth,slots,bookings,board,webhooks,events}.py
    cli.py                     seed, reset-password
  tests/{unit,db,http,jobs}/   conftest.py
tests/contract/                own uv project; fake_pey/; targets.py; test_*.py
docker-compose.yml             postgres:16 + fake pey for local
.github/workflows/ci.yml
```

---

### Task 1: Scaffold `apps/api`, settings and app factory (B)

**Files:**
- Create: `apps/api/pyproject.toml`, `apps/api/.python-version` (`3.13`), `apps/api/.importlinter`, `apps/api/src/pialy/{__init__,config,clock,main}.py`, `apps/api/tests/conftest.py`, `apps/api/tests/unit/test_config.py`, `docker-compose.yml`, `apps/api/AGENTS.md`, `apps/api/CLAUDE.md` (`@AGENTS.md`)
- Modify: root `package.json` scripts, root `AGENTS.md` (mark the `api:*` commands as available)

**Interfaces:**
- Produces: `Settings` (pydantic-settings, frozen) with `env: Literal["development","test","production"]` (required, no default), `port: int = 3000`, `database_url: SecretStr`, `migration_database_url: SecretStr | None`, `pey_base_url: AnyHttpUrl`, `phone_hash_salt: SecretStr`, `session_secret: SecretStr` (≥ 32 chars), `credentials_enc_key: SecretStr` (base64 of 32 bytes, optionally `v<N>:` prefixed list for rotation), `deposit_max_minor: int` (default 1), `web_root: Path | None`, `public_origin: AnyHttpUrl`, `audit_hmac_key: SecretStr` (≥ 32 bytes, for `audit_log.hash_payload`), `sentry_dsn: SecretStr | None`, `log_level: Literal["DEBUG","INFO","WARNING","ERROR","CRITICAL"] = "INFO"` (any case, stored in capitals); `load_settings() -> Settings` exits the process with only the variable names on error. `Clock = Callable[[], datetime]` (aware UTC). `create_app(settings: Settings, clock: Clock) -> FastAPI`.
- Produces (root scripts, used by CI and by every later task): `api:sync` = `uv sync --locked --directory apps/api`; `api:lint` = `uv run --directory apps/api ruff check . && uv run --directory apps/api ruff format --check . && uv run --directory apps/api mypy --strict src tests && uv run --directory apps/api lint-imports`; `api:test` = `uv run --directory apps/api pytest`; `api:dev` = `uv run --directory apps/api uvicorn pialy.main:app_factory --factory --reload --port 3000`; `check` = `pnpm lint && pnpm typecheck && pnpm test && pnpm api:lint && pnpm api:test`. Existing `typecheck`/`test`/`lint` stay JS-only.

- [x] **Step 1: Write failing tests** in `tests/unit/test_config.py`, porting `apps/server/test/env.test.ts`: `test_accepts_minimal_development_env_with_defaults`, `test_requires_database_url`, `test_rejects_deposit_max_above_1_while_hackathon` (`DEPOSIT_MAX_MINOR=2` fails), `test_requires_every_secret_in_production` (missing `session_secret`, `credentials_enc_key`, `phone_hash_salt` each fail), `test_never_echoes_values_in_errors` (error text contains `SESSION_SECRET` but not the value), `test_rejects_session_secret_shorter_than_32`, `test_rejects_credentials_key_not_32_bytes`.
- [x] **Step 2:** `cd apps/api && uv run pytest tests/unit/test_config.py -v` → FAIL (module missing).
- [x] **Step 3:** Create the uv project (`requires-python = ">=3.13"`; deps above; dev deps pytest, ruff, mypy, import-linter, pip-audit). Implement `Settings`, `load_settings`, `system_clock`, `create_app` returning an app with no routes yet. `.importlinter` contracts: `pialy.booking.domain` forbidden from `fastapi`, `psycopg`, `httpx`, `pialy.db`, `pialy.http`; `pialy.http` is the only importer of `fastapi` outside `main`. `docker-compose.yml`: `postgres:16` on 5432 with an init script creating roles `pialy_owner` and `pialy_app` (password from env, `pialy_app` `NOSUPERUSER NOBYPASSRLS`), plus the fake pey from Task 7.
- [x] **Step 4:** tests pass; from the repo root `pnpm api:lint && pnpm api:test` clean and `pnpm -r typecheck` still lists only JS packages (pnpm ignores `apps/api`).
- [x] **Step 5:** Commit `feat(api): scaffold python backend with settings and app factory`.

### Task 2: Logging with redaction, request ids, problems, security headers, health (B)

**Files:**
- Create: `src/pialy/observability/{logging,errors}.py`, `src/pialy/http/{problems,security_headers}.py`, `src/pialy/http/routes/health.py`, `tests/unit/test_logging.py`, `tests/http/test_health.py`

**Interfaces:**
- Produces: `configure_logging(level: str) -> None`; `request_id: ContextVar[str]`; `bind(**fields: str) -> None` (business id, route) into a contextvar merged into every line; `log_event(name: str, **fields: str | int) -> None` for the named events of spec §12b; `ProblemError(status: int, type_urn: str, title: str, detail: str | None)` raised anywhere and rendered as RFC 9457 `application/problem+json` with `requestId`; `GET /healthz` → `{"status":"ok"}`; `GET /readyz` → 200 when `SELECT 1` succeeds and Alembic's current revision equals head, else 503 problem.

- [x] **Step 1: Write failing tests.** `test_logging.py`: `test_redacts_phone_email_token_key_and_clabe` feeds `"tel 5512345678 mail a@b.mx tok 3f9a…(32 hex) clabe 123456789012345678"` (synthetic) through `logging.getLogger("x").error(..., exc_info=…)` and asserts none of the four values nor 18-digit runs appear in captured output, while `"tel"` does; `test_truncates_booking_token_in_url_to_4_chars`; `test_every_line_carries_request_id_and_business_id`. `test_health.py`, porting `health.test.ts`: healthz ok, readyz 503 when database unreachable, `test_sets_security_headers` (CSP `default-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Strict-Transport-Security: max-age=31536000` in production only), `test_rfc9457_for_unknown_route`, `test_hides_details_of_unexpected_errors`, `test_request_id_header_and_problem_field_match`.
- [x] **Step 2:** run → FAIL.
- [x] **Step 3:** Implement with stdlib `logging` and a JSON formatter (no new dependency). Redaction is a `logging.Filter` applied to the formatted message and exception text: digit runs of 10+ → `[digits]`, emails → `[email]`, 32+ char hex/base64url tokens → `[token]`. Request id: incoming `X-Request-Id` if it matches `^[A-Za-z0-9-]{8,64}$`, else a new uuid4; returned in `X-Request-Id`. `observability/errors.py`: init `sentry_sdk` only if `sentry_dsn` is set, `send_default_pii=False`, `before_send` runs the same redaction (sentry-sdk as an optional extra `sentry`).
- [x] **Step 4:** pass. **Step 5:** Commit `feat(api): add redacting json logs, problems, headers and health checks`.

### Task 3: Database access and the two-role model (B)

**Files:**
- Create: `src/pialy/db/{database,locks}.py`, `src/pialy/tenancy/context.py`, `apps/api/alembic.ini`, `migrations/{env.py,script.py.mako}`, `tests/db/conftest.py`, `tests/db/test_database.py`, `tests/db/test_cluster_guard.py`, `tests/unit/test_locks.py`
- Modify: `src/pialy/config.py` (`migrations_dir`), `src/pialy/main.py` (lifespan), `src/pialy/observability/readiness.py`, `pyproject.toml` (mypy), root `package.json` (`api:test`)

**Interfaces:**
- Produces:
  - `TenantContext(business_id: UUID, actor: Actor)` frozen dataclass; `Actor = OwnerActor(user_id: UUID) | StaffActor(user_id: UUID) | PublicActor() | SystemActor(job: str)` (frozen dataclasses; `StaffActor` unused until layer 3).
  - `Database(settings)` with `tenant(ctx: TenantContext) -> ContextManager[psycopg.Connection]` (one transaction; first statement `SELECT set_config('app.business_id', %s, true)`), `system(timeout: float | None = None) -> ContextManager[psycopg.Connection]` (one transaction, no business: only the `SECURITY DEFINER` functions of Task 5 and the non-tenant tables are reachable; `timeout` bounds the wait for a pooled connection), `user(user_id: UUID) -> ContextManager[psycopg.Connection]` (sets `app.user_id`, for memberships), `lock_connection() -> ContextManager[psycopg.Connection]` (a connection from a separate pool of 4, autocommit, for session-level advisory locks), `open(wait: bool = False) -> None`, `close() -> None`, `max_size: int`, `vet_connection() -> None` (the startup check below).
  - Pools: `psycopg_pool.ConnectionPool` `pialy`, `min_size=2`, `max_size=10`, `timeout=3.0` seconds of wait for a connection (psycopg's default is 30), `connect_timeout=5`; lock pool `pialy-locks`, `min_size=1`, `max_size=4`, autocommit, `timeout=2.0`. The session limits, `statement_timeout` 5 s, `lock_timeout` 2 s and `idle_in_transaction_session_timeout` 15 s, are startup options (libpq `options`, after any the URL carries, so they prevail; `PGOPTIONS` is not read): each session's defaults, what `RESET ALL` returns to. On both pools: `check=ConnectionPool.check_connection` before serving a connection; `reset` runs `SET SESSION AUTHORIZATION DEFAULT`, `RESET ALL` and `pg_advisory_unlock_all()`, so a connection returns with its login role, its session defaults and no session lock (`RESET ALL` alone keeps a `SET ROLE`); `configure` vets each new connection in one query, closing it on any failure: its role is no superuser and has no `BYPASSRLS` (else `PrivilegedRoleError`), and its session carries the three limits (else `SessionLimitsError`, as when a pooler drops the startup options). The lifespan runs the same check at startup, before the pools open, on a connection of its own (`vet_connection()`); a database it cannot reach is logged by error type and left to readiness. `create_app` builds the `Database` (`app.state.database`); its lifespan opens both pools without waiting, sets AnyIO's threadpool limit to the pool's `max_size`, and closes them on shutdown.
  - Setting `migrations_dir: Path = Path("migrations")` (`MIGRATIONS_DIR`), relative to the working directory, `apps/api`, where `alembic.ini`'s `script_location` points too. `/readyz` runs through the app's pool, `database_readiness(database, migrations_dir)`, waiting at most 2 s for a connection, and reads `alembic_version` as `pialy_app`, which needs `SELECT` on it.
  - `locks.py`: `advisory_key(namespace: str, ident: str) -> int` (stable signed 64-bit from SHA-256); namespaces `"sweeper"`, `"relay"`, `"mandate"`, `"retention"`.
- Test fixtures: `TEST_DATABASE_URL` is an admin (superuser) URL; root `api:test` defaults it to the docker-compose.test.yml cluster (`postgresql://postgres:postgres@localhost:54329/pialy_test`), and unset the db tests are skipped. The session (re)creates the cluster-wide roles `pialy_owner` and `pialy_app` with synthetic passwords, creates a throwaway database owned by `pialy_owner`, runs `alembic upgrade head` as owner through `migrations/env.py`, and serves `db`, a `Database` connected as `pialy_app`; every table but `alembic_version` is truncated before each test, and the database is dropped at the end. Because they reset the role passwords, the fixtures fail on a cluster off this machine (a non-loopback host in the URL, `PGHOST` or `PGHOSTADDR`, or a libpq service: `service=`, `PGSERVICE` or `PGSERVICEFILE`) unless `PIALY_TEST_DB_DISPOSABLE=1`. Stand-ins until Task 5's grants: `owner_db` (the same as `pialy_owner`) for the schema tests, and `GRANT SELECT ON alembic_version TO pialy_app` for `/readyz`.
- mypy: `explicit_package_bases = true`, so `tests/conftest.py` and `tests/db/conftest.py` do not clash.
- Merge: this branch (`feat/api-database`) merges together with `feat/api-rls` (Task 5, 0002). Until then `/readyz` answers 503 in a real deploy, because only 0002 grants `pialy_app` (the tests stand in with `GRANT SELECT ON alembic_version`).

- [x] **Step 1: Failing tests:** `test_tenant_transaction_sets_business_setting_locally` (inside → setting equals id; a following `system()` sees it unset); `test_statement_timeout_applies` (`SELECT pg_sleep(6)` raises `QueryCanceled`); `test_app_role_cannot_bypass_rls` (`SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user` → both false); `test_advisory_key_is_stable`.
- [x] **Step 2–4:** fail, implement, pass (needs Task 4's migrations; land 3 and 4 in one PR).
- [x] **Step 5:** Commit `feat(api): add tenant-scoped database access`.

### Task 4: Schema migration 0001 — tables and invariants (B) **[money]**

**Files:**
- Create: `migrations/versions/0001_tables.py`, `tests/db/test_schema.py` (`alembic.ini` and `migrations/env.py` came with Task 3)
- Modify: `pyproject.toml`, `uv.lock` (the toolkit's audit log)

**Interfaces:**
- Produces the tables of spec §6, each tenant table with `business_id uuid NOT NULL REFERENCES business(id)` leading its indexes:
  - `business` (+ `slug text UNIQUE NOT NULL CHECK (slug ~ '^[a-z0-9](-?[a-z0-9])*$' AND length(slug) BETWEEN 3 AND 40)`, `accepting_bookings boolean NOT NULL DEFAULT false`), `resources`, `bookings` (number per business: `UNIQUE (business_id, number)`, `number` assigned from `business.next_booking_number` row-locked, `CHECK (number BETWEEN 1 AND 9999999)`), `payment_intents` (`principal_id`, `reference`, `UNIQUE (business_id, idempotency_key)`, `amount_minor`, `currency` (`IN ('MXN')`, as on `business` and `payment_events`: CoDi and SPEI settle in pesos, another currency takes a new revision), `status IN ('pending','partially_paid','paid','expired')`, `paid_total_minor`, `late`), `payment_attempts` (`rail IN ('codi_push','codi_qr')`, `provider_ref`, `codi_id`, `amount_minor NULL`, `status` = payments-core `AttemptStatus` values, `failed_at timestamptz NULL` for the read-model `failed`, `expires_at`), `payment_events` (`UNIQUE (business_id, provider_event_id)`, `provider_ref`, `paid_at timestamptz NULL`: pey's `datePaid`, from 2020-01-01 up to 2100-01-01, `raw` jsonb: an allowlisted projection of pey's payload without `datePaid`, each field of its documented type, the CLABE masked to its last 4), `webhook_inbox` (`PRIMARY KEY (connection_id, webhook_id)`), `idempotency_keys` (`PRIMARY KEY (business_id, scope, key)`), `outbox`, `flags` (`kind IN ('unmatched_payment','refund_due','amount_mismatch')`, `provider_event_id NULL`, unique per business among `unmatched_payment` flags for orphan dedupe, `flags_unmatched_event_check`: an `unmatched_payment` flag has a `provider_event_id`), `users`, `memberships`, `sessions`, `invitations`, `pey_connections`, `rate_limits (key text, window_start timestamptz, count int, PRIMARY KEY (key, window_start))`.
  - Kept invariants: `btree_gist` exclusion on `(resource_id, during)` for active statuses; one `holding` booking per `(business_id, phone_hash)`; `during` non-empty with lower bound = `slot_start`.
  - Agent tables (`chat_sessions`, `mandate_consumption`, `agent_tool_replies`) are created in layer 2's own migration, not here. `audit_events` uses the toolkit's `schema.sql` verbatim, executed by this migration; `agent-toolkit-audit-log` is a PEP 508 git reference pinned to tag `v0.1.0rc1` (its commit in `uv.lock`), which needs `[tool.hatch.metadata] allow-direct-references = true`, and a test pins the sha256 of that `schema.sql`.
  - `migrations/env.py`: raw SQL revisions, no SQLAlchemy models or autogenerate. It connects with `MIGRATION_DATABASE_URL` (required, any libpq connection string) and runs every pending revision in one transaction under `lock_timeout = '5s'` and `statement_timeout = '5min'`. Offline (`--sql`) mode is refused, and revisions are forward-only (`downgrade` raises). Run from the CLI, it logs through `configure_logging` (redacting JSON), so `alembic.ini` has no logging sections.

- [x] **Step 1: Failing tests** — port every test of `apps/server/test/schema.test.ts` (overlap 23P01, adjacent ranges, expired frees slot, other resource, one holding per phone 23505 now per business, unknown statuses and flag kinds rejected, unique provider ids, zero amount rejected, empty range, lower bound, 7-digit cap per business, migration idempotent) plus `test_booking_numbers_are_per_business` (two businesses both get number 1) and `test_same_phone_may_hold_in_two_businesses`.
- [x] **Step 2–4:** fail, write `0001` as raw SQL via `op.execute`, pass.
- [x] **Step 5:** Commit `feat(api): add schema with per-business invariants`.

### Task 5: Migration 0002 — row-level security and definer functions (B) **[money]**

**Files:**
- Create: `migrations/versions/0002_rls.py`, `tests/db/test_rls.py`

**Interfaces:**
- Produces, per spec §5b:
  - On every tenant table: `ENABLE` and `FORCE ROW LEVEL SECURITY`; policy `tenant_isolation USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid) WITH CHECK (same)`. `memberships`: `USING (user_id = nullif(current_setting('app.user_id', true),'')::uuid OR business_id = nullif(current_setting('app.business_id', true),'')::uuid)`.
  - `audit_events`: `pialy_app` gets `INSERT, SELECT` only. `users`, `sessions`, `rate_limits`: no RLS, grants to `pialy_app`.
  - `SECURITY DEFINER` functions owned by `pialy_owner`, `SET search_path = public, pg_temp`, `EXECUTE` granted to `pialy_app` only: `business_id_by_slug(text) → uuid`, `connection_for_webhook(uuid) → TABLE(business_id uuid, webhook_secret_enc bytea, key_version int)`, `businesses_with_due_work(now timestamptz) → SETOF uuid` (holding bookings past expiry or attempts in the late-watch window), `claim_outbox(n int) → SETOF outbox` (`FOR UPDATE SKIP LOCKED`, marks `published_at`), `purge_expired(now timestamptz) → TABLE(kind text, n bigint)`, `create_business(...)` is added in layer 1; `chat_session_business(bytea)` and `invitation_by_token(bytea)` in layers 2 and 3.
- [ ] **Step 1: Failing tests:** `test_tenant_tables_have_forced_rls` (query `pg_class.relforcerowsecurity` for the list); `test_no_rows_without_business_setting`; `test_cannot_insert_row_for_other_business` (WITH CHECK → 42501); `test_definer_functions_return_only_their_fields`; `test_app_role_cannot_execute_ddl_or_alter_policy`; `test_audit_events_no_update_delete`.
- [ ] **Step 2–4:** fail, implement, pass.
- [ ] **Step 5:** Commit `feat(api): enforce tenant isolation with row-level security`.

### Task 6: Tenancy — businesses, credential encryption, pey connections (B)

**Files:**
- Create: `src/pialy/tenancy/{crypto,businesses,pey_connections}.py`, `tests/unit/test_crypto.py`, `tests/db/test_pey_connections.py`

**Interfaces:**
- Produces:
  - `CredentialCipher(keys: Mapping[int, bytes], current: int)`; `encrypt(plaintext: str, *, aad: bytes) -> bytes` = `version(1 byte) ‖ nonce(12) ‖ AESGCM ciphertext`; `decrypt(blob: bytes, *, aad: bytes) -> str`; `aad = f"{business_id}:{connection_id}".encode()`.
  - `Business` (id, slug, name, service_name, service_minutes, slot_minutes, deposit_minor, currency, timezone, hours, accepting_bookings); `resolve_slug(db: Database, slug: str) -> UUID | None`; `get_business(conn, ctx) -> Business`.
  - `PeyConnection` (id, business_id, status `pending|verified|disabled`, verified_at, api_key: SecretStr, webhook_secret: SecretStr); `get_connection(conn, ctx, cipher) -> PeyConnection | None`; `upsert_connection(conn, ctx, cipher, api_key: SecretStr, webhook_secret: SecretStr) -> PeyConnection` (status back to `pending`); `mark_verified(conn, ctx, at: datetime) -> None`; `webhook_lookup(db, connection_id, cipher) -> tuple[UUID, SecretStr] | None` via `connection_for_webhook`.
- [ ] **Step 1: Failing tests:** `test_round_trip`; `test_fresh_nonce_per_encryption`; `test_wrong_aad_fails` (blob of business X decrypted with Y's aad raises); `test_old_key_version_still_decrypts`; `test_connection_secrets_never_in_repr`; `test_connection_of_other_business_invisible`.
- [ ] **Step 2–4.** **Step 5:** Commit `feat(api): add businesses and encrypted pey connections`.

### Task 7: Contract suite and fake pey, proven against the TS server (B, Nov 21–22)

**Files:**
- Create: `tests/contract/pyproject.toml` (deps: pytest, httpx), `tests/contract/fake_pey/server.py`, `tests/contract/targets.py`, `tests/contract/conftest.py`, `tests/contract/test_{slots,holds,idempotency,qr,webhooks,payments,board,checkin,flags,sse,static}.py`, `tests/contract/README.md`

**Interfaces:**
- Produces:
  - Fake pey: stdlib `ThreadingHTTPServer` implementing `POST /codi/pn`, `POST /codi/qr`, `GET /transaction/*` as `packages/connector-pey` calls them (copy request and response shapes from `packages/connector-pey/src` and its test fixtures), plus control endpoints `POST /_control/pay {provider_ref, amount, late?}` (records a payment and POSTs a Standard-Webhooks-signed event to the target's webhook URL using `agent_toolkit.webhooks.testing.sign` semantics), `POST /_control/fail-next {status}`, `GET /_control/requests`. Run with `python -m fake_pey --port 4010 --secret-file …`.
  - `Target` protocol in `targets.py`: `prefix(path) -> str`, `webhook_path() -> str`, `login(client) -> None`, `reset_db() -> None`, `name: Literal["ts","py"]`. `TsTarget`: unscoped `/api/...`, `/api/webhooks/pey`, `POST /api/session {pin}`. `PyTarget`: `/api/b/{slug}/...`, `/api/webhooks/pey/{connection_id}`, `POST /api/auth/login {email,password}`. Selected by `CONTRACT_TARGET`; `BASE_URL`, `CONTRACT_DB_URL`, seeded credentials from env.
  - Marker `ts_only` / `py_only` for login-specific cases.
- [x] **Step 1:** Write the cases listed in spec §11 (contract suite) as tests: each `bookings-routes`, `qr-attempt`, `webhook`, `board` and `sse` test of `apps/server/test` that needs no clock control becomes one contract test with the same name in snake case. Time-dependent ones are not here (Task 15 maps them).
- [x] **Step 2:** Run against the TS server: `PEY_BASE_URL=http://localhost:4010 pnpm --filter server dev` and `CONTRACT_TARGET=ts uv run pytest` → all pass. A failure is a bug in the suite, not in the TS server; the TS server is not modified.
- [x] **Step 3:** Commit `test(contract): add black-box contract suite and fake pey`.

### Task 8: Booking domain (B) 

**Files:**
- Create: `src/pialy/booking/domain/{slots,booking,phone,banks}.py`, `tests/unit/test_booking_domain.py`

**Interfaces:**
- Produces: `normalize_phone(raw: str) -> str` (10 digits, raises `InvalidPhone` without echoing input); `phone_hash(phone: str, salt: bytes) -> str`; `day_slots(day: date, business: SlotRules, now: datetime) -> list[Slot]`; `offered_slot_at(start: datetime, rules) -> Slot | None`; `BookingStatus = Literal["holding","confirmed","checked_in","expired","canceled"]`; `bank_name(code: str) -> str | None`. Port of `apps/server/src/modules/booking/domain/*`.
- [ ] **Step 1:** port every test of `booking-domain.test.ts`. **Steps 2–4.** **Step 5:** Commit `feat(api): port booking domain`.

### Task 9: `PeyConnector` (A) **[money]**

**Files:**
- Create: `src/pialy/payments/pey.py`, `tests/unit/test_pey_connector.py`, `tests/fixtures/pey/*.json` (copied from `packages/connector-pey/test` fixtures, already synthetic)

**Interfaces:**
- Consumes: `agent_toolkit.payments_core.{RailConnector, PaymentIntent, Attempt, ProviderStatus, ProviderPayment}`.
- Produces: `PeyConnector(api_key: SecretStr, base_url: str, http: httpx.Client, clock: Clock)` implementing `RailConnector`; plus `request_push(intent, phone: str, expires_at) -> Attempt`, `request_qr(intent, expires_at) -> tuple[Attempt, QrPayload]`, `list_qr_payments(qr_id: str) -> list[ProviderPayment]`; `parse_payment_event(webhook: VerifiedWebhook) -> PeyPaymentEvent` (transaction id, QR id, amount minor, received_at, `metadata.attemptId`, tracking key, bank code, masked payer account). `httpx.Timeout(10.0, connect=3.0)`. Raises `PeyRejected(status, code)` (no provider message) and `PeyUnavailable`. `provider_ref` is assigned before sending: the attempt id echoed in `metadata.attemptId`; replaced by the pey `transactionId`/QR id in phase 2.
- [ ] **Step 1:** port every test of `packages/connector-pey/test/connector.test.ts`, plus `test_times_out_after_10_seconds_total` (fake transport that sleeps) and `test_error_never_contains_phone_or_clabe`.
- [ ] **Steps 2–4.** **Step 5:** Commit `feat(api): add pey connector`.

### Task 10: Intent repository and unit of work (A) **[money]**

**Files:**
- Create: `src/pialy/payments/{repository,read_model}.py`, `tests/db/test_payment_repository.py`

**Interfaces:**
- Produces: `PostgresUnitOfWork(conn)` satisfying `payments_core.UnitOfWork` over a `Database.tenant` connection; `PostgresIntentRepository(conn)` satisfying `IntentRepository`, reads `SELECT … FOR UPDATE`; `applied_event_ids` from `payment_events`; extra `get_by_attempt_id(attempt_id) -> PaymentIntent | None` and `set_provider_ref(attempt_id, ref) -> None`; `insert_new(intent) -> None`. `read_model.attempt_view(attempt: Attempt, failed_at) -> {"mode": "push"|"qr", "status": "awaiting"|"succeeded"|"expired"|"failed"}`.
- [ ] **Step 1:** `test_round_trips_intent_with_attempts`; `test_get_locks_row` (second connection's `get` waits until first commits; use `lock_timeout` to assert); `test_lookup_by_provider_ref_then_attempt_id`; `test_read_model_maps_every_status`.
- [ ] **Steps 2–4.** **Step 5:** Commit `feat(api): add postgres intent repository`.

### Task 11: Apply a payment, webhooks and inbox (A) **[money]**

**Files:**
- Create: `src/pialy/payments/apply.py`, `src/pialy/booking/application/on_payment.py`, `src/pialy/webhooks/{inbox,route}.py`, `src/pialy/realtime/outbox.py`, `tests/db/test_apply_payment.py`, `tests/http/test_webhooks.py`

**Interfaces:**
- Produces: `apply_payment(conn, ctx, event: PeyPaymentEvent, clock) -> ApplyResult` doing spec §7 "Apply a payment" in the caller's transaction (match by provider ref, then `metadata.attemptId`; `apply_provider_payment`; insert `payment_events`; refund flags → `flags` deduped by `provider_event_id`; booking reaction; outbox rows). `PostgresInbox(conn, connection_id)` satisfying `webhooks.Inbox`. Route `POST /api/webhooks/pey/{connection_id}`: raw body → `webhook_lookup` (unknown → 404) → `webhooks.verify` (401) → `Database.tenant(SystemActor("webhook"))` → `process_once` + `apply_payment` → 200. `enqueue(conn, ctx, topic: str, payload: dict[str, str]) -> None` (+ `NOTIFY pialy_outbox`).
- Binding hand-off from Task 4 (0001's `payment_events` CHECKs are a backstop that fails the whole insert):
  - The projection is total: fit-or-drop for every field of `raw` and for the `tracking_key` and `paid_at` columns, using the shape constants of 0001 (`PROVIDER_ID`, `DIGITS_ONLY`, `AMOUNT_BELOW`, `BANK_CODE`, `TRACKING_KEY`, `ACCOUNT_NUMBER`, `UUID`) and `payment_events_paid_at_check`, so the payment row always lands.
  - A dropped field raises an operator flag.
  - A property test checks that the projection of any payload inserts.
  - `datePaid` (Unix seconds) goes to the `paid_at` column as a `timestamptz`, from 2020-01-01 up to 2100-01-01 (`payment_events_paid_at_check`); it is not a key of `raw`, which refuses it.
  - A numeric `metadata.clabe` is converted to a string before masking.
  - `trackingKey` is masked in `flags.payload` too.
  - Verification accepts every active webhook secret (rotation lands in Task 6).
- [ ] **Step 1:** port every test of `webhook.test.ts` and the payment-reaction tests of `hold-slot.test.ts` (on-time confirm, late confirm, refund_due when slot taken, second payment, unmatched, amount mismatch, no booking); with the spec §7 differences asserted: `partially_paid` raises `amount_mismatch` and keeps holding; `excess` confirms and raises `refund_due`. Add `test_secret_of_other_connection_is_401` (Review Focus 2) and `test_unknown_connection_is_404`.
- [ ] **Steps 2–4.** **Step 5:** Commit `feat(api): apply pey payments from signed webhooks`.

### Task 12: Hold a slot, QR attempts, idempotency, rate limits (A with B) **[money]**

**Files:**
- Create: `src/pialy/booking/application/{hold_slot,start_qr_attempt,get_slots}.py`, `src/pialy/http/{idempotency,client_ip}.py`, `src/pialy/identity/rate_limits.py`, `tests/db/test_hold_slot.py`, `tests/db/test_qr_attempt.py`

**Interfaces:**
- Produces: `hold_slot(db, ctx, cmd: HoldCommand, connector: PeyConnector, clock) -> HoldResult` (phase 1 commit: booking `holding`, intent `pending`, attempt with `provider_ref` = attempt id; then the pey push outside any transaction; phase 2 stores provider ids; push failure → hold ends, `PeyFailed` → 502 problem); `start_qr_attempt(...)` (max 3 attempts per booking, failed ones count; extends hold to QR expiry; withholds QR with 409 if paid meanwhile); `Idempotency` helper with recovery points ported from `apps/server/src/infrastructure/idempotency.ts`, keyed `(business_id, scope, key)`; `RateLimiter(db).hit(key: str, limit: int, window: timedelta, now) -> bool` on `rate_limits` (`INSERT … ON CONFLICT DO UPDATE SET count = count + 1 RETURNING count`). Limits: 10 holds per IP per 10 min; 3 holds per phone hash per 10 min; replays do not count. `client_ip` keyed on `X-Real-IP` when it parses as an IP, else the peer address.
- [ ] **Step 1:** port every test of `hold-slot.test.ts` (holds and pushes, RF1, RF2, in-flight, key reuse, failures, recovery) and `qr-attempt.test.ts`; plus `test_no_transaction_open_during_pey_call` (fake connector asserts `pg_stat_activity` shows no `idle in transaction` for the app user while called) and `test_slow_pey_ends_with_502_within_timeout` (Review Focus 3).
- [ ] **Steps 2–4.** **Step 5:** Commit `feat(api): hold slots and start qr attempts`.

### Task 13: Agenda, check-in, flags (B)

**Files:**
- Create: `src/pialy/booking/application/{check_in,resolve_flag,board}.py`, `src/pialy/booking/repository.py`, `tests/db/test_board.py`

**Interfaces:**
- Produces: `board_day(conn, ctx, day: date) -> BoardView`; `recent_paid(conn, ctx, since) -> list[PaidNotice]`; `check_in(conn, ctx, token, clock) -> CheckInResult` (409 with original time on repeat; only the pass's local day); `resolve_flag(conn, ctx, flag_id, note) -> None`; `verify_pass(conn, ctx, token) -> PassView`. Never returns phone hash or CLABE.
- [ ] **Step 1:** port the non-auth tests of `board.test.ts`. **Steps 2–4.** **Step 5:** Commit `feat(api): add agenda, check-in and flags`.

### Task 14: Realtime — relay, NOTIFY fan-out, SSE hub (B)

**Files:**
- Create: `src/pialy/realtime/{relay,hub}.py`, `src/pialy/http/routes/events.py`, `tests/unit/test_sse_hub.py`, `tests/db/test_relay.py`

**Interfaces:**
- Produces: `SseHub(per_topic=20, total=500, heartbeat=timedelta(seconds=20))` with `subscribe(topic) -> Subscription | None`, `publish(topic, event, data)`, `close_all(retry_ms=3000)`; topics `booking:{business_id}:{token}` and `board:{business_id}`. `OutboxRelay(db, hub)`: a dedicated connection `LISTEN pialy_outbox`; on notify or every 2 s calls `claim_outbox(100)` and publishes; payload carries only event type and new status. On shutdown the app calls `hub.close_all()` then the relay stops.
- [ ] **Step 1:** port every test of `sse.test.ts` (keep 20/500 caps and 20 s heartbeat), plus `test_two_relays_never_publish_one_row_twice` and `test_sigterm_closes_streams_with_retry_hint` (Review Focus 4: lifespan shutdown with an open stream finishes < 10 s).
- [ ] **Steps 2–4.** **Step 5:** Commit `feat(api): add outbox relay and sse hub`.

### Task 15: Sweeper and retention (A) **[money]**

**Files:**
- Create: `src/pialy/jobs/{sweeper,retention,runner}.py`, `tests/jobs/test_sweeper.py`, `tests/jobs/test_runner.py`, `docs/superpowers/plans/ts-to-py-time-tests.md`

**Interfaces:**
- Produces: `Sweeper(db, connector_for: Callable[[UUID], PeyConnector], clock).tick(n: int) -> SweepReport`: takes the `"sweeper"` advisory lock (skip if held); `businesses_with_due_work(now)`; per business inside its tenant context: expire or confirm holds per spec §7, QR attempts pass every listed payment through `apply_payment` first; the late watch runs on tick 0 and every 4th tick, covers attempts up to 40 min after expiry; rail errors keep a hold up to 10 min after expiry, then expire; an attempt that errors rests 1 min. `Retention.purge(now)` via `purge_expired`: sessions past expiry, idempotency keys > 24 h, outbox published > 24 h, rate-limit windows > 1 h. `Runner(interval=15s)`: runs at once, then an interval after each run ends; never overlaps; logs and continues on failure; `stop()` waits for the run in progress.
- [ ] **Step 1:** port every test of `sweeper.test.ts` with an injected clock; write `ts-to-py-time-tests.md` mapping each TS test name to the Python test (spec §11).
- [ ] **Steps 2–4.** **Step 5:** Commit `feat(api): add sweeper and retention jobs`.

### Task 16: Owner login for the seeded business, audit of platform events (B)

**Files:**
- Create: `src/pialy/identity/{passwords,sessions,users}.py`, `src/pialy/audit/platform.py`, `src/pialy/http/deps.py`, `src/pialy/http/routes/auth.py`, `tests/http/test_auth.py`, `tests/http/test_route_table.py`

**Interfaces:**
- Produces:
  - `hash_password(p: SecretStr) -> str` (argon2-cffi `PasswordHasher()` defaults); `verify_password(hash, p) -> bool` with `check_needs_rehash`; minimum 12 characters.
  - Sessions: token `secrets.token_urlsafe(32)`, stored `sha256(token)`; cookie `pialy_session`, httpOnly, `SameSite=Strict`, `Secure` in production, `Max-Age=43200`; logout deletes the row.
  - Routes: `POST /api/auth/login {email, password}` → 204 + cookie, or 401 problem `urn:pialy:problem:invalid-credentials` identical for unknown email and wrong password (a dummy hash is verified for unknown emails); lockout: 5 failures per IP per 10 min, 10 per account per 10 min → 429; `POST /api/auth/logout` → 204; `GET /api/auth/me` → `{email, businesses: [{slug, name, role}]}`.
  - `deps.py`: `current_user(request) -> UserId`; `member(role: Literal["owner","staff"]) -> Depends[TenantContext]` resolving slug → business id → membership role (`owner` satisfies `staff`); `public_tenant(slug) -> TenantContext` with `PublicActor`; `same_origin` dependency on every non-GET route (`Origin` must equal `public_origin`, else 403).
  - `append_platform_event(conn, kind: Literal["login_failed","login_locked","pey_connection_changed","pey_connection_verified","deposit_changed","member_added","member_removed"], refs: Mapping[str, str]) -> None` using `agent_toolkit.audit_log.append` on `PostgresAuditStore`; the payload hash is `hash_payload(canonical_json(refs), audit_hmac_key)`; refs are ids, never emails. The chain is global, so a concurrent append can raise `ChainConflict`: retry up to 3 times, then fail the request (a failed audit never passes silently).
- [ ] **Step 1: Failing tests:** port the cookie tests of `board.test.ts` (401 without cookie on every owner endpoint, signed httpOnly Strict 12 h, tampered and expired rejected, logout, Secure in production) to the account session; `test_login_same_answer_for_unknown_email`; `test_lockout_per_ip_and_per_account`; `test_failed_login_audited_without_email`; `test_cross_origin_post_is_403`; `test_route_table_every_api_route_declares_access` — walks `app.routes` and fails for any `/api/` route lacking one of `member`, `public_tenant`, `current_user`, or an explicit `@public_route` marker (health, webhook, auth login).
- [ ] **Steps 2–4.** **Step 5:** Commit `feat(api): add account sessions for business owners`.

### Task 17: HTTP routes under `/api/b/{slug}` and static SPA (B)

**Files:**
- Create: `src/pialy/http/routes/{slots,bookings,board}.py`, `src/pialy/http/static.py`, `tests/http/test_routes.py`, `tests/http/test_static.py`

**Interfaces:**
- Produces the routes of spec §10 with identical JSON bodies, events and problem type URNs as the TS routes in `apps/server/src/http/routes/*.ts`: `GET /api/b/{slug}/slots`, `POST /api/b/{slug}/bookings`, `GET /api/b/{slug}/bookings/{token}`, `POST …/bookings/{token}/qr`, `GET …/bookings/{token}/events`, `GET /api/b/{slug}/board`, `GET …/board/events`, `POST …/bookings/{token}/check-in`, `POST …/flags/{id}/resolve`, `GET …/verify/{token}`. A business with `accepting_bookings = false` answers `POST bookings` with 409 `urn:pialy:problem:not-accepting-bookings`. Static: same behavior as `apps/server/src/http/web.ts` (index without cache, immutable assets, brotli variants, problem+json 404 for API, HEAD).
- [ ] **Step 1:** port the HTTP-level tests of `bookings-routes.test.ts` and `web.test.ts` against the new paths.
- [ ] **Steps 2–4.** **Step 5:** Commit `feat(api): expose business-scoped routes and serve the web app`.

### Task 18: Two-business isolation suite and contract run against Python (B) **[money]**

**Files:**
- Create: `tests/http/test_tenancy.py`, `src/pialy/cli.py` (`seed`, `reset-password`)

**Interfaces:**
- Produces: `uv run pialy seed --slug estudio-demo --owner-email … --password-file …` creates a business, an owner, a resource, a pey connection from `--pey-key-file` / `--pey-secret-file`, idempotent. `uv run pialy reset-password --email …` reads the new password from stdin.
- [ ] **Step 1:** `test_tenancy.py` creates businesses A and B with separate fake pey connections and, for every route in the route table, calls it on A's slug with B's token/id/flag → 404 or empty, and as A's owner on B's slug → 403/404; repository functions called with A's context and B's ids return nothing; B's webhook secret on A's URL → 401 (Review Focus 1).
- [ ] **Step 2:** `CONTRACT_TARGET=py uv run pytest` in `tests/contract` against `uv run uvicorn pialy.main:app_factory --factory` → all pass.
- [ ] **Step 3:** Commit `test(api): prove tenant isolation and pass the contract suite`.

### Task 19: Web app against the Python API (D)

**Files:**
- Modify: `apps/web/src/api.ts` (`API_PATH` gains `slug`), the PIN screen → login screen (email + password), routes reading the slug from the URL; `apps/web` tests

**Interfaces:**
- Consumes: Task 16 and 17 routes.
- [ ] **Step 1:** update web tests for the new paths and the login form; **Step 2:** fail; **Step 3:** implement; **Step 4:** `pnpm --filter web lint typecheck test build` green; manual run against `uvicorn` with the seeded business.
- [ ] **Step 5:** Commit `feat(web): use business-scoped api and account login`.

### Task 20: CI pipeline (D)

**Files:**
- Create: `.github/workflows/ci.yml`, `.gitleaks.toml` (allowlist only the synthetic fixtures)

- [x] **Step 0: Path filters without skipping required checks.** No workflow-level `paths:` (a skipped workflow leaves required checks pending). A first job `changes` runs `git diff --name-only <base>...HEAD` (no third-party action) and outputs `api` (`apps/api/**`, `tests/contract/**`, `uv.lock`), `web` (`apps/web/**`, `packages/**`, `pnpm-lock.yaml`), `contract` (api or `apps/server/**` or `tests/contract/**`). Each job below has `needs: changes` and `if:` on its flag; a job skipped by `if:` reports success to branch protection. On `push` to `main` every flag is true. `gitleaks` always runs. All commands go through the root scripts from Task 1 (`pnpm api:sync`, `pnpm api:lint`, `pnpm api:test`).
- [x] **Step 1:** Jobs on `pull_request` and `push` to `main`: `api` (Postgres 16 service with the two roles; `uv sync --locked`, ruff, ruff format check, mypy, lint-imports, pytest, `uv run pip-audit`), `contract` (starts fake pey and the Python app, runs `tests/contract`), `web` (`pnpm install --frozen-lockfile`, lint, typecheck, test, build, `pnpm audit --prod --audit-level high`), `docker` (build only; added by the deploy plan with the Dockerfile), `gitleaks`.
- [ ] **Step 2:** open a PR; all jobs green.
- [ ] **Step 3:** Ask the user to protect `main` (required checks: `ci-ok` and `gitleaks`. A job skipped by its `if:` reports success, so `ci-ok` stands in for api, contract and web: it fails unless each passed or was skipped by its path filter, which keeps a cancelled run from passing). Commit `ci: add pipeline for api, contract suite and web`.

---

## Self-review notes

- Spec §12b items owned elsewhere: OpenAPI-generated web types (registration plan), Dockerfile, pre-deploy migrations, backups, runbook (deploy plan), agent tables (agent plan).
- SSE heartbeat is 20 s as in the TS server and its tests (spec §12b said 25 s; spec corrected to 20 s).
