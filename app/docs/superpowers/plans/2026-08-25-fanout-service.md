# Fanout Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a runnable fanout worker that resolves alert targets, creates unique deliveries, publishes stable dispatch jobs, exposes operational endpoints/metrics, and shuts down without losing retryable work.

**Architecture:** A strict event parser feeds a tenant-scoped materialization store. A processor separates the database transaction from dispatch SQS sends and acknowledges only permanent poison or fully published work. A sequential abortable worker owns polling and bounded queue metrics; a small operational HTTP app and lifecycle coordinator provide health and graceful shutdown.

**Tech Stack:** Node.js 22/CommonJS, PostgreSQL 16 + PostGIS, `pg`, Amazon SQS SDK, Express, Zod, Pino, prom-client, `node:test`.

**Spec:** `docs/superpowers/specs/2026-08-25-fanout-service-design.md`

## Global Constraints

- Run all commands from `app/`.
- Production fanout creates its pool only from `config.appDatabaseUrl`.
- Every tenant-owned query uses `db.withTenant(tenantId, ...)` plus explicit tenant predicates.
- SQS calls never occur inside database transactions.
- Input and output are at-least-once; `deliveryId` is the stable logical dispatch identity.
- Do not add an ORM, generic repository framework, dispatch/provider behavior, frontend, seed, Docker/Compose, or infrastructure.
- First shutdown signal drains for 25 seconds; second signal forces exit 1.
- Never log raw message bodies, alert content, credentials, queue URLs, or database URLs.

---

### Task 1: Abortable queue receive interface

**Files:**
- Modify: `src/shared/queue.js`
- Modify: `src/shared/queue.test.js`

**Interfaces:**
- Consumes: existing `receiveMessages(client, queueUrl, options)`.
- Produces: `receiveMessages(..., { maxMessages, waitTimeSeconds, visibilityTimeout, abortSignal })` with backward compatibility.

- [ ] **Step 1: Add the failing abort-forwarding test**

Add a client whose `send(command, options)` captures both arguments:

```js
test('receiveMessages forwards an optional abort signal', async () => {
  const signal = new AbortController().signal;
  const calls = [];
  const client = {
    send(command, options) { calls.push({ command, options }); return Promise.resolve({}); },
  };
  await receiveMessages(client, 'http://queue/fanout', { abortSignal: signal });
  assert.equal(calls[0].options.abortSignal, signal);
});
```

- [ ] **Step 2: Verify RED**

Run: `node --test src/shared/queue.test.js`

Expected: FAIL because the fourth-option signal is not forwarded.

- [ ] **Step 3: Forward the signal compatibly**

Destructure `abortSignal` and call:

```js
const response = await client.send(command, abortSignal ? { abortSignal } : undefined);
```

- [ ] **Step 4: Verify and commit**

Run:

```bash
node --test src/shared/queue.test.js
npm run lint
```

Commit:

```bash
git add src/shared/queue.js src/shared/queue.test.js
git commit -m "feat: make queue receives abortable"
```

---

### Task 2: Fanout event and stored-alert validation

**Files:**
- Create: `src/fanout/schemas.js`
- Create: `src/fanout/schemas.test.js`

**Interfaces:**
- Consumes: SQS `Message.Body` strings and stored alert rows.
- Produces: `parseFanoutEvent(body)`, `parseStoredAlert(row)`, and `PermanentFanoutError`.

- [ ] **Step 1: Write failing schema tests**

Cover exact input shape, malformed JSON, UUID enforcement, unknown fields,
canonical `sms`/`email` channels, group target UUIDs, polygon GeoJSON shape,
and bounded public reasons:

```js
assert.deepEqual(parseFanoutEvent(JSON.stringify({ eventId, alertId, tenantId })), {
  eventId, alertId, tenantId,
});
assert.throws(() => parseFanoutEvent('{'), (error) =>
  error instanceof PermanentFanoutError && error.reason === 'invalid_event');
assert.throws(() => parseStoredAlert({ ...row, channels: ['voice'] }),
  /invalid_stored_alert/);
```

The polygon parser accepts only `{ type:'Polygon', coordinates }`, finite 2D
positions, closed rings, at least four positions, and the intake bounds of 20
rings/1,000 positions per ring/2,000 total positions.

- [ ] **Step 2: Verify RED**

Run: `node --test src/fanout/schemas.test.js`

Expected: FAIL because `schemas.js` does not exist.

- [ ] **Step 3: Implement strict Zod parsing**

`PermanentFanoutError` carries only `reason` and a stable message. Convert all
JSON/Zod failures to reason `invalid_event` or `invalid_stored_alert`; do not
attach raw input to the error. Return normalized channels in `sms`, `email`
order.

