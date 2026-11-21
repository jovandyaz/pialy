# Pialy: Python backend, multi-business platform and booking agent — design

Date: 2026-11-20 · Event: Hackatón México 2026 · Postulación closes 2026-12-10 23:59 · Entrega 2026-12-12
Supersedes the backend parts of `2026-11-14-pialy-design.md`. Product, visual direction and the web app stay as approved there.

## 1. Intent

Pialy is the team's national entry. The target is a complete system: businesses register themselves, each has its own agenda, people and pey connection, and access depends on role. It is built in layers, the basic ones first (§13), so that every layer is deliverable on its own. Three changes:

1. Replace the TypeScript backend (`apps/server`, `packages/payments`, `packages/connector-pey`) with one Python backend built on the seven `agent-toolkit` packages.
2. Make it multi-business: self-registration, accounts, roles, and one pey connection per business.
3. Add a booking agent: the customer books by chat, and the agent can issue exactly one thing that moves money, the deposit request, under a mandate the server writes and checks.

Why: a scan of public hackathon repos (2026-11-20) found two split-the-bill projects and seven generic points of sale, and none that uses the CoDi request's expiry to hold an appointment. Pialy keeps that position and adds an agent whose money path is checked by code, not by the prompt. A single Python backend lets the agent, the payment domain and the guardrails share one process, one type system and one deploy. The first backend took one day to build; the team accepts the rewrite cost.

## 2. Goals, non-goals, anti-goals

Goals (by 2026-12-10):
- The existing customer and agenda screens work against the Python backend with the same JSON, SSE events and problem types; only the paths gain the business and the shared PIN becomes an account login.
- A person can sign up, register a business, connect its own pey account and take a paid booking without help from the team. Inviting staff with a narrower role comes after the agent (layer 3, §13).
- The service is fit to run for real businesses, not only for a demo: the production requirements of §12b hold from the first layer.
- Every payment edge case of the first design still holds: late payment, expiry, duplicate webhook, double payment, refund due, unmatched payment.
- A customer can book by chat on the business page; the deposit request goes out only after an explicit confirmation on a server-rendered control.
- The model is configurable as an ordered chain that can include open-weight models; a model joins the chain only after it passes the eval suite.
- Real $0.01 charges confirmed on at least two banks through the Python backend, to the team's own receiving account.

Non-goals: WhatsApp (later, depends on Meta business verification), one credential collecting for several businesses, a platform fee or any money passing through Pialy, billing or plans, an owner-side agent, custom roles or per-permission editing, single sign-on, refunds through an API (pey has none), native apps, porting `llm-router`'s cooldown tracker, migrating data from the current database.

Anti-goals (a failure even if it works):
- Any path where the model, the client or a chat message sets an amount, a payer, a receiving account or a `charge_ref`.
- A deposit request sent without the customer's confirmation, or to a phone the customer did not type into the form.
- A full phone number in the prompt, the checkpointer, the audit log, the logs or a third-party model's context.
- A slot booked twice, a webhook or a payment applied twice, a tool call that runs twice after a resume.
- Secrets in the repository (it is public) or in the client bundle.
- One business reading or changing another's bookings, payments, people or pey connection.
- A charge issued with one business's pey credentials for another business, or to an account that is not that business's own.
- A business that can take bookings before its own pey connection is verified.

## 3. Constraints

- pey facts verified in the first design (§3 there) still apply: production only, `expiration` ≥ 360, a QR can be paid more than once, no expired or refund event, webhook retries undocumented, one webhook endpoint per API key.
- Hackathon rules: collecting for third parties into one account is forbidden, while direct payment to each business's own account is allowed; credentials may not be shared outside the team (so whether a registered business may hand its own key to the platform is a question for the organizers, §16);
- Hackathon rules: the receiving account must belong to the credentials holder; no generic "type an amount and charge" screen; credentials are per project; pre-existing components must be declared in the delivery.
- `agent-toolkit` is pinned by git tag (`v0.1.0rc1`, or `v0.1.0` when released), one requirement per package with `#subdirectory=packages/<name>`. It needs Python ≥ 3.12 and its ports are synchronous.
- `GatedToolNode` is synchronous and must not be replaced by a stock `ToolNode` (it would swallow `BudgetExceededError`).
- One Railway replica at delivery, but nothing may depend on there being only one (§12b). The repository is public.

## 4. Approaches considered

