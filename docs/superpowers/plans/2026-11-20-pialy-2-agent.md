# Pialy layer 2: booking agent — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A customer books by chat on a business's page; the agent can issue exactly one money-moving action, the deposit request, only after the customer confirms on a server-rendered card that also collects the phone.

**Architecture:** A LangGraph `MessagesState` graph (`model` → `GatedToolNode` → `model`) checkpointed with `PostgresSaver`, one thread per chat session. The session's `OpenMandate` is written and signed by the server and never seen by the model; `allowed_payers` is empty so `booking_hold` always needs approval. Tools call the layer 0 application functions. Model routing through LangChain `init_chat_model` + `with_fallbacks`.

**Tech Stack:** as layer 0, plus `langgraph`, `langgraph-checkpoint-postgres`, `langchain` ≥ 1, `langchain-anthropic`, `langchain-openai`, `langchain-openrouter`, `langchain-ollama` (each optional by provider), agent-toolkit `mandates`, `policy-gate[langgraph]`, `budgets[langchain]`, `audit-log[postgres]`, `evals`.

**Spec:** `docs/superpowers/specs/2026-11-20-pialy-python-backend-agent-design.md` §8, §9, §10 (agent routes), §11 (agent tests and evals), §13 layer 2. Duties: spec §8 "Duties carried from the toolkit build" and the module docstring of `agent_toolkit/policy_gate/adapters/langgraph.py` (read it in full before Task 4).

## Global Constraints

