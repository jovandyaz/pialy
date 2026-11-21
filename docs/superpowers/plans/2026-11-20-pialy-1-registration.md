# Pialy layer 1: self-service registration — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person signs up, registers a business, connects that business's own pey key, verifies it with one real $0.01 charge, and the business starts taking paid bookings, with no help from the team.

**Architecture:** Builds on layer 0 (`2026-11-20-pialy-0-foundation.md`): `identity` gains sign-up, `tenancy` gains business creation and settings, the pey connection gains a verification charge that is an ordinary payment intent with its own purpose. The web app gains sign-up, business setup and pey connection screens, typed from the API's OpenAPI document.

**Tech Stack:** as layer 0; web: React + Vite + the existing visual language; `openapi-typescript` (dev dependency) for generated types.

**Spec:** `docs/superpowers/specs/2026-11-20-pialy-python-backend-agent-design.md` §5b (registration, pey connection, deposit), §10 platform routes, §12b (security, delivery pipeline), §13 layer 1.

## Global Constraints

- Everything in layer 0's Global Constraints.
- Every business has exactly one person, its owner, in this layer; `staff` and invitations are layer 3.
- No mail provider: sign-up answers 409 `urn:pialy:problem:email-taken` for a registered email (rate-limited 5 sign-ups per IP per hour); there is no email verification and no self-service password reset (operator command `pialy reset-password`).
- The pey key and webhook secret are write-only through the API: never returned, logged or sent to the browser after submission.
- A business is bookable only when `pey_connections.status = 'verified'` and `business.accepting_bookings = true`; verification sets both.
- Deposit: integer minor units, `1 ≤ deposit_minor ≤ DEPOSIT_MAX_MINOR`.
- Pialy never sends or stores a receiving account; pey binds it to the key.

## Review Focus

1. The owner pastes the key with leading/trailing spaces or a newline → stored trimmed; a key with inner whitespace → 422 (Task 3).
2. The verification webhook never arrives because the owner did not register the URL in pey, but the sweeper sees the charge paid → status `webhook_missing`, the business stays not bookable, and the screen tells the owner to register the URL (Task 3).
3. Two browser tabs submit "create business" with the same slug at once → one 201, one 409 `slug-taken`, no half-created business (Task 1).
4. The owner changes the pey key after verification → status back to `pending`, bookings stop until re-verified, an audit event is written (Task 3).
5. Hours where closing is before opening, or a timezone that is not an IANA name → 422 naming the field (Task 2).

## Roles and order

Task 1 → 2 → 3 (A for 3, the money path; B for 1–2) · Task 4 (D) can start with 1 · Task 5 (D) needs 1–4 · Task 6 (B) last.

---

### Task 1: Sign-up and business creation (B)

**Files:**
- Create: `migrations/versions/0003_registration.py`, `src/pialy/http/routes/businesses.py`, `tests/http/test_signup.py`, `tests/db/test_create_business.py`
- Modify: `src/pialy/http/routes/auth.py`, `src/pialy/identity/users.py`

**Interfaces:**
- Consumes: layer 0 `hash_password`, sessions, `RateLimiter`, `Database.system()/user()`, `append_platform_event`.
- Produces:
  - `POST /api/auth/signup {email, password}` → 201 + session cookie; email lower-cased and trimmed, `email_validator`-free check `^[^@\s]+@[^@\s]+\.[^@\s]+$`, max 254; password 12–128 chars.
  - Migration 0003: `SECURITY DEFINER create_business(owner uuid, slug text, name text, service_name text, service_minutes int, slot_minutes int, deposit_minor int, timezone text, hours jsonb) RETURNS uuid` inserting `business` (`accepting_bookings=false`), one resource named after the service, and the `owner` membership, in one statement block; raises `unique_violation` on slug. Also `payment_intents.purpose text NOT NULL DEFAULT 'booking_deposit' CHECK (purpose IN ('booking_deposit','connection_check'))`.
  - `POST /api/businesses {slug, name, serviceName, serviceMinutes, slotMinutes, depositMinor, timezone, hours}` (signed in) → 201 `{slug}`; 409 `urn:pialy:problem:slug-taken`.
  - Reserved slugs: `api`, `admin`, `app`, `login`, `signup`, `negocio`, `assets`, `static`, `healthz`, `readyz`.
- [ ] **Step 1: Failing tests:** `test_signup_creates_user_and_session`; `test_signup_existing_email_409`; `test_signup_rate_limited_per_ip`; `test_password_shorter_than_12_rejected`; `test_create_business_makes_owner_membership_and_resource`; `test_concurrent_same_slug_one_wins` (Review Focus 3); `test_reserved_slug_rejected`; `test_new_business_not_accepting_bookings`.
- [ ] **Steps 2–4.** **Step 5:** Commit `feat(api): add sign-up and business creation`.

### Task 2: Business settings (B)

**Files:**
- Create: `src/pialy/tenancy/settings.py`, `tests/http/test_business_settings.py`
- Modify: `src/pialy/http/routes/businesses.py`

