# pialy: agent instructions

Deposit booking for small businesses, paid with CoDi through pey. Entry for Hackatón México 2026.
Today a TypeScript server runs in production. A Python backend with a booking agent replaces it,
multi-tenant, built on [agent-toolkit](https://github.com/jovandyaz/agent-toolkit).

## Read first
- Design: `docs/superpowers/specs/2026-11-20-pialy-python-backend-agent-design.md` (approved 2026-11-20).
  The original design (`2026-11-14-pialy-design.md`) describes the TS server in production.
- Plans in `docs/superpowers/plans/`, run in this order. Tick steps as they land; the plans are the progress record.
  1. `2026-11-20-pialy-0-foundation.md`: the Python base, at parity with TS, with RLS.
  2. `2026-11-20-pialy-1-registration.md`: self-service registration and pey connection.
  3. `2026-11-20-pialy-2-agent.md`: booking agent.
  4. `2026-11-20-pialy-3-roles-invitations.md`: staff role and invitations.
  5. `2026-11-20-pialy-deploy-cutover.md`: Docker, Railway and cutover. Runs in parallel from the base onward.
- If time runs short, cut in this order: layer 4, then roles and invitations, then the agent.
  The production requirements (design §12b) are never cut.
- Roles: A payments, B platform, C agent, D web and infra. Each plan says which tasks belong to whom.
- Each port names its TS file and its tests. `apps/server/src` and `apps/server/test` are the behavior
  reference until the cutover.

## Layout
- `apps/web`: React + Vite SPA (pnpm).
- `apps/server`, `packages/connector-pey`, `packages/payments`: TS backend in production. They are deleted at cutover.
- `apps/api`: Python backend (uv, its own `pyproject.toml` and `uv.lock`, no `package.json`). Created by Task 1 of the base.
- `tests/contract`: black-box suite that runs against both backends.

## Tooling
pnpm workspaces for JS, uv for `apps/api`. No Nx or Turborepo. Never use npm or yarn.
Node 24 (`.nvmrc`), Python 3.13.

```sh
pnpm install
docker compose -f docker-compose.test.yml up -d   # Postgres for tests (port 54329)
pnpm lint && pnpm typecheck && pnpm test          # JS
pnpm api:lint && pnpm api:test                    # Python
pnpm check                                        # all of it
```

## Rules
- Public repo: no secrets, real CLABEs, people's names, phone numbers or pey operational details
  in code, fixtures, docs or commits. Fixtures are synthetic (`123456789012345678`, `5512345678`, `3312345678`).
- Secrets go in the Keychain or in `.env` (git-ignored). Never in chat, the repo or shell history.
- Money is an integer in minor units plus an ISO 4217 currency, never a float.
  `DEPOSIT_MAX_MINOR` is 1 during the hackathon.
- Every tenant query runs in `Database.tenant(ctx)`. The `pialy_app` role has no `BYPASSRLS`.
- Full phone numbers live only in memory during the request. Only the hash and the last 4 digits are stored.
- Tasks marked **[money]**:
  - TDD, with a fresh reviewer per task.
  - Never weaken a test.
  - Ask before deciding anything ambiguous.
- Before implementing, check the official docs: pey (docs.pey.mx), Banxico/CoDi, Standard Webhooks, and
  each library's docs via Context7. Docs beat memory.
- Steps marked [user] (Railway, secrets, domain, merges, deleting the TS service) need the user's OK.

## Git
Conventional Commits, single line, English, imperative, no `Co-Authored-By` or agent trailers.
One branch per task group, PR to `main`. Never push to `main` or force-push it. Commit, push and open PRs only
when asked.