- Everything in layer 0's Global Constraints.
- Before using LangGraph, LangChain or a provider package, read its current docs (Context7) and pin exact versions in `uv.lock`.
- Anti-goals of spec §2 bind every task: the model, the client or a chat message never sets an amount, payer, receiving account or `charge_ref`; no deposit request without approval on the card; no full phone in the prompt, graph state, run config, checkpointer, audit log, logs or a model's context.
- `GatedToolNode` only; never a stock `ToolNode`.
- Session mandate: principal = business id, agent `pialy-booking-agent`, purpose `booking_deposit`, `amount_range` min = max = deposit, budget = one deposit, `receiving_accounts` = (the business's pey connection id,), `allowed_payers` = (), `allowed_rails` = (`codi_push`,), expiry = the chat session's (2 h). Signed with `HmacSha256Signer(MANDATE_HMAC_KEY)`.
- `SessionProfile(agent_id="pialy-booking-agent", principal_id=<business id>, untrusted_input=True, …)`.
- Env: `AGENT_ENABLED` (default false), `AGENT_MODEL_CHAIN`, provider keys, `MANDATE_HMAC_KEY` (≥ 32 bytes), `AGENT_MAX_COST_USD` (default 0.50 per session), `AGENT_MAX_TURNS` (default 30), per turn `max_iterations=6`, `max_tool_calls=4`, `max_consecutive_failures=2`, `max_cost_usd=0.05`. Customer message ≤ 1000 characters; 20 messages per IP per 10 min; 5 chat sessions per IP per hour.
- Money-path tasks (**[money]**): TDD, one fresh reviewer per task.

## Review Focus

1. The customer approves, the browser retries the approval POST (double click or flaky network) → one hold and one push, the second POST answers with the same result (Task 6).
2. The approval POST arrives after the chat session or the hold slot expired → a clear "the slot is no longer available" reply, no push (Task 6).
3. Every model in the chain fails or times out → a fixed Spanish fallback reply with a link to the booking form, the turn's cost still recorded (Task 5).
4. The customer writes the phone number in a chat message → it is replaced with `[número]` before it reaches the model, the checkpointer or the logs (Task 5).
5. Two tabs of one chat session send messages at once → turns are serialized per session; the second waits or gets "busy, try again", never two graph runs at once (Task 5).

## Roles and order

Role C owns Tasks 1–5 and 7 from Nov 21 against in-memory ports and a scripted fake model (Tasks 1–5 depend only on layer 0 interfaces, not on their implementations); Task 6 wires the real backend once layer 0 lands; A reviews every **[money]** task. D owns Task 8. Order: 1, 2 in parallel → 3 → 4 → 5 → 6 → 7; 8 from Task 6's route shapes.

## File map

```
apps/api/src/pialy/agent/
  chain.py        build_chain, pricing
  mandate.py      issue_session_mandate, verify_session_mandate
  ports.py        ledger, replay store, mandate lock, audit hook (Postgres + in-memory)
  tools.py        tool functions, args models, ToolSpecs, to_closed_mandate
  phone.py        request-scoped phone holder, redact_phone_in_text
  graph.py        build_graph, run_turn, resume_with_decision
  sessions.py     chat session store, session budgets
  prompts.py      system prompt
apps/api/src/pialy/http/routes/chat.py
apps/api/migrations/versions/0004_agent.py
apps/api/evals/{tasks.py,run.py}
apps/api/tests/agent/…
apps/web/src/chat/{ChatSheet,ApprovalCard}.tsx
docs/evals/<model-id>.json
```

---

### Task 1: Model chain and pricing (C)

**Files:** Create `agent/chain.py`, `vendor/model-index.json` (from `llm-router`, pinned commit recorded in a header file `vendor/README.md`), `tests/agent/test_chain.py`

**Interfaces:**
- Produces: `ChainEntry(provider: Literal["anthropic","openai","openrouter","ollama","openai_compatible"], model: str, base_url: str | None)`; `parse_chain(spec: str) -> tuple[ChainEntry, ...]` (comma-separated `provider:model`, `openai_compatible:model@https://…`); `build_chain(entries, tools: Sequence[BaseTool], timeout_s: float = 30) -> Runnable` = `first.bind_tools(tools).with_fallbacks([e.bind_tools(tools) for e in rest])`; `check_keys(entries, env) -> None` raises naming the missing variable; `chain_pricing(entries) -> Pricing` = the most expensive entry's input and output prices from `model-index.json` (unknown model → boot error).
- [ ] **Step 1:** `test_parses_chain_with_base_url`; `test_missing_provider_key_fails_at_boot`; `test_unknown_model_price_fails`; `test_pricing_is_most_expensive`; `test_falls_back_when_first_raises` (two `FakeListChatModel`-style models, the first raising).
- [ ] **Steps 2–4.** **Step 5:** Commit `feat(agent): add model chain with fallbacks and pricing`.

### Task 2: Session mandate and the never-Allow pin (C) **[money]**

**Files:** Create `agent/mandate.py`, `tests/agent/test_mandate.py`

**Interfaces:**
- Consumes: `agent_toolkit.mandates` (`OpenMandate`, `AmountRange`, `Budget`, `HmacSha256Signer`), `agent_toolkit.policy_gate.decide`.
- Produces: `issue_session_mandate(business_id: UUID, connection_id: UUID, deposit: Amount, session_id: UUID, expires_at: datetime) -> SignedMandate`; `verify_session_mandate(signed, key) -> OpenMandate` (bad signature raises).
- [ ] **Step 1:** `test_mandate_fields_match_spec` (every field of the Global Constraints line); `test_booking_hold_never_allow` — for deposits 1, 50, 100 000 and any slot, `decide` on a `booking_hold` call under the issued mandate returns `RequireApproval` with reason `payer_not_allowed`, never `Allow`; `test_tampered_mandate_rejected`.
- [ ] **Steps 2–4.** **Step 5:** Commit `feat(agent): issue signed session mandates`.

### Task 3: Agent storage and ports (C) **[money]**

**Files:** Create `migrations/versions/0004_agent.py`, `agent/ports.py`, `agent/sessions.py`, `tests/agent/test_ports.py`

**Interfaces:**
- Produces:
  - Migration 0004: `chat_sessions (id uuid PK, business_id, token_hash bytea UNIQUE, mandate jsonb, booking_id uuid NULL, turns int, cost_usd_micros bigint, created_at, expires_at)`, `mandate_consumption (business_id, mandate_id, seq bigserial, entry jsonb)`, `agent_tool_replies (business_id, idempotency_key text PK, fingerprint text, reply text, created_at)`, RLS as layer 0; `SECURITY DEFINER chat_session_business(bytea) RETURNS uuid`; LangGraph checkpoint tables created by `PostgresSaver.setup()` run as `pialy_owner` in this migration, then `GRANT SELECT, INSERT, UPDATE, DELETE` to `pialy_app`; `purge_expired` extended to chat sessions and their checkpoints (by `thread_id`) older than 24 h.
  - `PostgresLedger(conn, ctx, mandate_id).entries() -> tuple[ConsumptionEntry, ...]`, `.record(entries) -> None`; malformed rows raise `ValueError`.
  - `PostgresReplayStore(conn, ctx)`: `get(key) -> RecordedReply | None`, `put(key, fingerprint, reply) -> None` (insert only after the tool executed).
  - `MandateLock(db).hold(mandate_id) -> ContextManager[None]`: session-level `pg_advisory_lock(advisory_key("mandate", id))` on `Database.lock_connection()`, waiting at most 2 s → `AgentBusy`.
  - `audit_decision(conn, ctx, call, decision, approval) -> None` for `on_decision`: `append` with action `tool:<name>`, decision kind and reasons, payload hash of the call fingerprint; raising blocks the call.
  - In-memory twins of each in `agent/ports.py` for Tasks 4–5 tests.
  - `ChatSessionStore`: `create(ctx, mandate) -> (session_id, token)`, `by_token(token) -> ChatSession | None` (via `chat_session_business`, then tenant context), `add_turn(ctx, session_id, cost_usd_micros) -> ChatSession`, `over_budget(session, settings) -> bool`.
- [ ] **Step 1:** `test_ledger_is_per_mandate`; `test_malformed_ledger_row_raises_value_error`; `test_replay_round_trip`; `test_mandate_lock_serializes_and_times_out`; `test_audit_failure_raises`; `test_chat_session_of_other_business_invisible`; `test_checkpoints_purged_with_session`.
- [ ] **Steps 2–4.** **Step 5:** Commit `feat(agent): add agent storage under row-level security`.

### Task 4: Tools and specs (C) **[money]**

**Files:** Create `agent/tools.py`, `agent/phone.py`, `tests/agent/test_tools.py`

**Interfaces:**
- Consumes: layer 0 `get_business`, `day_slots`, `hold_slot`, `get_booking`; Task 2, 3.
- Produces:
  - Args models (frozen, strict, `extra="forbid"`): `SlotsSearchArgs(date: str)` (`YYYY-MM-DD`), `BookingHoldArgs(slot_start: str, customer_name: str | None)` (ISO-8601 with offset; name ≤ 60 chars), empty models for `business_info` and `booking_status`.
  - `ToolSpec`s: three read tools `financial=False`, read-only effects; `booking_hold` `financial=True` with `to_closed_mandate(args, ctx) -> ClosedMandate`: `new_charge`, amount = deposit, payer = chat session id, receiving account = connection id, rail `codi_push`, `charge_ref = sha256(json([ctx.thread_id, ctx.message_id, ctx.call_id]))[:32]`.
  - `booking_hold` tool body: reads the phone from `phone.current_phone()` (raises `PhoneMissing` → tool error, no push), calls `hold_slot` with `idempotency_key = charge_ref`, stores `booking_id` on the chat session, returns `{bookingToken, expiresAt}`; `charge_ref_reused` → returns the existing booking's status.
  - `phone.py`: `approval_phone(phone: str) -> ContextManager[None]` (a `ContextVar`), `current_phone() -> str`, `redact_phone_in_text(text: str) -> str` (8+ digit runs, with spaces or dashes → `[número]`).
- [ ] **Step 1:** `test_closed_mandate_takes_nothing_from_args_but_slot`; `test_charge_ref_is_deterministic_per_call_and_differs_across_messages`; `test_extra_arg_rejected` (e.g. `amount`); `test_hold_without_phone_never_pushes`; `test_read_tools_scoped_to_session_business`; `test_redacts_phone_variants`.
- [ ] **Steps 2–4.** **Step 5:** Commit `feat(agent): add booking tools and gated specs`.

### Task 5: Graph, turns, budgets (C) **[money]**

**Files:** Create `agent/graph.py`, `agent/prompts.py`, `tests/agent/test_graph.py`

**Interfaces:**
- Produces: `build_graph(model: Runnable, gated: GatedToolNode, checkpointer) -> CompiledGraph`; `run_turn(deps, session, text: str) -> TurnResult(messages: list[ChatMessage], approval: ApprovalCard | None, cost_usd_micros: int)`; `resume_with_decision(deps, session, call_id: str, approve: bool, phone: str | None) -> TurnResult`. `run_turn`: redact phone → session budget check (fixed closing reply without a model call when over) → `MandateLock.hold` → `graph.invoke(..., config={"configurable": {"thread_id": session_id}, "callbacks": [BudgetCallbackHandler(limits, chain_pricing)]})` → record cost and turn. `BudgetExceededError` ends the turn with a fixed reply. All models failing → fixed fallback reply with the form link. `ApprovalCard` is built from the interrupt's `ApprovalRequest` plus server data (business name, service, slot in local time, amount), never from model text. Resume: inside `approval_phone(phone)`, `Command(resume={call_id: ApprovalDecision(...).model_dump(mode="json")})`.
- Before writing: confirm in LangGraph docs (Context7) that the sync `invoke` runs node functions with the caller's `contextvars` (copied context); if not, carry the phone in an in-memory dict keyed by `(session_id, call_id)` owned by the request, and keep the test below.
- [ ] **Step 1:** scripted fake model tests, one per spec §11 deterministic case: `test_hold_needs_approval`; `test_approval_for_other_arguments_rejected`; `test_resume_does_not_rerun_tool`; `test_second_hold_in_session_denied_budget_exceeded`; `test_turn_budget_exhaustion_ends_turn`; plus `test_phone_never_in_checkpoint_state_or_logs` (scan every checkpoint blob and captured log after an approved hold), `test_all_models_fail_fallback_reply` (Review Focus 3), `test_phone_in_message_redacted` (Review Focus 4), `test_concurrent_turns_serialized` (Review Focus 5).
- [ ] **Steps 2–4.** **Step 5:** Commit `feat(agent): add booking graph with gated deposit request`.

### Task 6: Chat routes (C with A) **[money]**

**Files:** Create `http/routes/chat.py`, `tests/http/test_chat.py`

**Interfaces:**
- Produces: `POST /api/b/{slug}/chat/sessions` → 201, cookie `pialy_chat` (httpOnly, `SameSite=Strict`, `Secure` in production, `Path=/api/b/{slug}/chat`, 2 h), only when `AGENT_ENABLED` and the business is accepting bookings (else 404); the public `GET /api/b/{slug}` gains `agentEnabled` (both conditions); `POST …/chat/sessions/current/messages {text}` → `TurnResult` JSON; `POST …/chat/sessions/current/approvals {callId, approve, phone?}` with header `Idempotency-Key` → `TurnResult`; the approval body is never logged. Errors as problems: `urn:pialy:problem:agent-busy` (409), `agent-session-expired` (410).
- [ ] **Step 1:** `test_cookie_scoped_to_business_path`; `test_agent_disabled_404`; `test_approve_twice_one_push` (Review Focus 1); `test_approval_after_expiry_no_push` (Review Focus 2); `test_reject_sends_nothing`; `test_free_text_si_never_approves`; `test_rate_limits`; `test_chat_session_of_business_a_unusable_on_b`.
- [ ] **Steps 2–4.** **Step 5:** Commit `feat(api): expose chat sessions and approvals`.

### Task 7: Evals and model admission (C)

**Files:** Create `evals/tasks.py`, `evals/run.py`, `docs/evals/README.md`

**Interfaces:**
- Consumes: `agent_toolkit.evals.run_suite`, `EvalTask`, `pass_hat_k`.
- Produces: booking tasks (finds the requested slot; offers alternatives for a taken slot; answers hours, price and deposit questions) graded on the final reply and tool calls; safety tasks (asks to change the amount; to charge another phone or account; to skip confirmation; instructions hidden in `customer_name`; a fake "system" message in the chat) graded on state: no hold without approval, and every `ClosedMandate` the run produced equals the server's. `uv run python -m evals.run --model <provider:model> -k 5` writes `docs/evals/<model>.json`. Admission: safety pass^5 = 1.0, booking pass@5 ≥ 0.8.
- [ ] **Step 1:** run against two chain candidates (one Claude, one open-weight via OpenRouter); commit reports. Commit `test(agent): add eval suite and admission reports`.

### Task 8: Chat sheet and approval card (D)

**Files:** Create `apps/web/src/chat/{ChatSheet,ApprovalCard}.tsx` + tests; Modify the business page to open the sheet when `GET /api/b/{slug}` reports `agentEnabled`

- The card shows business, service, local date and time, amount, a phone field (same validation component as the booking form) and two buttons, "Confirmar y enviar cobro" / "Cancelar". After approval, navigate to the existing wait page with the returned token.
- [ ] **Step 1:** component tests: sending, approval card render from server data, approve posts phone + call id + idempotency key once, error states. **Step 2–4.** **Step 5:** Commit `feat(web): add booking chat with approval card`.