**Interfaces:**
- Produces: `GET /api/businesses/{slug}` (owner) → full settings + `peyConnection: {status, webhookUrl, verifiedAt}`; `PATCH /api/businesses/{slug}` (owner) partial update of name, service, minutes, deposit, timezone, hours; `GET /api/b/{slug}` (public) → `{name, serviceName, serviceMinutes, depositMinor, currency, acceptingBookings}`. `Hours` model: `{"mon": [["09:00","19:00"]], …}`, each interval `open < close`, `HH:MM`, at most 2 intervals per day; timezone validated with `zoneinfo.ZoneInfo`. Deposit change appends `deposit_changed` audit (old and new amounts).
- [ ] **Step 1:** `test_owner_reads_and_updates_settings`; `test_non_member_gets_404`; `test_deposit_above_max_422`; `test_invalid_hours_and_timezone_422` (Review Focus 5); `test_public_view_hides_owner_fields`; `test_deposit_change_audited`.
- [ ] **Steps 2–4.** **Step 5:** Commit `feat(api): add business settings`.

### Task 3: Connect and verify pey (A) **[money]**

**Files:**
- Create: `src/pialy/tenancy/verification.py`, `tests/db/test_pey_verification.py`, `tests/http/test_pey_connection.py`
- Modify: `src/pialy/payments/apply.py` (purpose branch), `src/pialy/jobs/sweeper.py`, `src/pialy/http/routes/businesses.py`

**Interfaces:**
- Consumes: layer 0 `upsert_connection`, `mark_verified`, `PeyConnector`, `apply_payment`, sweeper.
- Produces:
  - `PUT /api/businesses/{slug}/pey-connection {apiKey, webhookSecret}` (owner) → 200 `{status: "pending", webhookUrl}`; values trimmed, inner whitespace → 422; audit `pey_connection_changed`; sets `accepting_bookings=false`.
  - `POST /api/businesses/{slug}/pey-connection/verify {phone}` (owner) → 202: creates a `connection_check` intent (amount 1, reference `chk-<short id>`) and sends a CoDi push through this business's connector to the typed phone (phone handled exactly as in `hold_slot`: memory only, hash for the limit of 3 checks per business per hour).
  - `apply_payment` for a `connection_check` intent arriving by **webhook** on this connection's URL: `mark_verified`, `accepting_bookings=true`, audit `pey_connection_verified`, outbox `connection:{business_id}` event. No booking reaction, no flags.
  - Sweeper: a paid `connection_check` seen only by query sets status `webhook_missing`; an expired one leaves `pending`.
  - `GET` view status values: `not_connected | pending | checking | webhook_missing | verified`.
- [ ] **Step 1:** `test_key_never_returned_or_logged`; `test_key_trimmed_inner_whitespace_422` (Review Focus 1); `test_verify_charge_uses_this_business_connector_only`; `test_webhook_on_own_url_verifies_and_opens_bookings`; `test_paid_seen_only_by_sweeper_is_webhook_missing` (Review Focus 2); `test_changing_key_after_verification_closes_bookings_and_audits` (Review Focus 4); `test_check_payment_never_creates_booking_or_flag`; `test_bookings_refused_until_verified`.
- [ ] **Steps 2–4.** **Step 5:** Commit `feat(api): connect and verify a business's pey account`.

### Task 4: OpenAPI-generated web types (D)

**Files:**
- Create: `apps/api/src/pialy/cli.py` command `export-openapi`, `apps/web/src/api.gen.ts` (generated), `apps/web/package.json` script `api:types`
- Modify: `.github/workflows/ci.yml`, `apps/web/src/api.ts` (use generated types for request and response bodies; keep zod parsing at the boundary)

- [ ] **Step 1:** `uv run pialy export-openapi > apps/web/openapi.json`; `pnpm --filter web api:types` runs `openapi-typescript openapi.json -o src/api.gen.ts`.
- [ ] **Step 2:** CI step regenerates both and fails on `git diff --exit-code`.
- [ ] **Step 3:** `pnpm --filter web typecheck` green. Commit `build(web): generate api types from openapi`.

### Task 5: Web screens — sign-up, setup, pey connection (D)

**Files:**
- Create: `apps/web/src/pages/{Signup,Login,BusinessSetup,Settings,PeyConnection}.tsx` and their tests; route entries
- Modify: agenda header (business switcher when `me.businesses.length > 1`); public page shows "Este negocio aún no recibe reservas" when `acceptingBookings` is false

**Interfaces:**
- Consumes: Tasks 1–4 routes and generated types.
- Screen copy is Spanish. The pey screen shows the webhook URL with a copy button and three numbered steps: create a key in portal.pey.mx → paste the URL as the key's webhook → paste key and secret here; then "Verificar" asks for a phone and waits on the `connection:{business_id}` SSE topic, showing `webhook_missing` guidance.
- [ ] **Step 1:** component tests for each form's validation and states; **Step 2:** fail; **Step 3:** implement with the existing components and tokens; **Step 4:** `pnpm --filter web lint typecheck test build`; check at 375 px with Playwright MCP.
- [ ] **Step 5:** Commit `feat(web): add sign-up, business setup and pey connection screens`.

### Task 6: End-to-end registration test (B)

**Files:**
- Create: `tests/contract/test_registration_flow.py` (`py_only`)

- [ ] **Step 1:** sign up → create business → PUT connection (fake pey key) → verify (fake pey pays and signs the webhook to the connection URL) → public view `acceptingBookings: true` → hold a slot → pay → booking confirmed. A second business registered the same way cannot see the first's board.
- [ ] **Step 2:** passes in CI. Commit `test(contract): cover self-service registration end to end`.