- [ ] **Step 4: Verify and commit**

Run:

```bash
node --test src/fanout/schemas.test.js
npm test
npm run lint
```

Commit:

```bash
git add src/fanout/schemas.js src/fanout/schemas.test.js
git commit -m "feat: validate fanout events and targets"
```

---

### Task 3: Tenant-scoped target resolution and idempotent deliveries

**Files:**
- Create: `src/fanout/store.js`
- Create: `test/integration/fanout-store.test.js`

**Interfaces:**
- Consumes: `db.withTenant`, `parseStoredAlert`, `{ tenantId, alertId }`.
- Produces: `createFanoutStore({ db })` with `materialize(event)` and `markFailed(event, reason)`.

- [ ] **Step 1: Add failing group integration cases**

Seed two tenants, alerts, groups, recipients, and memberships. Assert:

- tenant-visible group members create the recipient/channel cross-product;
- an empty or absent group creates no deliveries and completes the alert;
- another tenant's membership is never selected;
- output jobs are ordered recipient ID/channel/delivery ID and contain
  `{ deliveryId, alertId, tenantId, recipientId, channel }`.

Always clean `alert_outbox`, `idempotency_keys`, `deliveries`, `alerts`,
`group_members`, `groups`, `recipients`, `users`, then `tenants`.

- [ ] **Step 2: Add failing polygon integration cases**

Insert PostGIS points inside, outside, exactly on the boundary, null, and in
another tenant. Assert `ST_Contains` selects only the inside point. Include an
invalid stored polygon and assert `materialize()` throws a permanent
`invalid_geometry` error without partial deliveries.

- [ ] **Step 3: Add failing duplicate/concurrency cases**

Call `materialize()` twice and concurrently for the same event. Assert one row
per `(alert, recipient, channel)`, unchanged delivery IDs, and identical
logical job sets. Assert a cross-tenant event returns permanent
`alert_not_found` without observing the hidden alert.

- [ ] **Step 4: Verify RED**

Run:

```bash
node --env-file=.env --test --test-concurrency=1 test/integration/fanout-store.test.js
```

Expected: FAIL because `store.js` does not exist.

- [ ] **Step 5: Implement one tenant transaction**

Within `db.withTenant(event.tenantId, ...)`:

```sql
SELECT id, tenant_id, channels, target, status
FROM alerts WHERE tenant_id = $1 AND id = $2 FOR UPDATE;
```

Validate the row, set `expanding`, resolve with the exact APP_SPEC group or
PostGIS query, then insert using one unnested cross-product:

```sql
INSERT INTO deliveries (tenant_id, alert_id, recipient_id, channel)
SELECT $1, $2, recipient_id, channel
FROM unnest($3::uuid[]) recipient_id
CROSS JOIN unnest($4::text[]) channel
ON CONFLICT (alert_id, recipient_id, channel) DO NOTHING;
```

Select the complete delivery set with explicit tenant/alert predicates. Set
`dispatching` when nonempty, otherwise set `completed` and `completed_at`.
Map PostGIS geometry parse errors to `PermanentFanoutError('invalid_geometry')`;
let connectivity/other SQL errors remain retryable.

`markFailed()` uses a separate `withTenant()` transaction and updates only
the explicit visible alert to `failed`.

- [ ] **Step 6: Verify and commit**

Run:

```bash
node --env-file=.env --test --test-concurrency=1 test/integration/fanout-store.test.js
npm test
npm run test:integration
npm run lint
```

Commit:

```bash
git add src/fanout/store.js test/integration/fanout-store.test.js
git commit -m "feat: materialize tenant fanout deliveries"
```

---

### Task 4: One-message fanout processor

**Files:**
- Create: `src/fanout/processor.js`
- Create: `src/fanout/processor.test.js`

**Interfaces:**
- Consumes: `parseFanoutEvent`, store, injected `send(job, { abortSignal })`, injected `ack(message)`, logger.
- Produces: `createFanoutProcessor({ store, send, ack, logger })` with `process(message, { abortSignal })`.

- [ ] **Step 1: Write failing processor tests**

Use fakes to assert:

1. Materialization occurs before any send.
2. Every stable job is sent, then the input is acknowledged once.
3. Empty and terminal results acknowledge without sends.
4. Duplicate processing sends the same `deliveryId` values.
5. Send/database/internal failure does not acknowledge.
6. Abort does not acknowledge and is rethrown to shutdown.
7. Malformed/missing/invalid-geometry permanent errors call `markFailed`
   when an alert identity is available, log bounded fields, and acknowledge.
8. Raw message body never appears in logger arguments.

- [ ] **Step 2: Verify RED**

