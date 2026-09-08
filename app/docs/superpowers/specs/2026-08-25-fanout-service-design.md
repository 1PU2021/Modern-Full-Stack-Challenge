# Fanout Service Design

**Date:** 2026-08-25
**Status:** Approved by the end-to-end execution request
**Authority:** `docs/APP_SPEC.md`, amended only by `DECISIONS.md`

## Objective

Implement the fanout service as the next application phase. It consumes the
stable alert event published by intake, resolves group or polygon targets,
materializes one delivery per recipient/channel, and publishes stable dispatch
jobs. Tenant isolation, delivery bookkeeping, duplicate tolerance, and
graceful shutdown remain correctness requirements; everything else stays
demo-grade and direct.

## Scope

Included:

- Consume `{ eventId, alertId, tenantId }` from the alert-fanout queue.
- Resolve group membership and PostGIS polygon containment.
- Create unique pending delivery rows and update alert lifecycle state.
- Publish dispatch jobs to the recipient-dispatch queue.
- Tolerate duplicate input messages and partial publish retries.
- Expose `/healthz`, `/readyz`, and `/metrics`.
- Update visible and in-flight gauges for both fanout and dispatch queues.
- Structured logging and graceful SIGTERM/SIGINT shutdown.
- Unit, integration, and bounded worker acceptance tests.

Excluded:

- Dispatch processing and provider calls.
- Provider stubs, frontend, seed scripts, Docker/Compose, Terraform, Helm, or
  external observability infrastructure.
- A dispatch transactional outbox or generic worker framework.

## Existing integration boundary

Fanout builds directly on:

- `loadConfig()` and `config.appDatabaseUrl`.
- `createPool()` / `createDb()` and mandatory `db.withTenant()` access.
- `createQueueClient()`, `receiveMessages()`, `sendMessage()`,
  `deleteMessage()`, and `getQueueCounts()`.
- `createLogger()` and `createMetrics()`.
- Intake's stable event shape and at-least-once `eventId` semantics.
- `deliveries` uniqueness on `(alert_id, recipient_id, channel)`.

Intake code and its publisher are not redesigned.

## Approaches considered

### Direct inserts with ad hoc sends

Insert deliveries and send dispatch jobs without stable job identity. This is
small, but a fanout retry can look like a new logical notification downstream.

### Fanout-owned dispatch outbox

Write deliveries and dispatch events atomically, then publish via a second
leased outbox. This closes the database/SQS availability gap most strongly,
but adds a table and publisher subsystem not required by APP_SPEC section 6.

### Selected: stable delivery identity with idempotent materialization

Use the delivery row as the logical dispatch identity. Insert rows with
`ON CONFLICT (alert_id, recipient_id, channel) DO NOTHING`, query the complete
stable set, and include `deliveryId` in every dispatch payload. Delete the
input message only after all sends succeed. A retry can create duplicate
physical SQS messages—as SQS itself can—but all copies represent the same
delivery ID. The later dispatch worker must ignore terminal deliveries and
update attempts by `deliveryId` under tenant scope.

This is the simplest design consistent with the challenge's at-least-once
boundary. It does not claim exactly-once SQS publication.

## Components

```text
src/fanout/
├── schemas.js    # trusted-event validation and permanent error classification
├── store.js      # tenant transaction: load, resolve, materialize, state changes
├── processor.js  # one message: validate, transact, publish, acknowledge
├── worker.js     # receive loop, bounded sequential processing, queue metrics
├── ops.js        # health/readiness/metrics Express app
├── lifecycle.js  # testable graceful/forced cleanup coordination
└── index.js      # process-global composition and signal handlers
```

Each module exposes narrow factory/functions and accepts dependencies for
deterministic tests. No framework or generic repository layer is introduced.

## Event and dispatch contracts

Input is strict JSON:

```json
{ "eventId": "<uuid>", "alertId": "<uuid>", "tenantId": "<uuid>" }
```

Dispatch output is:

```json
{
  "deliveryId": "<uuid>",
  "alertId": "<uuid>",
  "tenantId": "<uuid>",
  "recipientId": "<uuid>",
  "channel": "sms"
}
```

`deliveryId` is the logical deduplication identity. Unknown fields, malformed
JSON, non-UUID identities, and unsupported channels are rejected without
logging the raw body.

## Tenant-scoped materialization transaction

`materializeFanout({ tenantId, alertId })` runs one `db.withTenant()` callback:

1. Select the alert with explicit `tenant_id` and `id` predicates.
2. If absent or invisible, return a permanent `alert_not_found` result.
3. Set `status = 'expanding'` unless already terminal.
4. Resolve recipients:
   - group: join `group_members` to `recipients` with explicit tenant
     predicates, ordered by recipient ID;
   - polygon: use `ST_Contains(ST_SetSRID(ST_GeomFromGeoJSON($2),4326),
     location::geometry)`, exclude null locations, and order by recipient ID.
5. Cross-join resolved IDs with the alert's canonical channel array and bulk
   insert delivery rows with `ON CONFLICT DO NOTHING`.
6. Select the complete alert delivery set ordered by recipient ID, channel,
   and delivery ID.
7. Set the alert to `dispatching` when jobs exist. If no recipients resolve,
   set it to `completed` with `completed_at = now()`.
8. Commit and return stable dispatch jobs.

All tenant-owned reads and writes use `withTenant()`. RLS is the fail-closed
boundary; explicit tenant predicates remain in application SQL.

The known single-column foreign-key limitation in `DECISIONS.md` is not
expanded or silently repaired in this phase.

## Duplicate and retry behavior

