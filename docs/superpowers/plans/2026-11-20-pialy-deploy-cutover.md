# Pialy: deploy, parallel run and cutover — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Steps marked **[user]** need the user's explicit OK at the time (Railway changes, secrets, domain, merges); an agent prepares them and stops.

**Goal:** The Python backend runs on Railway next to the TS service, proves itself with the contract suite and real $0.01 charges on at least two banks, takes over the public URL, and the TS backend is deleted; the operator can restore a backup and run the runbook.

**Architecture:** One multi-stage Docker image (Node builds `apps/web`; Python serves API + SPA as a non-root user). A second Railway service and Postgres for it, configured from `apps/api/railway.json`; migrations run as Railway's pre-deploy command with the owner role; the healthcheck is `/readyz`.

**Tech Stack:** Docker, Railway (config as code, pre-deploy command, point-in-time recovery), GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-11-20-pialy-python-backend-agent-design.md` §12, §12b (reliability, backups, observability, delivery pipeline), §13 (dates: parallel deploy Nov 24–27, cutover Dec 1–5, fallback Dec 5), §16.

## Global Constraints

- Everything in layer 0's Global Constraints.
- Secrets only in Railway variables; locally in `~/.zshrc.secrets` (mode 600) or the Keychain; never in chat, the repo or shell history. pey keys belong to the business connections (entered through the app), not to Railway variables.
- The TS service keeps serving the public URL until cutover; it is not modified.
- Fallback: if the Python backend has not passed Task 5 by 2026-12-05, the TS backend is delivered and this plan stops at Task 5.
- Never push to `main`; merges, domain moves and Railway changes only with the user's OK.

## Review Focus

1. A deploy whose migration fails → the pre-deploy command exits non-zero, Railway keeps the previous deployment serving, nothing half-migrated is live (Task 2).
2. The container receives SIGTERM during a deploy with SSE clients and a pey call in flight → the call completes or its hold is recovered by the sweeper; streams end with a retry hint (Task 2 smoke check).
3. The database password or `CREDENTIALS_ENC_KEY` is rotated → the runbook procedure works without downtime beyond one restart and every pey connection still decrypts (Task 6).
4. The web bundle is built with a stale API base or an old `openapi.json` → CI fails on drift before deploy (Task 1).
5. A restore to a point in time is needed after a bad migration → the rehearsed procedure brings back a working database as a new service and the app is pointed at it (Task 6).

## Roles and order

D owns all tasks; A joins Task 5 (bank tests); the user approves every **[user]** step. 1 → 2 → 3 → 4 → 5 → 6 → 7.

---

### Task 1: Docker image (D)

**Files:** Create `apps/api/Dockerfile`, `.dockerignore`; Modify `.github/workflows/ci.yml` (add `docker` job: build, then run the image against the CI Postgres and hit `/readyz`)

- Stage `web`: `node:22-alpine` pinned by digest, `corepack enable`, `pnpm install --frozen-lockfile --filter web...`, `pnpm --filter web build` (precompressed assets as today).
- Stage `api`: `python:3.13-slim` pinned by digest, `uv` copied from `ghcr.io/astral-sh/uv` pinned, `uv sync --locked --no-dev --project apps/api`; copy `apps/web/dist` to `/app/web`; `USER 10001`; `ENV WEB_ROOT=/app/web`; `CMD ["uvicorn","pialy.main:app_factory","--factory","--host","0.0.0.0","--port","${PORT}","--proxy-headers","--forwarded-allow-ips","*","--timeout-graceful-shutdown","10"]` (shell form for `$PORT`).
- [ ] **Step 1:** `docker build -f apps/api/Dockerfile .` succeeds; image runs as uid 10001; size < 400 MB.
- [ ] **Step 2:** CI `docker` job green. Commit `build(api): add production docker image`.

### Task 2: Railway config and database roles (D)

**Files:** Create `apps/api/railway.json`, `apps/api/scripts/bootstrap_roles.sql`, `docs/runbook.md` (first sections)

- `apps/api/railway.json`: `build.builder = "DOCKERFILE"`, `build.dockerfilePath = "apps/api/Dockerfile"`; `deploy.preDeployCommand = ["uv run --no-sync alembic upgrade head"]` (uses `MIGRATION_DATABASE_URL`); `deploy.healthcheckPath = "/readyz"`, `healthcheckTimeout = 60`; `restartPolicyType = "ON_FAILURE"`, `restartPolicyMaxRetries = 5`; `numReplicas = 1`. Confirm each key against docs.railway.com/config-as-code/reference before committing.
- `bootstrap_roles.sql`: creates `pialy_owner` (owns schema) and `pialy_app` (`LOGIN NOSUPERUSER NOBYPASSRLS`), revokes `CREATE` on `public` from `PUBLIC`; run once by the operator with the Railway superuser URL.
- [ ] **Step 1:** locally, `docker compose` + the image with a deliberately broken migration → pre-deploy exits 1 (Review Focus 1).
- [ ] **Step 2:** Commit `build(api): add railway config with pre-deploy migrations`.

### Task 3: Staging service on Railway (D) **[user]**

- [ ] **Step 1 [user]:** create service `pialy-api` and a new Postgres in the existing Railway project; set the service's config file to `/apps/api/railway.json`; run `bootstrap_roles.sql`; set variables: `DATABASE_URL` (app role), `MIGRATION_DATABASE_URL` (owner role), `SESSION_SECRET`, `CREDENTIALS_ENC_KEY`, `PHONE_HASH_SALT`, `MANDATE_HMAC_KEY`, `AUDIT_HMAC_KEY` (each generated with `openssl rand -base64 32` by the user, pasted straight into Railway), `PUBLIC_ORIGIN`, `PEY_BASE_URL`, `DEPOSIT_MAX_MINOR=1`, `AGENT_ENABLED=false`.
- [ ] **Step 2 [user]:** enable point-in-time recovery on the new Postgres (docs.railway.com/volumes/point-in-time-recovery); if the plan does not offer it, enable scheduled volume backups and note which in the runbook.
- [ ] **Step 3:** deploy from the branch; `/readyz` 200; contract suite (`CONTRACT_TARGET=py`) against the staging URL with fake pey disabled for the push tests that need real pey (marked `real_pey`, skipped).

### Task 4: Team businesses on staging (D with the account holders) **[user]**

- [ ] **Step 1 [user]:** each team member whose pey account is active registers a business through the app (layer 1 flow), creates a pey API key on their own portal account, pastes the business's webhook URL into pey, enters key and secret in Pialy, and verifies with a $0.01 charge paid by another team member. Keys are typed only into the app; never into chat, files or Railway variables.
- [ ] **Step 2:** record in `README.md` only which banks were used (no names, CLABEs or keys).

### Task 5: Real charges on two banks (A, D) **[user]**

- [ ] **Step 1 [user]:** for each team business: push paid on time; push left to expire; QR paid; QR paid twice (refund flag); late payment after expiry. Payer banks: at least two different banks (e.g. BBVA and another). Compare each result with the TS server's documented behavior.
- [ ] **Step 2:** fill the README bank table; open issues for any difference. This task is the gate for cutover and for the Dec 5 fallback decision.

### Task 6: Runbook and restore rehearsal (D)

**Files:** Complete `docs/runbook.md`

- Sections: deploy and rollback (Railway redeploy of the previous image); rotate `CREDENTIALS_ENC_KEY` (add `v2:` key, run `pialy reencrypt-connections`, remove `v1` next release); rotate database passwords; disconnect a business (`pialy disable-connection --slug`); replay a webhook from the inbox; reset an owner password (`pialy reset-password`); cut the agent (`AGENT_ENABLED=false`); restore to a point in time as a new service and repoint `DATABASE_URL`/`MIGRATION_DATABASE_URL`.
- [ ] **Step 1 [user]:** rehearse the restore on staging (Review Focus 5); write the time it took and any surprise into the runbook.
- [ ] **Step 2:** add `pialy reencrypt-connections` and `pialy disable-connection` to `cli.py` with tests (`test_reencrypt_keeps_every_connection_decryptable`, Review Focus 3). Commit `docs: add operator runbook`.

### Task 7: Cutover (D) **[user]**

- [ ] **Step 1 [user]:** move the public domain from the TS service to `pialy-api`; confirm `/readyz`, one real booking, the agenda SSE.
- [ ] **Step 2:** PR `chore: remove typescript backend` deleting `apps/server`, `packages/payments`, `packages/connector-pey`, the root `railway.json`; README rewritten (architecture, run instructions, tested banks, "Pre-existing components": `agent-toolkit` built 2026-11-15 to 11-20 inside the hackathon period); `AGENTS.md` updated. **[user]** merges.
- [ ] **Step 3 [user]:** after one day without incidents, delete the TS Railway service and its database (destructive: confirm first, export a final dump).
- [ ] **Step 4 [user]:** branch protection on `main` with required checks api, contract, web, docker, gitleaks.
