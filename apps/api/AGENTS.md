# apps/api: agent instructions

Python 3.13 backend (FastAPI, psycopg, Alembic), managed with uv. Root `AGENTS.md` rules apply.

## Commands (from the repo root)
- `pnpm api:sync`: install locked dependencies.
- `pnpm api:lint`: ruff, ruff format check, `mypy --strict`, import-linter.
- `pnpm api:test`: pytest. Database tests need `docker compose -f docker-compose.test.yml up -d`;
  the script points `TEST_DATABASE_URL` (an admin URL of a disposable cluster: the fixtures reset
  the `pialy_owner`/`pialy_app` passwords) at it unless set. Without it they are skipped. They refuse
  a non-loopback host, in the URL or in `PGHOST`/`PGHOSTADDR`, unless `PIALY_TEST_DB_DISPOSABLE=1`
  (CI jobs running in a container).
- Migrations: raw SQL Alembic revisions in `migrations/versions`, forward-only, run as the owner
  role from `apps/api`: `MIGRATION_DATABASE_URL=... uv run alembic upgrade head`.
- Tenant tables: `business_id` leads every key and index, unique keys hold per business, and
  foreign keys go through `(business_id, id)`. The exceptions are deliberate, each reached before
  the business is known: the global keys `business.slug` (public URL), `lower(users.email)`
  (login), `invitations.token_hash` (accepting an invitation),
  `webhook_inbox (connection_id, webhook_id)` and `pey_connections.id` (a webhook names its
  connection, which names the business), and the index `memberships (user_id)` (login lists a
  user's businesses). `NOT_LED_BY_BUSINESS` in `tests/db/test_schema.py` lists those of tenant
  tables; a new exception goes there with its reason. A new tenant table joins `TENANT_TABLES` in
  the same file, whose structural tests enforce these rules (see `0001_tables.py`).
- `pnpm api:dev`: run the server on port 3000.

## Conventions
- `mypy --strict`, no `Any` in module interfaces; pydantic models frozen and strict at boundaries.
  Deliberate exception: `Settings` is frozen but not strict, because environment values arrive as
  strings and need coercion (`PORT` to an int, `PUBLIC_ORIGIN` to a URL, `LOG_LEVEL` to capitals).
- Settings come from `pialy.config.load_settings()`; errors print variable names only, never values.
- Time comes from the injected `Clock`, never `datetime.now()` in domain code.
- `pialy.booking.domain` imports no framework or infrastructure (enforced by `.importlinter`).
- Only `pialy.http` and `pialy.main` import `fastapi`.
- Money: integer minor units plus ISO 4217 currency, never float.

## Dependencies
- `[tool.uv] exclude-newer = "7 days"`: uv ignores releases younger than 7 days (supply-chain
  cooldown). `uv.lock` stores the span (`exclude-newer-span = "P7D"`) and is not re-resolved as
  time passes, so `uv sync --locked` stays reproducible.
- Upgrade: `uv lock --upgrade` (or `--upgrade-package NAME`) takes the newest release that is at
  least 7 days old. Then `pnpm api:lint && pnpm api:test` and `uv run pip-audit`.
- Urgent security fix younger than 7 days: add `exclude-newer-package = { NAME = false }` under
  `[tool.uv]`, run `uv lock --upgrade-package NAME`, and commit both. Keep the exemption until the
  release is 7 days old, then delete it: removing it earlier makes the next `uv lock` downgrade
  the package again.