Run: `node --test src/fanout/processor.test.js`

Expected: FAIL because `processor.js` does not exist.

- [ ] **Step 3: Implement the orchestration boundary**

Parse, create a logger child with IDs, await `store.materialize(event)`, send
jobs sequentially outside the store transaction, then acknowledge. Catch only
`PermanentFanoutError` for poison acknowledgment; retryable errors bubble to
the worker. Pass the same abort signal to every send.

- [ ] **Step 4: Verify and commit**

Run:

```bash
node --test src/fanout/processor.test.js src/fanout/schemas.test.js
npm test
npm run lint
```

Commit:

```bash
git add src/fanout/processor.js src/fanout/processor.test.js
git commit -m "feat: process fanout queue messages"
```

---

### Task 5: Abortable worker loop and queue metrics

**Files:**
- Create: `src/fanout/worker.js`
- Create: `src/fanout/worker.test.js`

**Interfaces:**
- Consumes: injected `receive({ abortSignal })`, processor, `getCounts(queue)`, shared metrics, logger.
- Produces: `createFanoutWorker(...)` returning `{ start(), stop(), abort(), done }`.

- [ ] **Step 1: Write failing loop tests**

Assert:

- receive options are max 10, long poll 10 seconds, visibility 60 seconds;
- a batch is processed sequentially;
- one retryable message failure is logged and the loop continues;
- `stop()` interrupts an idle long poll, claims no later batch, and waits for
  active processing without aborting it;
- `abort()` aborts active receive/send processing and resolves `done`;
- queue counts set visible/in-flight gauges for bounded labels
  `alert-fanout` and `recipient-dispatch`;
- metrics refresh failure logs and does not stop processing.

- [ ] **Step 2: Verify RED**

Run: `node --test src/fanout/worker.test.js`

Expected: FAIL because `worker.js` does not exist.

- [ ] **Step 3: Implement the sequential loop**

Own one `AbortController` for the active receive/process cycle. On each pass,
receive a batch, process messages in order while not stopped, then refresh
both queue metrics best-effort. `stop()` sets the stop flag and aborts only an
idle receive; if a message is active it waits. `abort()` aborts either state.

- [ ] **Step 4: Verify and commit**

Run:

```bash
node --test src/fanout/worker.test.js src/fanout/processor.test.js src/shared/queue.test.js
npm test
npm run lint
```

Commit:

```bash
git add src/fanout/worker.js src/fanout/worker.test.js
git commit -m "feat: run fanout polling and queue metrics"
```

---

### Task 6: Operational routes and graceful lifecycle

**Files:**
- Create: `src/fanout/ops.js`
- Create: `src/fanout/ops.test.js`
- Create: `src/fanout/lifecycle.js`
- Create: `src/fanout/lifecycle.test.js`

**Interfaces:**
- Produces: `createReadiness()`, `createOpsApp({ db, metrics, logger, readiness })`, and `createShutdownCoordinator(...)`.

- [ ] **Step 1: Write failing operational route tests**

With Supertest assert public `/healthz`, database-checked `/readyz`, 503 after
`beginShutdown()`, Prometheus content type/body on `/metrics`, and structured
logging of readiness failures without leaking connection strings.

- [ ] **Step 2: Write failing lifecycle tests**

Using injected timers/fakes assert normal order:

```text
unready -> worker.stop + server.close -> pool.end -> queue.destroy
```

Assert concurrent shutdown memoization, 25-second deadline calls
`worker.abort()`, closes idle/all connections when available, begins cleanup,
and forces exit 1. Assert cleanup rejection and `force()` use exit 1.

- [ ] **Step 3: Verify RED**

Run:

```bash
node --test src/fanout/ops.test.js src/fanout/lifecycle.test.js
```

Expected: FAIL because both modules are absent.

- [ ] **Step 4: Implement small fanout-specific modules**

Follow intake's proven behavior without importing intake modules or moving
shared code. Keep process APIs out of both files; accept `forceExit`, timers,
server, and resources as dependencies.

- [ ] **Step 5: Verify and commit**

Run:

```bash
node --test src/fanout/ops.test.js src/fanout/lifecycle.test.js
npm test
npm run lint
```

Commit:

```bash
git add src/fanout/ops.js src/fanout/ops.test.js src/fanout/lifecycle.js src/fanout/lifecycle.test.js
git commit -m "feat: add fanout operations and shutdown"
```

---

### Task 7: Production fanout composition

**Files:**
- Create: `src/fanout/index.js`
- Create: `src/fanout/index.test.js`

**Interfaces:**
- Consumes: all fanout/shared factories and config queue URLs.
- Produces: runnable `npm run fanout` and exported `startFanout(dependencies)` composition seam.