| Decision | Options | Chosen | Why |
|---|---|---|---|
| Backend | Keep TS and add a Python agent service; rewrite in Python; LangGraph.js in the TS backend | **Rewrite in Python** | One stack for a small team; the toolkit (mandates, gate, audit, evals) exists only in Python; `payments-core` and `webhooks` were built for this |
| Repository | New repo for the backend; same pnpm monorepo | **Same monorepo, new `apps/api`** | One origin and one deploy (cookie is `SameSite=Strict`, SSE); the contract tests sit next to both backends; one history for the jury; pnpm ignores folders without `package.json` and uv ignores the rest |
| Database | Migrate the live schema in place; fresh database | **Fresh database, no data migration** | The live data is $0.01 demo bookings; the TS service keeps running untouched until cutover |
| Concurrency | Fully async; sync domain with async only for streams | **Sync (psycopg 3, threadpool) + async SSE** | Toolkit ports, the gated node and the Postgres checkpointer are sync; fewer moving parts |
| Model routing | LiteLLM router; port `llm-router` to Python; LangChain `init_chat_model` + `with_fallbacks` | **LangChain** | Already in the dependency tree through LangGraph; covers Anthropic, OpenAI, OpenRouter and OpenAI-compatible or Ollama endpoints; no new dependency |
| Tenancy | Database per business; schema per business; shared tables with `business_id` | **Shared tables with `business_id`** | One migration path and one pool; isolation enforced twice, in the repositories and by Postgres row-level security from the first migration (§5b), and proven by tests |
| pey per business | One platform credential; one credential per business | **One per business** | The only shape the rules allow; money goes straight to each business's account |
| Owner sign-in | Shared PIN (today); email and password; magic link; Google sign-in | **Email and password** | No third-party approval or mail provider needed; argon2id and server sessions are standard |
| Agent surface | WhatsApp; chat inside the booking page | **Chat in the page** | No third-party approval needed; the form keeps the phone out of the model |
| Who approves a charge | The owner; the customer | **The customer (payer consent)** | The owner already consented by configuring the deposit; the customer is the one being charged |

## 5. Architecture

```
Customer phone ──HTTP/SSE──┐                    ┌── pey webhook (signed)
Owner phone ────HTTP/SSE──┤                    │
                          ▼                    ▼
   Railway service: FastAPI (uvicorn) — serves the built React SPA
     ├─ http        routes of the first design + /api/chat/*
     ├─ booking     slots, hold, check-in, flags          (Pialy domain)
     ├─ payments    payments-core policies + Postgres repository + pey connector
     ├─ webhooks    agent_toolkit.webhooks verify + inbox
     ├─ identity    users, sessions, memberships, invitations
     ├─ tenancy     businesses, pey connections, TenantContext, credential encryption
     ├─ realtime    outbox → relay → Postgres NOTIFY → SSE hub
     ├─ jobs        sweeper (15 s, advisory lock)
     └─ agent       LangGraph graph, tools, GatedToolNode, mandates, budgets, audit, model chain
                          ▼
                  Railway Postgres (app tables, checkpoints, audit log)
```

Repository after cutover: `apps/api` (Python, uv project with its own `pyproject.toml` and `uv.lock`), `apps/web` (unchanged except the chat sheet), `tests/contract` (black-box suite), `docs/`. `apps/server` and `packages/*` are deleted in the cutover PR; git history keeps them.

`apps/api/src/pialy/`:

| Module | Holds | Toolkit package |
|---|---|---|
| `config` | Pydantic settings; invalid env exits the process | — |
| `identity` | users, password hashing, sessions, memberships and role checks, invitations | — |
| `tenancy` | businesses, `TenantContext`, pey connections, credential encryption and key versions | — |
| `observability` | structured logging with redaction, request ids, error reporting | — |
| `db` | psycopg pool, migrations (Alembic, raw SQL revisions), advisory locks | — |
| `booking` | `domain` (pure: slots, booking states, phone hashing), `application` (hold, QR attempt, check-in, resolve flag, on-payment reaction) | — |
| `payments` | `PostgresIntentRepository`, `PostgresUnitOfWork`, `PeyConnector(RailConnector)`, `apply_payment` | `payments-core` |
| `webhooks` | route, `PostgresInbox` | `webhooks` |
| `realtime` | outbox writer, relay (`FOR UPDATE SKIP LOCKED`), `LISTEN/NOTIFY` fan-out, SSE hub | — |
| `jobs` | sweeper | `payments-core` (`reconcile_attempt`) |
| `agent` | graph, tool functions, `ToolSpec`s, session mandate, ledger, replay store, model chain, prompts | `mandates`, `policy-gate`, `budgets`, `audit-log` |
| `http` | FastAPI routers, session and role dependencies, rate limits, security headers, RFC 9457 problems, static SPA | — |
| `evals/` (top level of `apps/api`) | agent eval tasks | `evals` |

Rules carried over: the domain is pure (no FastAPI, psycopg, httpx or clock calls; time comes in as an argument); modules talk through application functions; `import-linter` enforces the boundaries; `mypy --strict`, ruff, no `Any` in module interfaces; money is integer minor units plus currency.

## 5b. Businesses, accounts and roles

**Tenant.** A business. Every row that belongs to one carries `business_id`; every repository function takes a `TenantContext(business_id, actor)` and filters by it; no query reads tenant data without one. Public pages live under `/:slug` as today (`/estudio-demo` stays).

**Second layer of isolation: row-level security.** Every tenant table has a policy `business_id = current_setting('app.business_id')::uuid`, with `FORCE ROW LEVEL SECURITY`. The service connects as a role that is neither superuser nor table owner and has no `BYPASSRLS`; migrations run as a separate owner role. `TenantContext` opens each transaction with `SET LOCAL app.business_id`; a query outside a tenant transaction sees no rows. The service role never gets `BYPASSRLS`. Anything that has no business yet goes through a short list of `SECURITY DEFINER` functions owned by the migration role, each returning the minimum:

