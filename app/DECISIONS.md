# Decisions

Short, dated log of decisions made on this project that aren't self-evident
from the code or the spec — the *why*, not the *what*.

## 2026-08-31 — email-only tenant login with narrow pre-tenant discovery

Tenant-user email addresses are globally unique using a case-insensitive
`lower(email)` unique index, allowing the demo login to accept only email and
password. Because the tenant is not known until the user is found, one
`SECURITY DEFINER` function performs only that bootstrap lookup and returns
the minimum authentication and tenant-display fields. Its `search_path` is
fixed, PUBLIC execution is revoked, and only `app_user` may execute it.
Ordinary unscoped reads of `users` remain blocked, and every post-login tenant
operation continues through `withTenant()` and forced RLS.

## 2026-08-31 — platform-admin tenant impersonation uses ordinary tenant identity

Platform administrators may start a temporary tenant session for an active
tenant, but the platform token itself never gains access to tenant-owned data.
The impersonation endpoint resolves an existing `tenant_admin` inside
`withTenant()` and issues the ordinary tenant JWT contract with that user's id
as `sub`, plus `impersonation` and `impersonated_by` audit claims. An active
tenant without a tenant administrator fails clearly rather than falling back
to another role or inventing an identity. The resulting token follows the
existing tenant middleware and PostgreSQL RLS path without exceptions.

The browser preserves the separate platform token only so exiting
impersonation can restore the platform tenant-management view without another
login. While impersonating, the tenant token is the sole credential used for
tenant API calls.

## 2026-08-30 — seeded demo login without production IAM

The final demo flow must not require a person to mint and paste a raw JWT.
Decision: intake exposes `POST /api/auth/login` for the two seeded demo users,
verifies versioned Node `scrypt` password hashes under tenant-scoped RLS, and
issues the existing HS256 `{ tenant_id, sub }` claims. The CLI token helper
remains for curl/testing and shares the issuer. This does not add signup,
refresh tokens, password management, cookies, or an external identity provider.

The deterministic polygon preset is aligned with seeded coordinates and keeps
`ST_Contains` semantics: interior points are selected, a boundary point is
excluded, and a geographically colocated user from another tenant remains
excluded by both explicit predicates and RLS.

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

## 2026-08-25 — transactional outbox for intake publication

Directly committing an alert and then sending its fanout message to SQS leaves
an unrecoverable gap: the database can commit successfully while SQS is
unavailable, permanently stranding an alert the API already accepted. Sending
before the database commit has the inverse race, where a worker can receive an
alert id that never becomes durable.

Decision: the intake transaction writes the alert, its idempotency record, and
one tenant-scoped `alert_outbox` event atomically. An intake-owned publisher
claims the durable event in a short transaction, performs SQS I/O outside the
transaction, then records success or retry state in another short transaction.

This provides durable, at-least-once publication rather than exactly-once
delivery. A publisher crash after SQS accepts a message but before
`published_at` is recorded can cause a duplicate, so every event carries a
stable `eventId` and the later fanout worker must treat duplicates idempotently.
