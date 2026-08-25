# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Current state of the repo

The repo is scaffolded but the services aren't implemented yet.
`package.json` exists with npm scripts for all four service entrypoints
(`intake`, `fanout`, `dispatch`, `stubs`) plus `migrate`, `seed`, `test`, and
`lint` — but the four service entrypoints themselves
(`src/intake/index.js`, `src/fanout/index.js`, `src/dispatch/index.js`,
`src/stubs/index.js`) don't exist yet, so those four npm scripts aren't
runnable yet. `src/shared/` has all five modules the spec calls for
(`config.js`, `logger.js`, `metrics.js`, `queue.js`, `db.js`), each with its
own passing `node:test` suite (24 tests total as of this writing). `npm
test` and `npm run lint` are both real, working commands and both exit 0.
**`docs/APP_SPEC.md` is the authoritative spec** for everything that gets
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

## Architecture (per the spec — to be scaffolded)

Single Node.js 20 / CommonJS / Express codebase, **one `package.json`, one
Docker image, four container commands** selecting which service runs
(`npm run intake`, `fanout`, `dispatch`, `stubs`) — this keeps one artifact
SHA traceable to whatever's running in any role.

```
src/
├── shared/    # config, db (RLS-aware pool), queue, logger, metrics
├── intake/    # Express API: POST/GET alerts, groups
├── fanout/    # SQS consumer: resolves recipients, enqueues dispatch jobs
├── dispatch/  # SQS consumer: calls providers, records delivery outcomes
└── stubs/     # Express: fake SMS/email providers with realistic misbehavior
web/           # Vite React app: compose, alert list, alert detail, login
migrations/    # node-pg-migrate, one file per change, up+down
```

**Request flow:** `POST /alerts` only writes one row and enqueues one SQS
message — recipient expansion never happens inline in the request handler,
which is what keeps intake fast under burst. `fanout` resolves the target
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
   more — it must hold even when application code has a bug.

**Provider stubs are load-bearing, not incidental.** They're what the rest
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
(saturation).

**Data model, API contract, frontend screens, seed-data requirements, and
local-dev (`docker-compose.yml`) requirements** are all specified in detail
in `docs/APP_SPEC.md` sections 4, 5, 8, 9, and 10 respectively — read the
relevant section before touching that area rather than re-deriving it.

## Explicitly out of scope

Per spec section 11 — don't build these even if asked to "complete" the app:
real auth/signup/password-reset/MFA (hardcoded seeded dev users are enough),
voice channel, any direct cloud SDK calls beyond SQS (no direct S3/Secrets
Manager from app code — secrets come in via env vars), multi-region/DR
failover logic, a polished frontend design system.

## Git workflow (per spec section 3)

- `main` is protected — PRs only, at least one approving review, status
  checks passing.
- Short-lived feature branches: `feat/...`, `fix/...`, `chore/...`.
- Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`).
- Commits should be signed (GPG or SSH).
- Keep PRs small — one logical change.