| Function | Used by | Returns |
|---|---|---|
| `business_id_by_slug` | public routes | the id |
| `connection_for_webhook(connection_id)` | webhook | business id, encrypted secret |
| `chat_session_business(token_hash)` | chat routes | business id |
| `invitation_by_token(token_hash)` | accept invitation | business id, email, role, expiry |
| `businesses_with_due_work()` | sweeper | business ids |
| `create_business(...)` | registration | the new id, plus the owner membership |
| `claim_outbox(n)`, `purge_expired()` | relay, retention job | outbox rows (with their business id) / counts |

After the lookup the request or job continues inside that business's context like any other. Not tenant tables, each with its own rule:
- `users`, `sessions`, `rate_limits`: no policy; reached only by `identity`.
- `memberships`: policy on `user_id = current_setting('app.user_id')` or the business in context, so "my businesses" works at login without a business.
- `audit_events`: one global hash chain, as the toolkit's `PostgresAuditStore` defines it (not changed). The business id travels inside the event; the service role may insert and read, never update or delete.
- LangGraph checkpoint tables: created and used by `PostgresSaver` on its own connection, no policy. They are reachable only by `thread_id` = chat session id, which is resolved through `chat_sessions` (a tenant table), and they hold no phone (§8).

The two-business suite also covers these: each function is called with the other business's tokens and ids. A test suite creates two businesses and proves that every route answers 404 for the other's tokens and ids.

**Accounts and memberships.** A user has an email and a password (argon2id); a membership links a user to a business with a role. One user may belong to several businesses.

| Role | Can |
|---|---|
| `owner` | Everything in the business: settings (service, duration, deposit, hours), the pey connection, inviting and removing people, plus all of `staff` |
| `staff` | The agenda, check-in by pass, resolving flags |

The `memberships` table and the role check exist from layer 1, where the only role in use is `owner` (the person who registered the business). `staff`, the people screen and invitations arrive in layer 3 without a schema change.

Customers have no account, as today. There is no platform administrator in the product; support actions are run from the server's command line.

**Registration.** Sign up (email, password) → create a business (name, slug, service, duration, deposit, hours) → connect pey → the public page goes live. Until the connection is verified the public page says the business is not taking bookings yet.

**pey connection.** One per business: the business's own API key and webhook secret, stored encrypted (AES-256-GCM, a fresh nonce per value, the connection id and business id as associated data, a key version prefix so `CREDENTIALS_ENC_KEY` can be rotated by re-encrypting; never logged or returned by the API), and a status. pey's documented API has no call that names the account behind a key, and no test webhook, so the design relies on neither: pey itself binds a key to the account its holder registered, and Pialy never sends a receiving account. The mandate's `receiving_accounts` holds the connection id, meaning "whatever account pey has behind this business's key". The webhook URL is per connection (`/api/webhooks/pey/:connection_id`); the owner pastes it into their pey portal (pey allows one per key) and each is verified with its own secret. Verification = one real $0.01 push to the owner's own phone, paid by the owner, whose signed webhook arrives on that URL: it proves the key, the secret and the webhook registration together. Only then is the business bookable. `PeyConnector` is built per request from the business's connection; there is no global credential.

**Deposit.** Set per business by its owner, in integer minor units, bounded by `DEPOSIT_MAX_MINOR` from the environment (1 during the hackathon).

**Sessions.** Server-side sessions in Postgres, httpOnly signed `SameSite=Strict` cookie, 12 h, logout deletes the row. The shared-PIN session of the first design is removed; the login lockout becomes per account.

**Agent.** Unchanged in shape: the chat session and its mandate already name one business as principal and that business's account as the only receiving account.

## 6. Data model

Same tables and invariants as today (`business`, `resources`, `bookings`, `payment_intents`, `payment_attempts`, `payment_events`, `webhook_inbox`, `idempotency_keys`, `outbox`, `flags`, the `btree_gist` exclusion on `(resource_id, during)`, one holding booking per phone hash, unique `provider_tx_id`), with these changes:

- `payment_intents`: add `principal_id` (the business id), `idempotency_key` (unique), `paid_total_minor`, `late`; statuses become the ones `payments-core` defines. `applied_event_ids` is read from `payment_events`.
- `payment_attempts`: `rail` (`codi_push` / `codi_qr`) replaces `mode`; `provider_ref` is the pey `transactionId` for push and the QR id for QR; statuses become the ones `payments-core` defines.

New tables for the platform:

| Table | Purpose |
|---|---|
| `users` | id, email (unique, case-insensitive), `password_hash`, `created_at` |
| `memberships` | `user_id`, `business_id`, `role` (`owner` / `staff`); unique per pair |
| `sessions` | `token_hash` PK, `user_id`, `expires_at` |
| `rate_limits` | key, window start, count: limits and login lockout shared by every replica |
| `invitations` | `business_id`, email, role, `token_hash`, `expires_at`, `accepted_at` |
| `pey_connections` | id, `business_id` (unique), `api_key_enc`, `webhook_secret_enc`, `key_version`, `status`, `verified_at` |

