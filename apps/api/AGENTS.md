# apps/api: agent instructions

Python 3.13 backend (FastAPI, psycopg, Alembic), managed with uv. Root `AGENTS.md` rules apply.

## Commands (from the repo root)
- `pnpm api:sync`: install locked dependencies.
- `pnpm api:lint`: ruff, ruff format check, `mypy --strict`, import-linter.
- `pnpm api:test`: pytest.
- `pnpm api:dev`: run the server on port 3000.

## Conventions
- `mypy --strict`, no `Any` in module interfaces; pydantic models frozen and strict at boundaries.
- Settings come from `pialy.config.load_settings()`; errors print variable names only, never values.
- Time comes from the injected `Clock`, never `datetime.now()` in domain code.
- `pialy.booking.domain` imports no framework or infrastructure (enforced by `.importlinter`).
- Only `pialy.http` and `pialy.main` import `fastapi`.
- Money: integer minor units plus ISO 4217 currency, never float.
