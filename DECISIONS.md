# Decisions

Short, dated log of decisions made on this project that aren't self-evident
from the code or the spec — the *why*, not the *what*.

## 2026-08-25 — AWS region: us-east-2

Region: us-east-2, because it's the team's existing working region. Meets
the challenge's 3-AZ minimum with zero spare AZ. No deeper regional
comparison was done — not required for this exercise.

## 2026-08-25 — idempotency_keys added to the RLS table list

Spec section 4 originally listed six tables as tenant-scoped-and-therefore-
RLS-protected (`users`, `groups`, `recipients`, `group_members`, `alerts`,
`deliveries`), deliberately excluding `idempotency_keys` even though it
carries a `tenant_id`. A whole-branch review of the migrations work flagged
this as a real inconsistency, not a deliberate scope boundary: `idempotency_keys`
participates directly in `POST /alerts`' idempotency lookup, and leaving it
outside RLS means a handler that forgets a `tenant_id` predicate — exactly
the bug class RLS exists to catch — would leak another tenant's `alert_id`
back to the caller (bounded: the leaked value is an opaque UUID, and a
follow-up `GET /alerts/:id` on it still 404s, since `alerts` itself has RLS).

Decision: amend spec section 4 to include `idempotency_keys` in the RLS
table list and apply the same standard policy. Low-risk, structurally
consistent with the rest of the model, no schema shape change.

Two related findings from the same review were deliberately **not** acted
on, and are recorded here as accepted/deferred rather than fixed:

- **`tenants` is fully readable across tenants by `app_user`.** Correct per
  spec — `tenants` is the isolation root, not a tenant-scoped child table —
  and this is an accepted, conscious limitation for this project, not a bug.
  Revisit only if tenant existence itself needs to be confidential.
- **Every foreign key in this schema is single-column, so RLS does not
  structurally prevent a session scoped to one tenant from inserting a row
  that references another tenant's parent row** (e.g. `deliveries.recipient_id`
  pointing at a recipient that belongs to a different tenant than
  `deliveries.tenant_id`). RLS still prevents *disclosure* — a subsequent
  read joining to that parent row returns nothing, since the parent row's
  own RLS hides it — so this is a referential-integrity gap, not a
  cross-tenant data leak. A production implementation would use composite
  `(tenant_id, id)` foreign keys and matching unique constraints on every
  tenant-owned relationship; that changes the shape of section 4's data
  model materially and is out of scope for this pass. Documented here as a
  known limitation to name explicitly, not one to be surprised by later.