`business` gains `slug` (unique). `payment_intents`, `payment_attempts`, `payment_events`, `webhook_inbox`, `outbox`, `flags` and `idempotency_keys` gain `business_id`; the booking number sequence and its 7-digit limit become per business.

New tables for the agent:

| Table | Purpose |
|---|---|
| `chat_sessions` | id, `token_hash`, `business_id`, `mandate` (signed JSON), `booking_id?`, `turns`, `cost_usd_micros`, `expires_at` |
| `mandate_consumption` | per-mandate ledger rows (`mandate_id`, `ConsumptionEntry` fields) |
| `agent_tool_replies` | `idempotency_key` PK, `fingerprint`, `reply`: the replay store for `GatedToolNode` |
| `audit_events` | hash-chained log (`PostgresAuditStore` schema); besides agent decisions it records platform actions that matter for trust: login failures and lockouts, pey connection created, changed or verified, deposit changed, member added or removed. Ids and hashes only |
| LangGraph checkpoint tables | created by `PostgresSaver.setup()` |

The full phone number exists only in memory inside the one request that triggers the pey call, as today: the booking form's POST, or the approval POST of the chat (§8).

## 7. Payment flows

The seven flows of the first design (§7 there) are kept one to one. What changes is who decides:

- **Apply a payment** (webhook or sweeper): inside one `PostgresUnitOfWork` that locks the intent, read it by `provider_ref`, call `apply_provider_payment`, save the intent, insert the `payment_events` row, turn each `RefundFlag` into a `flags` row (orphans deduplicated by `provider_event_id`), run the booking reaction (`holding → confirmed`, late rules) and write the outbox rows. One transaction.
- **Webhook**: raw body → `webhooks.verify` (401 on `InvalidSignatureError`) → `process_once(inbox, webhook, handler)` in the same transaction as the handler's effects → 200. No external calls inside.
- **Sweeper**: for holds past `hold_expires_at`, `PeyConnector.query(provider_ref)` → `reconcile_attempt(intent, attempt_id, status, now)`; paid applies the payment, otherwise the attempt and the booking expire. The late-payment recheck window stays.
- **Where `payments-core` and the current server differ**, the web-visible behaviour of the current server is kept by the application layer around the pure policies:
  - *Amount mismatch.* A `partially_paid` outcome does not confirm the booking and raises the existing `amount_mismatch` flag; an `excess` refund flag confirms and raises `refund_due`.
  - *Several payments on one QR.* `ProviderStatus` carries one payment, so for a QR attempt the sweeper passes every transaction pey lists through `apply_provider_payment` (the policy turns repeats into `duplicate` refund flags) and only then calls `reconcile_attempt` for expiry.
  - *Matching a payment to an attempt.* By pey `transactionId` or QR id; if none matches, by the `attemptId` sent in `metadata` and echoed in the webhook, and the attempt's `provider_ref` is set before the policy runs. A push that timed out therefore still matches its late webhook.
  - *Push that fails or times out.* The hold ends at once and the request answers 502, as today. The API's attempt fields (`mode`, `awaiting|succeeded|expired|failed`) are a read-model mapping over `rail` and the `payments-core` statuses.
  - *Late.* `intent.late` is the policy's (paid after the attempt expired). The booking's `late`, the one the web shows, is decided by the booking reaction as today: the booking had expired when the payment was applied.
- **Request a charge**: phase 1 commits the hold, the intent and the attempt with its `provider_ref` plan; then the pey call; phase 2 stores the provider ids. A POST is retried only when `may_retry_request` says the provider did not process it; an ambiguous attempt is reconciled, never resent.

## 8. The booking agent

**Surface.** A chat sheet on the business page. The customer never types a phone into the chat and the model never sees one: the phone is asked for on the confirmation card (below).

**Session mandate.** When a chat session is created, the server writes and signs (`HmacSha256Signer`) an `OpenMandate`: principal = the business, agent = `pialy-booking-agent`, purpose `booking_deposit`, `amount_range` min = max = the business deposit, budget = one deposit, `receiving_accounts` = the business's pey connection id, `allowed_payers` = empty, `allowed_rails` = `codi_push`, expiry = the session's. The model never sees or edits it. `allowed_payers` is empty on purpose: `mandates.check` then returns the approval reason `payer_not_allowed` for every charge, so `decide` can never return `Allow` for `booking_hold`. A deterministic test pins this, because a mandate that listed the payer would let the request go out with no card.

**Graph.** `MessagesState`; nodes `model` → `tools` (`GatedToolNode`) → `model`; `PostgresSaver` checkpointer, `thread_id` = chat session id.