- [ ] **Step 1: Write failing composition tests**

Inject factories and assert:

- pool receives only `config.appDatabaseUrl`;
- receive targets `alertFanoutUrl` and sends target `recipientDispatchUrl`;
- input acknowledgment deletes from `alertFanoutUrl` by receipt handle;
- queue metrics query both URLs;
- worker and operational server start;
- first SIGTERM calls graceful shutdown and second calls force;
- startup failure sets injected exit code and cleans created resources.

- [ ] **Step 2: Verify RED**

Run: `node --test src/fanout/index.test.js`

Expected: FAIL because the production composition is absent.

- [ ] **Step 3: Implement `startFanout()` and process wrapper**

Compose `loadConfig`, logger, metrics, app-user pool/db, one SQS client, store,
processor, worker, ops app/server, and lifecycle. Queue adapters are exactly:

```js
receive: ({ abortSignal }) => receiveMessages(queueClient,
  config.queues.alertFanoutUrl,
  { maxMessages: 10, waitTimeSeconds: 10, visibilityTimeout: 60, abortSignal }),
send: (job, { abortSignal }) => sendMessage(queueClient,
  config.queues.recipientDispatchUrl, job, { abortSignal }),
ack: (message) => deleteMessage(queueClient,
  config.queues.alertFanoutUrl, message.ReceiptHandle),
```

The file executes only when `require.main === module`, keeping imports testable.
Normal shutdown lets the event loop drain; forced paths alone call exit.

- [ ] **Step 4: Verify and smoke-test**

Run:

```bash
node --test src/fanout/index.test.js
node --check src/fanout/index.js
npm test
npm run lint
```

Start `node --env-file=.env src/fanout/index.js` in a bounded shell, request
`/healthz`, send one SIGTERM, and assert HTTP 200 plus process exit 0. PostgreSQL
must be available; SQS unavailability may log retryable polling errors.

- [ ] **Step 5: Commit**

```bash
git add src/fanout/index.js src/fanout/index.test.js
git commit -m "feat: run and gracefully stop fanout service"
```

---

### Task 8: Whole fanout acceptance and current-state docs

**Files:**
- Create: `test/integration/fanout-acceptance.test.js`
- Modify: `CLAUDE.md` (repo root, referenced as `../CLAUDE.md` from `app/`)
- Modify: `README.md` (repo root, referenced as `../README.md` from `app/`)

**Interfaces:**
- Consumes: real intake event contract, app-user DB, fanout store/processor, fake SQS sends.
- Produces: end-to-end proof and accurate repository state.

- [ ] **Step 1: Add end-to-end group acceptance**

Seed a tenant/user/group/recipients, POST a group alert through the real intake
app, read its exact outbox payload, feed that payload as an SQS message into
the real fanout processor, and assert delivery rows and dispatch payloads.

- [ ] **Step 2: Add polygon and duplicate acceptance**

POST a polygon alert selecting a strict recipient subset. Process the same
event twice and assert delivery row count is unchanged and the second set of
dispatch payloads has exactly the same `deliveryId` identities. Assert no
cross-tenant recipient appears.

- [ ] **Step 3: Run focused acceptance**

Run:

```bash
node --env-file=.env --test --test-concurrency=1 test/integration/fanout-acceptance.test.js
```

Expected: PASS.

- [ ] **Step 4: Update documentation**

Update root `CLAUDE.md` and `README.md` to mark fanout runnable, describe stable
delivery-ID at-least-once behavior, list `npm run fanout`, and retain dispatch,
provider stubs, frontend, seed, and Docker/Compose as absent. Do not claim a
DLQ, exactly-once messages, token generator, or dispatch completion.

- [ ] **Step 5: Run final verification**

```bash
npm test
npm run test:integration
npm run lint
git diff --check
```

Review the full fanout diff and explicitly verify app-user-only production DB,
all tenant operations through `withTenant`, no SQS in transactions, stable
delivery IDs on retries, correct PostGIS query, graceful/forced signal paths,
bounded metrics labels, and absence of excluded subsystems.

- [ ] **Step 6: Commit**

```bash
git add ../CLAUDE.md ../README.md test/integration/fanout-acceptance.test.js
git commit -m "docs: record functional fanout service"
```

---

## Completion criteria

- Group and polygon fanout work under app-user RLS.
- Duplicate events create no duplicate delivery rows and reuse delivery IDs.
- Retryable work remains unacknowledged; permanent poison does not hot-loop.
- Fanout exposes health, readiness, metrics, and bounded queue gauges.
- First signal drains; deadline/second signal force while leaving input retryable.
- Existing intake behavior remains unchanged and green.
- All verification commands pass and the worktree is clean.
