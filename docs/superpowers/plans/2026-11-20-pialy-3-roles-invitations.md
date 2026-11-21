# Pialy layer 3: staff role and invitations — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An owner invites people by a copied link, they join as `staff`, and `staff` can run the agenda (check-in, flags) but nothing in settings, pey or people.

**Architecture:** `memberships` and the role dependency exist since layer 0; this layer turns on `StaffActor`, adds invitations with a hashed single-use token resolved through a `SECURITY DEFINER` function, and the people screen.

**Tech Stack:** as layer 0.

**Spec:** `docs/superpowers/specs/2026-11-20-pialy-python-backend-agent-design.md` §5b (roles table), §6 (`invitations`), §10 members and invitations routes, §11 tenancy (`staff` refused on every owner route), §12b, §13 layer 3.

## Global Constraints

- Everything in layer 0's Global Constraints.
- Two fixed roles; `owner` ⊇ `staff`. No per-permission editing, no custom roles.
- No mail: the invitation link is shown once to the owner, who sends it themselves. Token `secrets.token_urlsafe(32)`, stored as SHA-256, valid 72 h, single use, bound to the invited email (lower-cased).
- A business always keeps at least one owner.

## Review Focus

1. The invited person opens the link while signed in as another email → 403 `urn:pialy:problem:invitation-other-email` with the invited email masked (`a***@dominio.mx`), nothing joined (Task 2).
2. The link is opened twice, or after 72 h → 410 `invitation-used` / `invitation-expired` (Task 2).
3. The last owner tries to remove themselves or downgrade → 409 `last-owner` (Task 1).
4. A removed staff member's open session on the agenda → their next request to that business is 404 at once, other businesses they belong to unaffected (Task 1).
5. An invitation for an email already a member → 409 `already-member` (Task 2).

## Roles and order

B: Tasks 1–2; D: Task 3. 1 → 2 → 3.

---

### Task 1: `staff` role and member management (B)

**Files:** Create `src/pialy/identity/members.py`, `http/routes/members.py`, `tests/http/test_members.py`; Modify `http/deps.py` (map `staff` membership to `StaffActor`)

**Interfaces:**
- Produces: `GET /api/businesses/{slug}/members` (owner) → `[{userId, email, role, since}]`; `DELETE /api/businesses/{slug}/members/{userId}` (owner) → 204, audit `member_removed`; role changes are out of scope (remove and re-invite).
- Route access after this task: `staff` may call board, board events, check-in, verify, resolve flag; every `/api/businesses/{slug}…` route is owner-only.
- [ ] **Step 1:** `test_staff_refused_on_every_owner_route` (walk the route table: every route marked owner answers 403 to staff); `test_staff_allowed_on_agenda_routes`; `test_last_owner_cannot_leave` (Review Focus 3); `test_removed_member_loses_access_immediately` (Review Focus 4); `test_removal_audited`.
- [ ] **Steps 2–4.** **Step 5:** Commit `feat(api): add staff role and member management`.

### Task 2: Invitations (B)

**Files:** Create `migrations/versions/0005_invitations.py`, `identity/invitations.py`, `http/routes/invitations.py`, `tests/http/test_invitations.py`

**Interfaces:**
- Produces: migration with `SECURITY DEFINER invitation_by_token(bytea) RETURNS TABLE(id uuid, business_id uuid, email text, role text, expires_at timestamptz, accepted_at timestamptz)`; `POST /api/businesses/{slug}/invitations {email}` (owner) → 201 `{url}` shown once (`{public_origin}/invitacion/{token}`), role always `staff`; `GET /api/invitations/{token}` → `{businessName, emailMasked}` (public, rate-limited 20 per IP per 10 min); `POST /api/invitations/{token}/accept` (signed in, or with `{password}` to sign up inline when the invited email has no account) → membership created, audit `member_added`.
- [ ] **Step 1:** `test_invite_returns_link_once_and_stores_hash`; `test_accept_creates_staff_membership`; `test_accept_with_other_email_403` (Review Focus 1); `test_used_and_expired_410` (Review Focus 2); `test_already_member_409` (Review Focus 5); `test_token_of_business_a_cannot_join_b`; `test_inline_signup_on_accept`.
- [ ] **Steps 2–4.** **Step 5:** Commit `feat(api): add invitations by copied link`.

### Task 3: People screen and invitation page (D)

**Files:** Create `apps/web/src/pages/{People,Invitation}.tsx` + tests; Modify navigation (owner sees "Personal"; staff sees only the agenda)

- [ ] **Step 1:** tests: owner lists, invites (link shown once with copy button and the warning that it will not be shown again), removes with confirmation; staff navigation hides settings, pey and people; invitation page handles 403/410/409 copy in Spanish.
- [ ] **Steps 2–4:** implement; `pnpm --filter web lint typecheck test build`. **Step 5:** Commit `feat(web): add people screen and invitation page`.
