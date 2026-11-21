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
