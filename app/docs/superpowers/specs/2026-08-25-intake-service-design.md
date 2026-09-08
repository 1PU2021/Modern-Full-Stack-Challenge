# Intake Service/API Design

**Date:** 2026-08-25

**Status:** Approved for implementation planning

## Goal

Implement the real intake service as the next independent application slice. It
accepts authenticated alerts, exposes tenant-scoped alert/group reads, publishes
durable fanout work through a transactional outbox, exposes operational routes,
and shuts down gracefully.

This is demo-grade software. Prefer the simplest design that satisfies
`docs/APP_SPEC.md`, while preserving the project's strict requirements for
tenant isolation and graceful shutdown.

## Scope

This slice includes:

- The Express intake application and `src/intake/index.js` entrypoint.
- JWT verification and validated `tenant_id`/`sub` claims.
- All endpoints in APP_SPEC section 5.
- Zod validation and structured API errors.
- A tenant-scoped transactional outbox and its migration.
- An intake-owned asynchronous outbox publisher.
- Intake metrics, structured logging, readiness, liveness, and graceful
  shutdown.
- Unit tests and real PostgreSQL integration tests for the intake behavior.
- The APP_SPEC wording amendment for durable outbox publication.

This slice excludes fanout and dispatch workers, provider stubs, Docker/Compose,
seed data, dev-token scripts, and the frontend. A test fixture may stand in for
SQS, but no production implementation of an excluded subsystem is introduced.

Formal PR gates, branch protection, and production repository governance remain
deferred. Changes should still be small, coherent, committed conventionally,
and verified at each stopping point.

## Architecture

Use a small layered service with dependency injection, not a framework-heavy
controller/repository hierarchy:

```text
src/intake/
├── index.js          # composition, listen, signals, shutdown
├── app.js            # Express factory and middleware wiring
├── auth.js           # bearer JWT verification and claim validation
├── schemas.js        # Zod params/body/header schemas
├── alerts.js         # alert handlers and transactional operations
├── groups.js         # group query handler
├── outbox.js         # claim/publish/record loop
└── errors.js         # HTTP error normalization
```

`createApp({ db, metrics, logger, readiness })` returns an Express app without
opening a port. The entrypoint alone loads configuration, creates production
dependencies, starts the HTTP server and publisher, and owns process signals.

Build on the existing shared interfaces:

- `loadConfig()` for port, JWT, logging, database, AWS, and queue settings.
- `createPool(config.appDatabaseUrl)` and `createDb(pool).withTenant()` for
  tenant-scoped access. The intake service must never use `databaseUrl`.
- `createQueueClient()` and `sendMessage()` for SQS publication. Extend
  `sendMessage()` with an optional abort signal passed to the AWS client's
  `send` options so the shutdown deadline can cancel an in-flight send without
  changing existing callers.
- `createLogger('intake')` for structured logging.
- `createMetrics()` for the intake counters and Prometheus registry.

Do not add a dependency-injection container, generic repository abstraction, or
separate deployable publisher.

## Authentication and request context

All `/api/v1/**` routes require one `Authorization: Bearer <jwt>` credential.
Operational routes remain public.

Verify tokens with `jsonwebtoken`, `JWT_SECRET`, and an explicit HS256 allowlist.
Both `tenant_id` and `sub` must be UUID strings. Store only
`{ tenantId, userId }` in request context. Never accept tenant or creator
identity from client input.

Missing credentials return `401 authentication_required`. Malformed, expired,
incorrectly signed, or claim-invalid tokens return `401 invalid_token`.
A correctly signed token is trusted as the principal; do not add a user lookup
to every request. The alert foreign key still rejects a nonexistent `sub`.

Each request receives a correlation ID. Honor an incoming `X-Request-ID` only
when it is a nonempty string of at most 128 characters; otherwise generate a
UUID. Return the chosen value in the response `X-Request-ID` header and attach
it to a child logger. Async route errors flow to one central error handler.

## Validation

Zod validates bodies, path parameters, and the optional idempotency header at
the API boundary.

Alert fields:

- `title` is not whitespace-only and contains at most 200 Unicode code points.
- `body` is not whitespace-only and contains at most 10,000 Unicode code
  points. Preserve accepted title/body values exactly rather than trimming
  them during storage.
- `priority` is one of `low`, `normal`, `high`, `critical` and defaults to
  `normal`.
- `channels` is a nonempty, duplicate-free subset of `sms` and `email`.
- A group target contains only `type: "group"` and a UUID `groupId`.
- A polygon target contains only `type: "polygon"` and `geojson`.

Idempotency keys:

- Supplied keys contain 1–255 Unicode code points and cannot be whitespace-only.
- Preserve supplied keys exactly; keys are case-sensitive and tenant-scoped.
- Do not require client keys to be UUIDs.
- Generate a UUID v4 key when the header is absent.

Polygon validation is deliberately structural rather than topological:

- `geojson.type` is exactly `Polygon`.
- Accept 1–20 rings.
- Accept 4–1,000 positions per ring and at most 2,000 positions total.
- Every position is exactly `[longitude, latitude]`, both finite numbers.
- Longitude is within `[-180, 180]`; latitude is within `[-90, 90]`.
- The final position of each ring exactly equals its first.
- Each ring has at least three distinct non-closing vertices.
- Reject unknown properties within `target` and `geojson`.
- Limit JSON request bodies to 256 KB.

Intake does not validate self-intersection, winding, hole placement,
antimeridian behavior, or geographic area. The later fanout worker will use
PostGIS as the geometry authority and mark an alert failed if invalid geometry
somehow reaches it.

Validation failures return `400 validation_failed` with a stable array of
`{ path, message }` details.

## Alert acceptance and idempotency

`POST /api/v1/alerts` executes one `db.withTenant()` transaction:

1. Look up the tenant-scoped idempotency key and its alert.
2. If present, compare stored `title`, `body`, `priority`, `channels`, and
   `target` with the normalized validated request.
3. For an equivalent payload, return the existing alert ID with
   `replayed: true` and create no new rows.
4. For a different payload, return `409 idempotency_key_reused`.
5. Otherwise insert the alert using JWT `tenant_id` and `sub`.
6. Insert the `idempotency_keys` row.
7. Insert exactly one durable outbox event.
8. Commit before returning `202`.

The alert insert uses `ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`.
When a concurrent request won, look up the committed alert and apply the same
equivalence/conflict rules. This avoids advisory locks and converges concurrent
same-key requests onto one alert and one outbox event.

Normalize channels into the canonical order `sms`, then `email` before storage
and comparison. Compare strings and priority exactly after validation, and
compare target values structurally (object key order is irrelevant because the
database stores JSONB). Thus reversing an otherwise identical channel array is
an equivalent replay, while changing channel membership or any target value is
a conflict.

The response is always:

```json
{
  "alertId": "<uuid>",
  "idempotencyKey": "<client value or generated uuid>",
  "replayed": false
}
```

`replayed` becomes `true` for an equivalent retry. The accepted counter
increments only for newly created alerts, not replays.

## Transactional outbox

Add a tenant-scoped `alert_outbox` table:

```text
id             uuid primary key default gen_random_uuid()
tenant_id      uuid not null references tenants
alert_id       uuid not null unique references alerts
payload        jsonb not null
attempt_count  integer not null default 0
available_at   timestamptz not null default now()
published_at   timestamptz
last_error     text
claim_token    uuid
claimed_until  timestamptz
created_at     timestamptz not null default now()
```

Enable and force the standard tenant RLS policy, grant `app_user` CRUD access,
and add a partial index on `(tenant_id, available_at)` where
`published_at IS NULL`. The unique `alert_id` permits one durable event per
alert.

The payload is:

```json
{
  "eventId": "<outbox uuid>",
  "alertId": "<alert uuid>",
  "tenantId": "<tenant uuid>"
}
```

The stable `eventId` is the downstream deduplication identity. Publication is
at least once: a crash after SQS accepts the message but before success is
recorded may cause a duplicate. The later fanout worker must be idempotent.

Amend APP_SPEC's intake wording to:

