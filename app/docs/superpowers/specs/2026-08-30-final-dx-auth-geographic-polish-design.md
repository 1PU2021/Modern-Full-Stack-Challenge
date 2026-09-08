# Final DX, Demo Authentication, and Geographic Polish Design

**Date:** 2026-08-30
**Status:** Approved in chat
**Authority:** `docs/APP_SPEC.md`, `DECISIONS.md`, and the final-polish request

## Goal

Make the established application architecture and local happy path obvious,
replace raw JWT entry with a small demo login, and prove geographic targeting
through the same frontend polygon contract and durable fanout path used by the
running stack.

## Architectural boundaries

The existing deployable roles remain unchanged: Vite web, intake/outbox,
fanout, dispatch, provider stubs, PostgreSQL/PostGIS, and SQS/ElasticMQ. No new
service, framework, ORM, external identity provider, or queue contract is
introduced. Backend roles continue to share one package and image while
remaining independently runnable processes.

## Demo authentication

Intake adds public `POST /api/auth/login` accepting strict JSON
`{ tenantSlug, email, password }`. It resolves the tenant from the intentionally
non-RLS tenant root, then reads the user only through `db.withTenant(tenantId)`.
Credentials are compared against a versioned scrypt hash with
`crypto.timingSafeEqual`. Authentication failures return one indistinguishable
`401 invalid_credentials` response.

JWT creation moves to a shared helper used by login and the development token
CLI. Tokens remain HS256 and retain the exact trusted identity claims
`{ tenant_id, sub }`. Protected `/api/v1/**` behavior and RLS scoping do not
change.

The seed uses `DEMO_USER_PASSWORD` (demo default documented in
`.env.example`) and stores an actual scrypt hash in `users.password_hash`.
Stable per-demo-user salts keep the seed plan deterministic. This is explicitly
demo-only authentication, not production IAM.

The frontend replaces raw-token controls with a login view, keeps the issued
token in session storage, attaches it through the existing centralized client,
clears it on logout or a protected `401`, and gates application routes while
unauthenticated. JWT contents are never displayed or editable.

## Geographic workflow

MapLibre and Terra Draw remain the map stack, with OpenFreeMap as the no-key
tile provider. The editor explicitly selects Terra Draw's `polygon` mode,
provides drawing/finish instructions and loading/error feedback, and keeps a
deterministic preset. The preset and map viewport align with the county seed
grid.

The seed plan makes geographic expectations explicit: multiple county
recipients are strictly inside the preset, at least one county recipient is
outside, one school-tenant recipient is geographically inside, and one county
recipient lies on the boundary. Existing `ST_Contains` semantics intentionally
exclude the boundary point.

The frontend continues sending a GeoJSON Polygon geometry as
`target: { type: "polygon", geojson }`. Intake performs structural validation;
fanout uses PostGIS `ST_IsValid` and `ST_Contains` under `withTenant()`. A
self-intersecting but structurally valid polygon is accepted durably, then
marked failed by fanout without deliveries.

## Containers and onboarding

Compose retains all current services and the Postgres volume. Long-running
services receive sensible restart policies. Intake, fanout, and dispatch get
health checks using their existing readiness endpoints; web waits for healthy
intake. Initialization jobs remain completion-gated and do not restart.

The root README leads with description, architecture, prerequisites, Quick
Start, health verification, demo credentials, repository map, and geographic
demo steps. The documented clean-checkout path creates `app/.env` from the
example and runs Compose from `app/`; it must not depend on any pre-existing
developer environment file.

## Verification

Tests cover scrypt hashing/verification, login success/failure and claims,
unchanged unauthenticated protection and tenant isolation, frontend
login/session/logout/header behavior, polygon mode activation, exact frontend
payload serialization, deterministic inside/outside/boundary/cross-tenant
selection, invalid geometry, and intake-outbox-to-fanout delivery creation.

Final verification includes backend unit/integration/lint, frontend
test/lint/build, Compose configuration and image builds, diff checks, and a
clean-environment live Compose smoke of login → frontend preset-equivalent
polygon submission → outbox → fanout → dispatch delivery rows.

## Deliberate limitations

- Demo credentials and HS256 auth are not production IAM.
- Session storage remains appropriate only for this demo scope.
- OpenFreeMap needs browser Internet access even though it needs no API key.
- Polygon boundaries remain excluded by `ST_Contains`.
- Topological invalidity is finalized asynchronously by fanout, preserving the
  established durable-acceptance design.
