# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Current state of the repo

The shared modules, database migrations/RLS, intake service, fanout worker,
dispatch worker, and provider stubs are implemented. From `app/`, `npm run
intake` starts the authenticated Express API and its durable outbox publisher;
`npm run fanout` materializes deliveries; `npm run dispatch` consumes dispatch
jobs and records provider outcomes; and `npm run stubs` starts deterministic
SMS/email HTTP stubs. The API provides:

- `POST /api/v1/alerts`
- `GET /api/v1/alerts`
- `GET /api/v1/alerts/:id`
- `GET /api/v1/alerts/:id/deliveries`
- `GET /api/v1/groups`
- `GET /healthz`, `GET /readyz`, and `GET /metrics`

The frontend/admin UI is implemented in `app/web`. Seeded demo login at
`POST /api/auth/login`, dev-token tooling for curl/tests, the Docker image, and
Compose environment are functional for local demos; they use explicitly
non-production credentials and remain intentionally simple.
From `app/`, the unit, integration, and lint commands are real and passing.
**`app/docs/APP_SPEC.md` is the authoritative spec** for everything that gets
built here — read it in full before implementing anything, and treat any
conflict between this file and the spec in the spec's favor (update this
file if that happens).

## What this repo is

A "Critical Notification Platform" — the workload the rest of a platform
engineering tech challenge deploys, scales, and breaks on purpose (burst
testing, chaos exercises, cross-tenant isolation tests). Robustness bar is
explicitly **demo-grade, not production-grade**, except for three things the
challenge's evaluation actually exercises, which must be correct: **tenant
isolation, delivery-outcome bookkeeping, and graceful shutdown**.

One paragraph: an authenticated operator submits an alert (title, body,
priority, channels, and a target — a saved group or a geographic polygon).
The system accepts it immediately, resolves the target into concrete
recipients in the background, and pushes a notification to each recipient
over every requested channel (SMS, email), recording a per-recipient
delivery outcome the operator watches fill in live.

## Architecture

Single Node.js 20 / CommonJS / Express codebase under `app/`, **one
`app/package.json`, one
Docker image, four container commands** selecting which service runs
(`npm run intake`, `fanout`, `dispatch`, `stubs`) — this keeps one artifact
SHA traceable to whatever's running in any role.

```
app/src/
├── shared/        # config, db (RLS-aware pool), queue, logger, metrics
├── intake/        # Express API: POST/GET alerts, groups
├── fanout/        # SQS consumer: resolves recipients, enqueues dispatch jobs
├── dispatch/      # SQS consumer: calls providers, records delivery outcomes
└── stubs/         # Express: fake SMS/email providers with realistic misbehavior
app/web/           # Vite React app: compose, alert list, alert detail, groups
app/migrations/    # node-pg-migrate, one file per change, up+down
```

**Request flow:** `POST /alerts` atomically writes the alert, idempotency row,
and one durable outbox event, then returns without waiting for SQS. The
intake-owned publisher claims events in short tenant transactions, sends to
SQS outside a transaction, and records success or retry state in another short
transaction. Publication is at least once and preserves a stable event ID.
Recipient expansion never happens inline in the request handler, which is what
keeps intake fast under burst. The `fanout` worker resolves the target
(group membership query, or a PostGIS `ST_Contains` polygon query) into
recipient ids, writes one `pending` delivery row per recipient per channel,
then enqueues one dispatch job per recipient per channel. `dispatch` calls
the provider stub for each job and records the outcome; on a transient
failure it increments `attempt_count` and leaves the SQS message undeleted
so the queue's visibility timeout redelivers it (retry/backoff for free),
capped at 5 attempts before the delivery is marked permanently `failed`.

**Tenant isolation is enforced at two independent layers** and both need
their own passing test — see spec section 4 for the exact tests:
1. App layer: cross-tenant `GET` by id must 404 (not 403).
2. Database layer: Postgres RLS (`FORCE ROW LEVEL SECURITY`, policies keyed
   on `current_setting('app.current_tenant', true)`) must return zero rows
   even for a query that forgets a `WHERE tenant_id` clause. Services connect
   as a low-privilege `app_user` role (never the migration-owner role) so
   `FORCE ROW LEVEL SECURITY` actually applies, and every request handler
   runs `SET LOCAL app.current_tenant = $1` inside a transaction before
   touching tenant-scoped tables. The DB-layer test is the one that matters
   more — it must hold even when application code has a bug. Services must
   build their pool from config.appDatabaseUrl, never config.databaseUrl
   (the migration-owner connection) -- see app/src/shared/db.js's createPool
   comment.

**The planned provider stubs are load-bearing, not incidental.** They're what the rest
of the challenge's burst/chaos testing grades against, so they must model
realistic misbehavior: baseline latency + failure rate, token-bucket rate
limiting (`429` + `Retry-After`), and a correlated `degradeUntil` window that
temporarily worsens latency/failure rate for all calls (this is what produces
a realistic retry storm rather than independent per-request noise). Email
additionally has a small chance of hanging 25–32s to prove the dispatch
worker's client-side timeout actually fires. See spec section 7 for the
suggested per-channel numbers.

**Metrics are named/labeled to slot directly into a golden-signals
dashboard** (see spec section 2) — don't rename these if you implement them:
`alert_intake_to_delivery_seconds` (latency, the core SLI),
`alert_intake_accepted_total` (traffic), `dispatch_delivery_outcome_total{outcome=...}`
+ `alert_intake_rejected_total` (errors), `queue_backlog_depth{queue=...}`
(saturation, visible messages only) + `queue_inflight_messages{queue=...}`
(saturation, in-flight/received-but-not-yet-visible messages). The two queue
gauges are deliberately kept separate rather than summed — they mean
different things during a retry storm, where most of the backlog is
in-flight, not visible. `queue_inflight_messages` isn't in the spec's
original golden-signal table (section 2) — it was added later via code
review; `queue_backlog_depth` is still the one the spec names.

**Data model, API contract, frontend screens, seed-data requirements, and
local-dev (`app/docker-compose.yml`) requirements** are all specified in detail
in `app/docs/APP_SPEC.md` sections 4, 5, 8, 9, and 10 respectively — read the
relevant section before touching that area rather than re-deriving it.

## Explicitly out of scope

Per spec section 11 — don't build these even if asked to "complete" the app:
real auth/signup/password-reset/MFA (hardcoded seeded dev users are enough),
voice channel, any direct cloud SDK calls beyond SQS (no direct S3/Secrets
Manager from app code — secrets come in via env vars), multi-region/DR
failover logic, a polished frontend design system.

## Git workflow

Functionality is the current priority. Work within the repository's existing
Git workflow, keep changes small and coherent, use Conventional Commits, and
verify tests/lint at stopping points. Formal PR requirements, branch
protection, approval gates, and production-grade repository governance remain
deferred scope.