> The intake transaction writes the alert, idempotency record, and one durable
> outbox event. A publisher asynchronously forwards the outbox event to SQS.

## Publisher lifecycle

The publisher is an independently testable loop embedded in each intake
process. Multiple intake replicas may run it concurrently.

1. Read tenant IDs from the non-RLS `tenants` root table using the pool's
   documented operational escape hatch.
2. For a tenant, start a short `withTenant()` transaction.
3. Select one due unpublished row whose claim is absent or expired using
   `FOR UPDATE SKIP LOCKED`.
4. Assign a fresh `claim_token`, set `claimed_until` 60 seconds ahead, and
   commit the claim.
5. Send the outbox payload to the alert-fanout SQS queue outside a database
   transaction.
6. In a second short tenant transaction, update only a row whose claim token
   still matches:
   - On success, set `published_at` and clear the claim.
   - On failure, increment `attempt_count`, set `available_at`, store a
     truncated error summary of at most 1,000 Unicode code points, and clear
     the claim.
7. Poll again. When no work is found, wait 500 ms.

Retry delays are 1, 2, 4, 8, 16, 32, then 60 seconds, capped at 60. These
values and the lease/poll intervals remain module constants for this demo.

An abandoned claim becomes eligible after `claimed_until`. A stale publisher
cannot overwrite a newer result because updates require its claim token.

## Read APIs

All queries use `db.withTenant(request.auth.tenantId, ...)` and the `app_user`
pool. Queries also include explicit tenant predicates where applicable; RLS is
the independent fail-closed boundary.

### `GET /api/v1/alerts`

Return newest first by `accepted_at`, then `id`, with:

`id`, `title`, `priority`, `status`, `channels`, `acceptedAt`, `completedAt`.

No pagination is introduced because the contract does not define it and demo
data is bounded.

### `GET /api/v1/alerts/:id`

Return `404 not_found` when the alert is absent or invisible. Otherwise return:

- `alert`: `id`, `title`, `body`, `priority`, `channels`, `target`, `status`,
  `acceptedAt`, `completedAt`.
- `deliveryCounts`: represented statuses and numeric counts.

Order grouped statuses as `pending`, `delivered`, `failed`, `rate_limited`,
`timed_out`. Before fanout, the counts array is empty.

### `GET /api/v1/alerts/:id/deliveries`

First establish that the tenant-visible alert exists; otherwise return 404.
Join deliveries to recipients and return `id`, `channel`, `status`,
`attemptCount`, `updatedAt`, `deliveredAt`, and `recipientName`. Sort by
recipient name, channel, then delivery ID.

### `GET /api/v1/groups`

Left-join group members so empty groups remain visible. Return `id`, `name`,
and numeric `memberCount`, sorted by name then ID.

Normalize PostgreSQL count values to JavaScript numbers before JSON output.
Invalid UUID path parameters return 400. Cross-tenant IDs return the same 404
as nonexistent IDs. No endpoint returns or accepts a tenant ID.

## Operational routes and metrics

- `/healthz` returns `200 {"status":"ok"}` without dependency checks.
- `/readyz` runs `SELECT 1` through the non-tenant pool escape hatch and
  returns `200 {"status":"ready"}` or `503 {"status":"not_ready"}`. It
  returns 503 immediately after shutdown begins.
- `/metrics` returns the isolated registry's Prometheus exposition using the
  registry content type.

Use existing intake counters. Increment `alert_intake_accepted_total` only for
new alerts. Increment `alert_intake_rejected_total` with bounded reasons such
as `validation`, `authentication`, `idempotency_conflict`, `database`, and
`internal`; never use raw error text as a label.

## Logging and errors

Request completion logs include request ID, method, path, status, and duration.
Authenticated logs add `tenant_id`; alert logs add `alert_id`. Publisher logs
add `tenant_id`, `alert_id`, `event_id`, and attempt count. Include `channel`
only for an event that represents one channel; do not invent it for a
multi-channel intake alert.

Never log JWTs, request bodies, provider responses, or database URLs.

Public errors use these codes:

- `400 validation_failed`
- `401 authentication_required`
- `401 invalid_token`
- `404 not_found`
- `409 idempotency_key_reused`
- `503 not_ready` for readiness failures
- `500 internal_error` for unexpected failures

Internal errors include the request ID in the response and keep details in
logs. Publisher failure never changes an already returned HTTP response; the
outbox remains durable and retryable.

## Graceful shutdown

The first `SIGTERM` or `SIGINT` starts graceful shutdown:

1. Mark readiness false.
2. Stop the publisher from claiming new rows.
3. Call `server.close()` to stop accepting new HTTP connections.
4. Allow in-flight HTTP requests and the current SQS send to finish.
5. Close the database pool and destroy the SQS client after work drains.
6. Let the event loop exit naturally; do not call `process.exit(0)` on the
   normal path.

A 25-second grace deadline bounds shutdown. At the deadline:

- Abort the current SQS send.
- Do not mark its outbox row published and do not clear or otherwise mutate its
  claim. Leave it leased until `claimed_until`; it then becomes eligible again.
- Use available Node server APIs to close idle and lingering HTTP connections.
- Force termination only after initiating best-effort resource cleanup.

The first signal initiates this sequence. A second `SIGTERM` or `SIGINT`
forces immediate termination as a practical escape hatch.

All process-global signal and forced-connection behavior stays isolated in
`index.js`. The app, publisher, and shutdown coordinator are testable without
emitting real process signals. Forced `process.exit()` is reserved for the
deadline or second-signal path.

## DB/SQS failure model

The database transaction is the acceptance boundary. If it fails, return 500
and create no partial alert/outbox state. Once it commits, return 202 even if
SQS is unavailable; the publisher retries independently.

There is no distributed transaction and no exactly-once SQS claim. Durability
comes from the outbox, and duplicate safety is delegated explicitly to the
stable event ID and the later idempotent fanout worker.

## Testing boundaries

Unit tests require no external services and cover:

- JWT parsing, verification, and claim validation.
- Zod alert, idempotency-key, UUID, and polygon edge cases.
- Error normalization and request logging behavior.
- Route behavior through injected fake DB/metrics dependencies where useful.
- Payload equivalence and idempotency conflict decisions.
- Publisher claim, success, retry/backoff, lease expiry, stale-token, stop, and
  aborted-send behavior using fake DB/queue dependencies.
- Shutdown coordination without real process signals.

Integration tests use real PostgreSQL/PostGIS and the existing serial harness:

- The outbox migration shape, RLS, grants, index, and down/up behavior.
- Alert/idempotency/outbox atomicity.
- Equivalent replay and mismatched-payload conflict behavior.
- Concurrent same-key requests create one alert and one outbox row.
- Every read endpoint's response shape and ordering.
- Numeric count normalization.
- Cross-tenant reads return 404/empty results through the real intake app and
  `app_user` pool.
- `/readyz` reflects database reachability.
- Publisher claim coordination and token-guarded result recording against the
  real schema.

SQS transport serialization remains covered by the shared queue unit tests.
Intake publisher integration may use a minimal fake SQS client; ElasticMQ and
Docker/Compose are outside this slice. Full process signal tests are unnecessary
when lifecycle coordination is dependency-injected and unit-tested.

At each implementation stopping point, run the relevant focused tests, the full
unit suite, the serial integration suite when database behavior changed, and
lint before committing.

## Following implementation plan

The `superpowers:writing-plans` step should divide work into small TDD tasks,
expected roughly as follows:

1. Amend APP_SPEC wording and add the outbox migration/integration tests.
2. Add validation and authentication modules with unit tests.
3. Add the Express factory, operational routes, error handling, and logging.
4. Add alert acceptance/idempotency transaction behavior and integration tests.
5. Add the four read endpoints and tenant-isolation integration coverage.
6. Add outbox claim/result operations and publisher tests.
7. Add the production entrypoint and graceful shutdown coordinator.
8. Run whole-slice verification and update repository-state documentation.

The plan must preserve the approved scope exclusions and must not add a formal
PR workflow.