- Duplicate intake events cannot create duplicate delivery rows because of
  the existing unique constraint.
- Delivery IDs are generated only by the first successful insert and reused
  on every retry.
- Fanout sends the complete stable job set on each attempt. If a send fails,
  it leaves the input message undeleted so SQS can retry it.
- A crash after some or all sends but before input deletion can create
  duplicate physical dispatch messages. They retain the same `deliveryId` and
  are one logical job. This is deliberate at-least-once behavior.
- Fanout never holds a database transaction open during SQS I/O.
- Empty target results complete the alert and acknowledge the input message.
- Already `completed` or `failed` alerts acknowledge without publishing.

## Failure classification

Retryable failures leave the input message undeleted:

- database connectivity/transaction failures;
- dispatch queue send failures;
- unexpected internal failures;
- shutdown aborts.

Permanent message failures are acknowledged after bounded structured logging:

- malformed JSON or invalid event schema;
- tenant-visible alert missing for the supplied identity;
- stored target shape/channel corruption;
- PostGIS geometry parse/validation errors.

For permanent stored alert/geometry failures, fanout marks the visible alert
`failed` in a separate tenant transaction before acknowledging. A missing or
cross-tenant alert cannot be updated and is simply acknowledged as poison.

Deleting malformed poison messages rather than relying on an as-yet-unbuilt
DLQ prevents the demo worker from hot-looping forever. It does not add DLQ
infrastructure to this slice.

## Worker loop

`createFanoutWorker()` owns a single abortable long-poll receive loop:

- Receive up to 10 messages with a 10-second long poll and a 60-second
  visibility timeout.
- Process the returned batch sequentially. This keeps shutdown and duplicate
  behavior easy to reason about for demo scale.
- Stop claiming after `stop()` but finish the current message.
- `abort()` cancels the active receive or dispatch send. The current fanout
  input remains undeleted and becomes retryable after visibility timeout.
- Continue after individual retryable message failures.
- Expose `{ start(), stop(), abort(), done }` like the intake publisher.

`receiveMessages()` is extended compatibly with an optional `abortSignal`.
No visibility-extension heartbeat is added; the 60-second visibility timeout
is sufficient for the sequential demo workload and is a documented limit.

## Metrics and operational HTTP

The fanout process exposes an Express operational server:

- `/healthz`: always 200 while the process is alive; no dependency check.
- `/readyz`: 200 only before shutdown and when `SELECT 1` succeeds.
- `/metrics`: the shared Prometheus registry.

After each receive pass, a best-effort metrics refresh calls
`getQueueCounts()` for both queue URLs and sets:

- `queue_backlog_depth{queue="alert-fanout"}`
- `queue_inflight_messages{queue="alert-fanout"}`
- `queue_backlog_depth{queue="recipient-dispatch"}`
- `queue_inflight_messages{queue="recipient-dispatch"}`

Metric refresh failure is logged and does not stop message processing. Labels
remain bounded to those two queue names.

## Logging

Use service `fanout` and structured child fields where applicable:

- `event_id`, `tenant_id`, `alert_id` for input processing;
- `delivery_id`, `recipient_id`, `channel` for dispatch publication;
- bounded error reason and attempt/message metadata.

Never log raw SQS bodies, alert title/body/target, credentials, queue URLs, or
database URLs.

## Graceful shutdown

`index.js` is the only process-global module. First SIGTERM/SIGINT:

1. Mark readiness false.
2. Stop new receives.
3. Close the operational HTTP server.
4. Wait for the current message and its sends.
5. Close the app-user pool and destroy the SQS client.
6. Let the event loop drain without `process.exit(0)`.

At the 25-second deadline, abort active SQS I/O, close lingering HTTP
connections using available Node server APIs, begin best-effort cleanup, and
force exit 1. The current input message is not deleted. A second signal forces
immediate exit 1.

## Testing boundaries

Unit tests cover:

- event validation and permanent/retryable classification;
- stable job mapping and processor acknowledge/retry behavior;
- receive-loop stop/abort/continuation and queue metric updates;
- operational routes and lifecycle ordering/deadline behavior;
- optional receive abort forwarding in the shared queue helper.

PostgreSQL integration tests cover:

- group resolution including empty and cross-tenant groups;
- polygon inclusion, boundary exclusion under `ST_Contains`, null locations,
  and tenant isolation;
- recipient/channel delivery cross-product;
- duplicate/concurrent materialization producing one row per logical job;
- stable delivery IDs across retries;
- alert status transitions and invalid geometry failure handling.

A bounded acceptance test feeds the actual intake event payload into the real
fanout processor with app-user PostgreSQL and fake SQS sends, then repeats the
event and proves delivery row uniqueness and stable logical job identities.

## Known limitations

- Duplicate physical dispatch messages are possible and expected under
  at-least-once delivery; dispatch must deduplicate logically by delivery ID.
- No fanout DLQ/redrive configuration is created in this application slice.
- No visibility heartbeat; unusually large/slow fanouts can outlive 60
  seconds and be processed concurrently by another worker.
- Fanout sends dispatch jobs sequentially; sufficient for bootcamp demo data,
  not optimized throughput.
- Empty/missing groups resolve to zero recipients and complete the alert.

## Completion criteria

- Both target modes resolve correctly under RLS.
- Unique delivery rows and stable dispatch identities survive duplicate input.
- Database transactions never contain SQS I/O.
- Retryable failures leave fanout input undeleted; permanent poison is
  acknowledged safely.
- Operational routes, bounded queue metrics, and shutdown behavior pass.
- Existing intake tests remain green.
- Unit, integration, lint, diff check, and fanout acceptance/smoke tests pass.