| Tool | Effect | Financial | Gate outcome |
|---|---|---|---|
| `business_info()` | read | no | allow |
| `slots_search(date)` | read | no | allow |
| `booking_status()` | read (this session's booking) | no | allow |
| `booking_hold(slot_start, customer_name?)` | holds the slot and sends the deposit request to the session phone | yes | always `RequireApproval` |

`booking_hold` is the only tool that changes state. Its `to_closed_mandate(args, ctx)` builds a `new_charge` with amount = the deposit, payer = the chat session id, receiving account and rail from the business, and `charge_ref` derived from `BuildContext(thread_id, message_id, call_id)`. Nothing in it comes from the arguments except the slot. `charge_ref` is the intent's `idempotency_key`; the pey `numRef` stays the booking number.

**Approval = payer consent.** The interrupt's `ApprovalRequest` reaches the web app as a confirmation card rendered from server data (business, service, slot, amount) with the phone field of the existing form. The button posts the phone and an `ApprovalDecision` keyed by call id to an endpoint authenticated by the chat session cookie; that resumes the graph. The phone travels to the tool through a request-scoped holder, never through graph state, the run config, the checkpointer or the audit log; the tool hashes it for the per-phone limits and the one-holding-per-phone index exactly as the form flow does. Free text such as "sí" never approves anything.

**One hold per session.** The budget of one deposit makes the gate deny a second `booking_hold` in the same session (`mandate:budget_exceeded` with `on_mandate_violation = "deny"`), whether the first one was paid, expired or failed; reserves are not released. To try again the customer starts a new chat session or uses the form. The per-phone and per-IP limits still apply across sessions.

**After the hold.** The tool returns the booking token; the web app moves to the existing wait page, where the QR fallback, the countdown and the pass already work. The agent has no QR tool.

**Duties carried from the toolkit build** (all required): a Postgres advisory lock per mandate around one gated-node execution, from `context(state)` until the reserves are recorded; the ledger is per mandate and a ledger `ValueError` becomes `Deny("ledger_inconsistent")`; `replay=` backed by `agent_tool_replies`, storing a reply only for calls that executed; `on_decision` appends to the audit log before the tool runs, and a failing append blocks the call; `charge_ref_reused` on a re-run means "already issued, read its status".

**Untrusted input.** Every customer message is untrusted (`SessionProfile.untrusted_input = True`). The session can read only its own business's public data and its own booking, so an injected instruction has nothing sensitive to read and one gated action to reach.

**Budgets.** Per turn (one graph invoke): `max_iterations`, `max_tool_calls`, `max_consecutive_failures` and `max_cost_usd` through a fresh `BudgetCallbackHandler`, priced at the most expensive model of the chain because the handler takes one `Pricing`. Per session: after each invoke the server adds the turn's cost to `chat_sessions.cost_usd_micros` and increments `turns`; a session over `AGENT_MAX_COST_USD` or `AGENT_MAX_TURNS` gets a fixed closing reply without calling a model. Plus the existing per-IP rate limits on the HTTP layer.

## 9. Model chain

- `AGENT_MODEL_CHAIN` is an ordered, comma-separated list of `provider:model` ids, for example a Claude model first and an open-weight model through OpenRouter second. Each entry is built with `init_chat_model`, tools are bound, and the chain is `first.with_fallbacks(rest)`.
- Providers: `anthropic`, `openai`, `openrouter` (`langchain-openrouter`, needs `langchain` ≥ 1), `ollama`, and any OpenAI-compatible endpoint through `base_url`. Keys are read from the environment per provider; a chain entry without its key fails at boot.
- Tool-calling turns are not streamed, so a fallback can only happen before any output exists.
- Prices for `budgets.Pricing` come from `llm-router`'s published `model-index.json` (vendored at a pinned version), keyed by the same `provider:model` id.
- Admission rule: a model may be listed only if the eval suite reports pass^k = 1.0 on the safety tasks and meets the threshold on the booking tasks (§11). The report per model is committed under `docs/evals/`.
- The prompt-injection guard and the cooldown tracker of `llm-router` are not ported; the gate, not a text filter, is the control.

## 10. Interfaces

Existing, same bodies, events, problem types and idempotency semantics, now scoped by business: `GET /api/slots`, `POST /api/bookings`, `GET /api/bookings/:token`, `POST /api/bookings/:token/qr`, `GET /api/bookings/:token/events`, `GET /api/board`, `GET /api/board/events`, `POST /api/bookings/:token/check-in`, `POST /api/flags/:id/resolve`, `GET /api/verify/:token`, `POST /api/webhooks/pey/:connection_id`, `GET /healthz`, `GET /readyz`, static SPA with the same fallback and precompressed assets. `Idempotency-Key` semantics, problem `type` URNs, rate limits are part of the contract; the shared-PIN session is replaced by account sessions.

New, platform (all under the session cookie; business routes check the membership role):

| Route | Purpose |
|---|---|
| `POST /api/auth/signup`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me` | Account and session |
| `POST /api/businesses`, `GET|PATCH /api/businesses/:slug` | Create and configure a business (owner) |
| `GET|PUT /api/businesses/:slug/pey-connection` | Connect and verify pey (owner); the key is write-only |
| `GET|POST|DELETE /api/businesses/:slug/members`, `POST /api/invitations/:token/accept` | People and roles (owner) |

The public and agenda routes of the first design gain the business in the path (`/api/b/:slug/...`); the web app's API module is updated in the same change, and the contract suite is written against the new paths with a compatibility run against the TS server for the single seeded business.

New, agent:

| Route | Purpose |
|---|---|
| `POST /api/b/:slug/chat/sessions` | Creates a session and its mandate; sets an httpOnly, signed, `SameSite=Strict` cookie holding a ≥128-bit token |
| `POST /api/b/:slug/chat/sessions/current/messages` | One customer turn; returns the assistant messages and, if any, the pending approval card |
| `POST /api/b/:slug/chat/sessions/current/approvals` | Approves (with the phone) or rejects by call id; resumes the graph |

Environment (new): `AGENT_MODEL_CHAIN`, provider API keys, `MANDATE_HMAC_KEY` (≥ 32 bytes), `AUDIT_HMAC_KEY` (≥ 32 bytes, keys `audit_log.hash_payload`), `CREDENTIALS_ENC_KEY` (32 bytes), `DEPOSIT_MAX_MINOR`, `AGENT_MAX_COST_USD`, `AGENT_MAX_TURNS`; optional `LANGFUSE_*` for traces. `PEY_API_KEY`, `PEY_WEBHOOK_SECRET` and `BUSINESS_PIN` disappear: credentials live per business.

## 11. Testing

- **Contract suite** (`tests/contract`, pytest + httpx, black box): takes `BASE_URL`, a database it may reset and a fake pey server (a small local HTTP stub for `/codi/pn`, `/codi/qr`, `/transaction/*` that also signs webhooks). Both backends accept `PEY_BASE_URL`, so the same suite runs against the TS server first (to prove the suite) and then against the Python server. A small per-target adapter holds what differs: the path prefix (`/api/...` vs `/api/b/:slug/...`), the webhook path, and how the agenda logs in (`POST /api/session` with the PIN vs `POST /api/auth/login`). The cases about the login itself (PIN lockout on TS, account lockout on Python) are target-specific and listed as such. It covers every case of the current server tests that needs no control of time: holds and concurrency on one slot, idempotency keys, QR attempts and their cap, webhook valid / tampered / duplicate, double payments, board, check-in, flags, SSE events, static serving. The TS server is not modified for it.
- **Time-dependent cases** (hold expiry, late payment, sweeper expiry and reconcile, the 30-minute late watch, rate-limit windows, PIN lockout): ported one to one from the TS tests to in-process Python tests with an injected clock; a table in the plan maps each TS test name to its Python test.
- **Tenancy**: two businesses, each with its own fake pey connection; every route and every repository function is exercised with the other business's ids and must answer 404 or return nothing; a webhook signed with one connection's secret is rejected on the other's URL; `staff` is refused on every owner route.
- **Unit**: booking domain; repository and unit-of-work against real Postgres; `PeyConnector` against fixtures captured from real responses and webhooks.
- **Agent, deterministic**: the graph with a scripted fake model: hold needs approval; approval for other arguments is rejected; resume does not re-run the tool; a second hold in one session is denied; no mandate the server can write makes `booking_hold` return `Allow`; budget exhaustion ends the turn.
- **Agent, evals** (`agent_toolkit.evals`, k = 5 per task and per model): booking tasks (finds the slot asked for, handles a taken slot, answers business questions) and safety tasks (asked to change the amount, the payer or the account; asked to charge without confirming; instructions hidden in the customer name). Safety tasks are graded on state: no charge exists that the rules forbid.
- **Manual**: real $0.01 push and QR on at least two banks through the Python backend; results in the README bank table.

## 12. Deploy and cutover

1. New Railway service and new Postgres for `apps/api`, built from a multi-stage Dockerfile (Node builds `apps/web`, Python serves it, non-root user, pinned base images). Migrations run as Railway's pre-deploy command, so a failed migration stops the deploy before traffic moves. A second pey API key with its own webhook endpoint and secret points at it; the first key keeps serving the TS service.
2. The Python service runs in parallel under its own URL until the contract suite and the manual bank tests pass.
3. Cutover: the public domain moves to the Python service, the receiving account is the team's own once pey marks it active, the first key is retired, and the cutover PR deletes the TS backend and updates the README (architecture, run instructions, "Pre-existing components": `agent-toolkit`, built 2026-11-15 to 11-20, inside the hackathon period).
4. Fallback: until step 3 the TS service is the live one; if the Python backend is not ready by 2026-12-05, the TS backend is delivered and the agent is cut.

## 12b. Production requirements

These apply from layer 0. Each one is a requirement with a test or a check, not an aspiration.

**Security**
- Passwords: argon2id (`argon2-cffi` defaults), minimum 12 characters, no composition rules. Login answers the same way for a known and an unknown email. Lockout per account and per IP, counted in `rate_limits`.
- No mail provider before delivery, with three stated consequences: sign-up says when an email is already registered (rate-limited per IP); an invitation is a link the owner copies and sends themselves, shown once; a forgotten password is reset by an operator command in the runbook. Mail-based verification and reset are the first thing to add before real businesses join.
- Sessions: ≥128-bit random token, only its SHA-256 stored; rotated at login; httpOnly, `Secure`, `SameSite=Strict`. Every state-changing route also checks `Origin` against the service's own origin.
- Authorization in one place: a FastAPI dependency resolves session → membership → `TenantContext` and the required role; a route without it fails a test that walks the route table.
- Headers: a strict Content-Security-Policy (no inline script), `X-Content-Type-Options`, `Referrer-Policy`, HSTS, `frame-ancestors 'none'`.
- Secrets only in Railway variables; `gitleaks` in CI because the repository is public; invitation and session tokens are single-purpose, hashed and expiring.
- Input: every body and query validated by strict Pydantic models with size limits; SQL only through parameters.

**Personal data**
- Inventory: owner email; customer name; phone as a keyed hash plus the last digits shown on the pass, as today. Nothing else.
- Logs are structured JSON with a redaction filter (phone-like digit runs, emails, tokens, keys); a test feeds each kind through the logger and asserts it does not come out.
- Retention jobs: expired sessions, chat sessions and their checkpoints, idempotency keys and delivered outbox rows are purged on a schedule; payments, flags and the audit log are kept.

**Reliability**
- Correct with more than one replica even though one is deployed: the sweeper and the outbox relay take advisory locks or `SKIP LOCKED`, SSE fan-out goes through `LISTEN/NOTIFY`, rate limits and sessions live in Postgres, nothing durable is kept in process memory.
- Time limits everywhere: pey calls (connect 3 s, total 10 s), model calls, `statement_timeout` and `lock_timeout` on the pool; the threadpool is never larger than the connection pool.
- No transaction stays open across a pey or model call. The agent's per-mandate lock (§8) is a session-level advisory lock on a connection from a small dedicated pool, held across the gated node's execution including the pey call; the work under it runs in short transactions on the normal pool, each in the business's context. Waiting for that lock is bounded by `lock_timeout` and answers "busy, try again".
- Graceful shutdown: on SIGTERM stop accepting, close SSE streams with a retry hint, finish in-flight requests, release locks.
- `GET /healthz` (process alive) and `GET /readyz` (database reachable and migrations at head); Railway's healthcheck points at `/readyz`.
- Migrations are forward-only and compatible with the previous release (add first, remove one release later); each is tested by upgrading an empty database and one with fixture data.
- Backups: Railway point-in-time recovery (docs.railway.com/volumes/point-in-time-recovery) enabled on the production database, or scheduled volume backups if the plan does not include it, and one restore rehearsed and noted in the runbook before delivery.

**Observability**
- Every log line carries a request id, the business id and the route; the request id is returned in a header and in every problem body.
- Named events for the things someone must act on: webhook signature rejected, unmatched payment, flag raised, sweeper behind schedule, pey call failed, mandate denial, budget exceeded, audit append failed.
- Errors go to Sentry when `SENTRY_DSN` is set, with the same redaction; agent traces go to Langfuse when configured, with message content off by default.
- The agenda already shows flags to the business; a short runbook (`docs/runbook.md`) covers the operator's side: rotate the encryption key, disconnect a business, replay a webhook from the inbox, restore a backup, cut the agent off with one variable (`AGENT_ENABLED=false`).

**Delivery pipeline**
- GitHub Actions on every pull request: ruff, `mypy --strict`, `import-linter`, pytest against a Postgres service, the contract suite, the web app's lint, types, tests and build, the Docker build, `uv lock --check`, `pip-audit`, `pnpm audit`, `gitleaks`.
- `main` is protected: pull requests only, checks required. Railway deploys from `main`.
- The API's OpenAPI document is generated in CI and the web app's types are generated from it; a drift fails the build.
- Three environments: local (docker compose with Postgres and the fake pey), the parallel Railway service as staging, production.

**Performance**
- Every tenant table's indexes lead with `business_id`; list endpoints are paginated and bounded; no query per row in the agenda.
- SSE: a cap on open streams per business and per IP, heartbeat every 20 s (as the TS server).

## 13. Order of work and team split

Layers, each deliverable on its own; a later layer never blocks delivery of the earlier ones.

| Layer | Contents | Target |
|---|---|---|
| 0. Foundation | Python backend with the payment and booking flows of the first design, tenant-scoped from the first migration (`business_id`, row-level security, `TenantContext`, per-business pey connection), one seeded business with one seeded owner account, and login, logout and `me` (the PIN is never ported); CI, logging and health checks of §12b | Nov 26 |
| 1. Registration | Sign-up, business registration and settings, connect pey; every business has exactly one person, its owner; web screens for sign-up, login and business setup | Nov 30 |
| 2. Agent | Booking chat with the gated deposit request, model chain, evals | Dec 5 |
| 3. Roles and invitations | `staff` role, people screen, invitations | Dec 8 |
| 4. If time allows | Several resources per business, balance collected at check-in, day report, WhatsApp | Dec 9 |

| When | Work | Owner |
|---|---|---|
| Nov 21–22 | Contract suite + fake pey, proven against the TS server; CI pipeline | B |
| Nov 21–26 | `payments`, `webhooks`, sweeper, per-business `PeyConnector` (money path, TDD, a fresh reviewer per task) | A |
| Nov 21–26 | `tenancy` with row-level security, `booking`, `http`, `realtime`, `observability`, static serving, the two-business test suite | B |
| Nov 21–30 | Agent graph with a fake model, tools against in-memory ports, model chain, eval tasks (in parallel with layers 0 and 1) | C |
| Nov 24–27 | Dockerfile, Railway service, roles and database users, parallel deploy, backups | D |
| Nov 27–30 | `identity`, registration, pey connection (A, B); web screens for them (D) | A, B, D |
| Dec 1–5 | Agent wired to the real backend, chat sheet and approval card, evals per model; bank tests; cutover once the team's receiving account is active | A, C, D |
| Dec 6–8 | `staff`, people screen, invitations | B, D |
| Dec 9 | Layer 4 or slack; restore rehearsal, runbook | all |
| Dec 10 | Postulación | Representative |
| Dec 11–12 | Video, README, delivery | all |

Cut order if time runs out: layer 4, then roles and invitations, then the agent. Layers 0 and 1 are the minimum for "a complete system"; the production requirements of §12b are not cut. Each layer gets its own implementation plan (`superpowers:writing-plans`): foundation, registration, agent, roles and invitations, deploy and cutover.

## 14. Decided by the user

Pialy is the single national entry; a complete multi-business system with registration and roles, basic layers first; rewrite the backend in Python with `agent-toolkit`; reuse the web app; model choice through a router that admits open-weight models; chat in the page first, WhatsApp later; contract taken from the current server.

## 15. Calls made by the designer (correctable)

- Shared tables with `business_id`, enforced in repositories and by row-level security from the first migration; the service's database role cannot bypass it.
- Two fixed roles, `owner` and `staff`; email and password sign-in; no platform administrator in the product.
- One pey connection per business, encrypted at rest; a business is not bookable until it is verified.
- Layer 1 is owner-only registration; the agent comes next and roles and invitations after it (user's order). The agent is built in parallel from day one.
- Production requirements (§12b) are part of layer 0 and are never cut: replica-safe design on one replica, forward-only migrations in the pre-deploy step, redacted structured logs, point-in-time recovery, CI with security scans, generated API types.
- Under row-level security, the cases with no business yet go through a fixed list of `SECURITY DEFINER` functions; the audit chain stays global and the checkpoint tables stay outside the policies (§5b).
- No mail provider before delivery: copied invitation links, operator password reset, sign-up reveals a taken email.
- A business is verified by a real $0.01 charge the owner pays; Pialy never names a receiving account, pey binds it to the key.
- Layer 0 already has login for a seeded owner; the PIN is not ported.
- Sentry and Langfuse are optional and off unless configured; no metrics stack beyond named log events.
- Same monorepo with `apps/api`, TS backend deleted at cutover. Tooling: pnpm workspaces for JS plus uv for `apps/api`; no Nx or Turborepo (three apps, one fewer after cutover).
- Fresh database, no data migration.
- Sync domain on psycopg 3; Alembic with raw SQL revisions.
- LangChain `init_chat_model` + `with_fallbacks` as the router; prices from `llm-router`'s model index; no cooldown tracker.
- The agent's first audience is the customer; the only gated action is `booking_hold`; approval is the customer's confirmation card.
- One hold per chat session (budget of one deposit, no release); a retry needs a new session or the form.
- The phone is typed on the confirmation card and lives only in that request.
- Where `payments-core` differs from the current server, the application layer keeps the current web-visible behaviour (§7); the gaps (no `failed` attempt status, one payment per `ProviderStatus`, no lookup by metadata) are filed as `agent-toolkit` issues, not fixed before the hackathon.
- Time-dependent cases are tested in process, not through the black-box suite; the TS server is left untouched.
- Python 3.13; a second pey key for the parallel run.
- Dec 5 as the date to fall back to the TS backend. The fallback delivers the single-business TS system: registration and the agent are both lost, so it is a last resort.

## 16. Open

- Legal questions for the organizers, not yet sent: whether a registered business that is not on the team may give the platform its own pey key, and, if not, whether the delivery may show several businesses using team members' own accounts; whether one receiving account may be linked to two API keys; the wording conflict on charging to third-party accounts; fees after the hackathon.
- Whether pey's announced test environment is usable; until confirmed, tests run in production at $0.01.
- Which teammates take roles A to D.
- Whether pey exposes the account behind a key, and whether an owner can pay a $0.01 request to their own account from their own phone. The team now has three active receiving accounts held by team members, so verification and the multi-business demo can use one member paying another's business.
- A privacy notice for the public page: wording and whether the delivery needs one, to be checked against the applicable rules before launch to real businesses.

## 17. Left to the builder

Exact SSE hub implementation, SQL of each migration and policy, pool and threadpool sizes, the CSP string, retention periods, retry and backoff constants, prompt wording, the shape of chat message JSON, the chat sheet's component breakdown within the existing visual language, eval thresholds for booking tasks.
