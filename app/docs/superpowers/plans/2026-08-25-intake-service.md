# Intake Service/API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the authenticated intake API, backed by tenant-scoped PostgreSQL access and a durable transactional outbox that asynchronously forwards one fanout event per accepted alert to SQS.

**Architecture:** A dependency-injected Express application handles HTTP without opening its own listener. Alert acceptance commits the alert, idempotency record, and outbox event atomically; an independently testable publisher claims events briefly, sends outside a DB transaction, and records outcomes in a second transaction. The production entrypoint alone owns dependency composition, signals, sockets, and graceful shutdown.

**Tech Stack:** Node.js 22+, CommonJS, Express 4, Zod 3, `jsonwebtoken`, PostgreSQL 16/PostGIS through `pg`, node-pg-migrate, AWS SDK SQS, pino, prom-client, `node:test`, supertest, ESLint 9.

**Spec:** `docs/superpowers/specs/2026-08-25-intake-service-design.md`

> **Working directory:** Run all commands in this plan from the application
> root (`cd app`). Application-relative paths such as `src/`, `migrations/`,
> `test/`, and `docs/` are relative to `app/`.

## Global Constraints

- `docs/APP_SPEC.md` remains authoritative; amend its intake wording for the approved transactional outbox.
- Use `config.appDatabaseUrl` for the running intake pool. Never use `config.databaseUrl` in production intake code.
- Every tenant-owned query runs inside `db.withTenant(tenantId, fn)` and includes an explicit tenant predicate where applicable.
- JWT identity comes only from verified HS256 `tenant_id` and `sub` UUID claims.
- JSON bodies are limited to 256 KB. Title is at most 200 Unicode code points; body is at most 10,000. Neither may be whitespace-only.
- Client idempotency keys are case-sensitive, preserved exactly, contain 1–255 Unicode code points, and cannot be whitespace-only. Missing keys become UUID v4 values.
- Polygon validation is structural only: 1–20 rings, 4–1,000 positions per ring, at most 2,000 total positions, two-number positions in longitude/latitude bounds, closed rings, and at least three distinct non-closing vertices per ring.
- One alert transaction creates one alert, one idempotency record, and one outbox event. SQS publication is at least once and uses a stable `eventId`.
- Outbox claims use a 60-second lease, 500 ms idle polling, and retry seconds `1, 2, 4, 8, 16, 32, 60`.
- The first `SIGTERM`/`SIGINT` starts graceful shutdown; a second forces termination. The deadline is 25 seconds. Normal completion lets the event loop drain without `process.exit(0)`.
- Fanout, dispatch, provider stubs, Docker/Compose, seed scripts, dev-token scripts, and frontend code are out of scope.
- Do not introduce a required PR workflow. Use small conventional commits and verify relevant tests plus lint before every stopping point.

---

## File Structure

```text
docs/APP_SPEC.md
../CLAUDE.md
../README.md
migrations/1787700000000_create-alert-outbox-table.js
src/shared/queue.js
src/shared/queue.test.js
src/intake/
├── index.js
├── app.js
├── app.test.js
├── auth.js
├── auth.test.js
├── schemas.js
├── schemas.test.js
├── alerts.js
├── groups.js
├── errors.js
├── errors.test.js
├── outbox.js
├── outbox.test.js
├── lifecycle.js
└── lifecycle.test.js
test/integration/
├── support/intake.js
├── alert-outbox.test.js
├── intake-alerts.test.js
├── intake-reads.test.js
└── intake-outbox-publisher.test.js
```

## Stable Interfaces

```js
// errors.js
class AppError extends Error { constructor(status, code, message, details) }
function asyncHandler(handler)
function errorMiddleware({ logger, metrics })

// schemas.js
function parseAlertRequest({ body, idempotencyKey })
function parseUuidParam(value, name)

// auth.js
function createAuthMiddleware({ jwtSecret, metrics })

// alerts.js
function createAlertsRouter({ db, metrics })
function acceptAlert({ db, metrics, auth, input })
function listAlerts({ db, tenantId })
function getAlertDetail({ db, tenantId, alertId })
function listDeliveries({ db, tenantId, alertId })

// groups.js
function createGroupsRouter({ db })
function listGroups({ db, tenantId })

// app.js
function createReadiness()
function createApp({ db, metrics, logger, jwtSecret, readiness, routeFactories })

// outbox.js
function retryDelaySeconds(attemptCount)
function createOutboxStore({ db })
function createOutboxPublisher({ store, send, logger, sleep })

// lifecycle.js
function createShutdownCoordinator({ server, publisher, pool, queueClient, readiness, logger, graceMs, forceExit })
```

---

### Task 1: Transactional outbox migration and spec amendment

**Files:**
- Create: `migrations/1787700000000_create-alert-outbox-table.js`
- Create: `test/integration/alert-outbox.test.js`
- Modify: `test/integration/app-user-role.test.js`
- Modify: `test/integration/migration-round-trip.test.js`
- Modify: `docs/APP_SPEC.md`
- Modify: `DECISIONS.md`

**Interfaces:**
- Consumes: existing migration conventions, RLS helpers, `ensureMigrated`, `migrateTo`, and `withSuperuserClient`.
- Produces: tenant-scoped `alert_outbox` with one row per alert, claim/retry state, RLS, app-user CRUD grants, and a pending-work partial index.

- [ ] **Step 1: Write the failing outbox integration test**

Create `test/integration/alert-outbox.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ensureMigrated, withSuperuserClient } = require('./support/db');
const schema = require('./support/schema');

test('alert_outbox matches the intake design, including RLS and pending index', async () => {
  await ensureMigrated();
  await withSuperuserClient(async (client) => {
    const expected = {
      id: ['uuid', 'NO'], tenant_id: ['uuid', 'NO'], alert_id: ['uuid', 'NO'],
      payload: ['jsonb', 'NO'], attempt_count: ['int4', 'NO'],
      available_at: ['timestamptz', 'NO'], published_at: ['timestamptz', 'YES'],
      last_error: ['text', 'YES'], claim_token: ['uuid', 'YES'],
      claimed_until: ['timestamptz', 'YES'], created_at: ['timestamptz', 'NO'],
    };
    for (const [name, [type, nullable]] of Object.entries(expected)) {
      const column = await schema.getColumn(client, 'alert_outbox', name);
      assert.equal(column.udt_name, type, name);
      assert.equal(column.is_nullable, nullable, name);
    }
    assert.ok(await schema.hasPrimaryKey(client, 'alert_outbox', ['id']));
    assert.ok(await schema.hasForeignKey(client, 'alert_outbox', 'tenant_id', 'tenants'));
    assert.ok(await schema.hasForeignKey(client, 'alert_outbox', 'alert_id', 'alerts'));
    assert.ok(await schema.hasUniqueConstraint(client, 'alert_outbox', ['alert_id']));
    const rls = await schema.rlsStatus(client, 'alert_outbox');
    assert.deepEqual(rls, { relrowsecurity: true, relforcerowsecurity: true });
    assert.ok(await schema.hasPolicy(client, 'alert_outbox', 'tenant_isolation_alert_outbox'));
    const { rows } = await client.query(`SELECT indexdef FROM pg_indexes WHERE tablename = 'alert_outbox'`);
    assert.ok(rows.some(({ indexdef }) => indexdef.includes('(tenant_id, available_at)') && indexdef.includes('published_at IS NULL')));
  });
});
```

- [ ] **Step 2: Update existing migration expectations**

Add `alert_outbox` to the CRUD-grant list in
`test/integration/app-user-role.test.js`. In
`test/integration/migration-round-trip.test.js`, change both migration counts
from 9 to 10 and add `alert_outbox` to the sorted expected table list.

- [ ] **Step 3: Run focused integration tests to verify RED**

Run:

```bash
npm run test:integration -- test/integration/alert-outbox.test.js test/integration/app-user-role.test.js test/integration/migration-round-trip.test.js
```

Expected: FAIL because migration 10 and `alert_outbox` do not exist.

- [ ] **Step 4: Add the migration**

Create `migrations/1787700000000_create-alert-outbox-table.js`:

```js
'use strict';

exports.up = (pgm) => {
  pgm.createTable('alert_outbox', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants' },
    alert_id: { type: 'uuid', notNull: true, unique: true, references: 'alerts' },
    payload: { type: 'jsonb', notNull: true },
    attempt_count: { type: 'integer', notNull: true, default: 0 },
    available_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    published_at: { type: 'timestamptz' },
    last_error: { type: 'text' },
    claim_token: { type: 'uuid' },
    claimed_until: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('alert_outbox', ['tenant_id', 'available_at'], {
    name: 'alert_outbox_pending_idx', where: 'published_at IS NULL',
  });
  pgm.alterTable('alert_outbox', { levelSecurity: 'ENABLE' });
  pgm.alterTable('alert_outbox', { levelSecurity: 'FORCE' });
  pgm.createPolicy('alert_outbox', 'tenant_isolation_alert_outbox', {
    using: "tenant_id = current_setting('app.current_tenant', true)::uuid",
    check: "tenant_id = current_setting('app.current_tenant', true)::uuid",
  });
  pgm.grantOnTables({
    tables: 'alert_outbox', roles: 'app_user',
    privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  });
};

exports.down = (pgm) => pgm.dropTable('alert_outbox');
```

- [ ] **Step 5: Amend APP_SPEC**

Add `alert_outbox` to section 4 with the exact columns above, standard RLS, and
at-least-once stable-event-ID semantics. Replace the section 5 sentence about
one row/one message with:

```text
The intake transaction writes the alert, idempotency record, and one durable
outbox event. A publisher asynchronously forwards the outbox event to SQS.
Recipient expansion never happens inline in the request handler.
```

Add a dated `DECISIONS.md` entry recording why intake uses a transactional
outbox: direct post-commit SQS publication can strand accepted alerts, while a
distributed exactly-once transaction is unavailable. Record the accepted
tradeoff that forwarding is at least once and later fanout must deduplicate the
stable `eventId`.

- [ ] **Step 6: Verify and commit**

Run:

```bash
npm run test:integration -- test/integration/alert-outbox.test.js test/integration/app-user-role.test.js test/integration/migration-round-trip.test.js
npm run test:integration
npm run lint
```

Expected: all commands exit 0 and the destructive round trip covers 10 migrations.

```bash
git add docs/APP_SPEC.md DECISIONS.md migrations/1787700000000_create-alert-outbox-table.js test/integration/alert-outbox.test.js test/integration/app-user-role.test.js test/integration/migration-round-trip.test.js
git commit -m "feat: add durable alert outbox schema"
```

---

### Task 2: Validation and HTTP error primitives

**Files:**
- Create: `src/intake/schemas.js`
- Create: `src/intake/schemas.test.js`
- Create: `src/intake/errors.js`
- Create: `src/intake/errors.test.js`

**Interfaces:**
- Consumes: Zod and `randomUUID`.
- Produces: `parseAlertRequest`, `parseUuidParam`, `AppError`, `asyncHandler`, and `errorMiddleware`.

- [ ] **Step 1: Write failing validation tests**

In `src/intake/schemas.test.js`, define compact `validGroupBody`,
`validPolygonBody`, and coordinate-generator helpers, then assert:

```js
test('defaults priority, generates a key, and canonicalizes channels', () => {
  const value = parseAlertRequest({
    body: {
      title: 'Storm warning', body: 'Take shelter', channels: ['email', 'sms'],
      target: { type: 'group', groupId: '11111111-1111-1111-1111-111111111111' },
    },
  });
  assert.equal(value.priority, 'normal');
  assert.deepEqual(value.channels, ['sms', 'email']);
  assert.match(value.idempotencyKey, /^[0-9a-f-]{36}$/i);
});

test('preserves a supplied 255-code-point key exactly', () => {
  const key = 'Ä'.repeat(255);
  assert.equal(parseAlertRequest({ body: validGroupBody(), idempotencyKey: key }).idempotencyKey, key);
});

test('accepts a structurally sane polygon', () => {
  const body = validPolygonBody([[[0, 0], [1, 0], [0, 1], [0, 0]]]);
  assert.equal(parseAlertRequest({ body }).target.type, 'polygon');
});
```

Add named rejection tests for duplicate/empty channels, whitespace-only text,
unknown target/GeoJSON fields, open rings, fewer than three distinct vertices,
3D positions, non-finite/out-of-range coordinates, and exact 200/201 title,
10,000/10,001 body, 255/256 key, 20/21 ring, 1,000/1,001 per-ring, and
2,000/2,001 total-position boundaries.

- [ ] **Step 2: Write failing error tests**

In `src/intake/errors.test.js`, test public `AppError` fields, rejected-promise
forwarding, stable JSON for known errors, `500 internal_error` plus request ID
for unknown errors, original-error logging, and bounded rejection labels.

```js
test('asyncHandler forwards rejected promises', async () => {
  const boom = new Error('boom');
  let forwarded;
  await asyncHandler(async () => { throw boom; })({}, {}, (error) => { forwarded = error; });
  assert.equal(forwarded, boom);
});
```

- [ ] **Step 3: Run tests to verify RED**

Run: `node --test src/intake/schemas.test.js src/intake/errors.test.js`

Expected: FAIL with module-not-found errors.

- [ ] **Step 4: Implement validation and errors**

Use strict discriminated Zod objects, `.superRefine()` for ring aggregate rules,
and `Array.from(value).length` for Unicode code-point bounds. Canonicalize via:

```js
const CHANNEL_ORDER = ['sms', 'email'];
const channels = CHANNEL_ORDER.filter((channel) => parsed.data.channels.includes(channel));
```

`parseAlertRequest` throws `AppError.validation(details)` with stable
`{ path, message }` entries. `parseUuidParam` returns a UUID or throws the same
400 error. `errorMiddleware` maps only `validation`, `authentication`,
`idempotency_conflict`, `database`, or `internal` metric reasons and never uses
raw error text.

- [ ] **Step 5: Verify and commit**

Run:

```bash
node --test src/intake/schemas.test.js src/intake/errors.test.js
npm test
npm run lint
```

Expected: all commands exit 0.

```bash
git add src/intake/schemas.js src/intake/schemas.test.js src/intake/errors.js src/intake/errors.test.js
git commit -m "feat: add intake validation and errors"
```

---

### Task 3: JWT authentication middleware

**Files:**
- Create: `src/intake/auth.js`
- Create: `src/intake/auth.test.js`

**Interfaces:**
- Consumes: `AppError` and `jsonwebtoken`.
- Produces: `createAuthMiddleware({ jwtSecret, metrics })`, setting `req.auth = { tenantId, userId }` or forwarding a public 401 error.

- [ ] **Step 1: Write failing auth tests**

Use direct middleware invocation and signed tokens:

```js
test('verified HS256 token exposes only normalized identity', async () => {
  const token = jwt.sign({ tenant_id: TENANT_ID, sub: USER_ID, ignored: 'x' }, SECRET, { algorithm: 'HS256' });
  const req = { headers: { authorization: `Bearer ${token}` } };
  await invoke(createAuthMiddleware({ jwtSecret: SECRET, metrics }), req);
  assert.deepEqual(req.auth, { tenantId: TENANT_ID, userId: USER_ID });
});
```

Add cases for missing header, wrong scheme, extra bearer segments, bad
signature, expiry, non-HS256 algorithm, missing claims, and malformed UUIDs.
Missing credentials use `authentication_required`; all invalid tokens use
`invalid_token`. Neither error contains the token.

- [ ] **Step 2: Run the test to verify RED**

Run: `node --test src/intake/auth.test.js`

Expected: FAIL because `auth.js` does not exist.

- [ ] **Step 3: Implement auth**

```js
function createAuthMiddleware({ jwtSecret }) {
  return (req, res, next) => {
    const parts = (req.headers.authorization || '').split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer' || !parts[1]) {
      return next(new AppError(401, 'authentication_required', 'Bearer token required'));
    }
    try {
      const claims = jwt.verify(parts[1], jwtSecret, { algorithms: ['HS256'] });
      req.auth = {
        tenantId: parseUuidClaim(claims.tenant_id),
        userId: parseUuidClaim(claims.sub),
      };
      return next();
    } catch {
      return next(new AppError(401, 'invalid_token', 'Token is invalid or expired'));
    }
  };
}
```

Metric increments remain centralized in `errorMiddleware`.

- [ ] **Step 4: Verify and commit**

Run:

```bash
node --test src/intake/auth.test.js src/intake/errors.test.js
npm test
npm run lint
```

Expected: all commands exit 0.

```bash
git add src/intake/auth.js src/intake/auth.test.js
git commit -m "feat: add intake JWT authentication"
```

### Task 4: Express application shell and operational routes

**Files:**
- Create: `src/intake/app.js`
- Create: `src/intake/app.test.js`

**Interfaces:**
- Consumes: Express, `randomUUID`, auth/error middleware, injected `db.pool`, metrics registry, and logger.
- Produces: `createReadiness()` and `createApp({ db, metrics, logger, jwtSecret, readiness, routeFactories })`; `routeFactories` is optional and exists for isolated shell tests.

- [ ] **Step 1: Write failing shell tests**

Use supertest and fakes in `src/intake/app.test.js`:

```js
test('healthz is public and never queries dependencies', async () => {
  const { app, pool } = fixture();
  const response = await request(app).get('/healthz');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { status: 'ok' });
  assert.equal(pool.queryCalls, 0);
});

test('readyz checks the pool until shutdown begins', async () => {
  const { app, readiness, pool } = fixture();
  assert.equal((await request(app).get('/readyz')).status, 200);
  readiness.beginShutdown();
  assert.equal((await request(app).get('/readyz')).status, 503);
  assert.equal(pool.queryCalls, 1);
});
```

Also assert DB readiness failure, public Prometheus output/content type, the
256 KB JSON limit (`413 payload_too_large`), generated/echoed `X-Request-ID`
with the 128-character boundary, authentication on `/api/v1`, JSON API 404s,
and completion logging that excludes authorization and request bodies.

- [ ] **Step 2: Run the shell test to verify RED**

Run: `node --test src/intake/app.test.js`

Expected: FAIL because `app.js` does not exist.

- [ ] **Step 3: Implement the app factory**

Wire middleware in this order:

```js
app.use(requestContext(logger));
app.use(express.json({ limit: '256kb' }));
app.get('/healthz', healthHandler);
app.get('/readyz', readyHandler({ db, readiness }));
app.get('/metrics', metricsHandler(metrics.register));
app.use('/api/v1', createAuthMiddleware({ jwtSecret, metrics }));
app.use('/api/v1/alerts', createAlertsRouter({ db, metrics }));
app.use('/api/v1/groups', createGroupsRouter({ db }));
app.use(apiNotFound);
app.use(errorMiddleware({ logger, metrics }));
```

To avoid throwaway router files before Tasks 5-6, let `createApp` accept optional
`routeFactories`. When omitted, resolve `createAlertsRouter` and
`createGroupsRouter` with `require()` inside `createApp`; shell tests inject
factories returning empty routers. The production call omits this test seam.

The request-context middleware accepts `X-Request-ID` only when it is nonempty
and at most 128 characters, otherwise uses `randomUUID()`, returns the chosen
ID in the response header, and logs method/path/status/duration on `finish`.

- [ ] **Step 4: Verify and commit**

Run:

```bash
node --test src/intake/app.test.js src/intake/auth.test.js src/intake/errors.test.js
npm test
npm run lint
```

Expected: all commands exit 0.

```bash
git add src/intake/app.js src/intake/app.test.js
git commit -m "feat: add intake HTTP application shell"
```

---

### Task 5: Alert acceptance, idempotency, and atomic outbox writes

**Files:**
- Create: `src/intake/alerts.js`
- Create: `test/integration/support/intake.js`
- Create: `test/integration/intake-alerts.test.js`
- Modify: `src/intake/app.js`
- Modify: `src/intake/app.test.js`

**Interfaces:**
- Consumes: `parseAlertRequest`, `parseUuidParam`, `AppError`, `asyncHandler`, `db.withTenant`, and intake metrics.
- Produces: `acceptAlert`, `createAlertsRouter`; the router implements `POST /api/v1/alerts`.

- [ ] **Step 1: Add the real-app integration fixture**

Create `test/integration/support/intake.js`:

```js
'use strict';

const jwt = require('jsonwebtoken');
const { loadConfig } = require('../../../src/shared/config');
const { createPool, createDb } = require('../../../src/shared/db');
const { createMetrics } = require('../../../src/shared/metrics');
const { createLogger } = require('../../../src/shared/logger');
const { createApp, createReadiness } = require('../../../src/intake/app');

function createIntakeFixture() {
  const config = loadConfig();
  const pool = createPool(config.appDatabaseUrl);
  const db = createDb(pool);
  const metrics = createMetrics();
  const logger = createLogger('intake-test', { level: 'silent' });
  const readiness = createReadiness();
  const app = createApp({ db, metrics, logger, jwtSecret: config.jwtSecret, readiness });
  return {
    app, pool, metrics,
    sign({ tenantId, userId }) {
      return jwt.sign({ tenant_id: tenantId, sub: userId }, config.jwtSecret, { algorithm: 'HS256' });
    },
  };
}

module.exports = { createIntakeFixture };
```

- [ ] **Step 2: Write failing acceptance integration tests**

In `test/integration/intake-alerts.test.js`, seed one tenant/user and assert:

1. Valid POST without a key returns 202, a UUID key, `replayed: false`, and
   creates exactly one alert, idempotency row, and outbox row.
2. Payload is exactly `{ eventId, alertId, tenantId }`.
3. Equivalent replay returns the same ID/key with `replayed: true`; counts stay one.
4. Reversed channel order is equivalent.
5. Same key with changed title, channel membership, or target returns 409.
6. Two concurrent same-key requests converge on one alert/key/outbox row.
7. Invalid body returns structured 400 with no rows.
8. Nonexistent `sub` causes 500 with no partial rows and no SQL leakage.
9. Tenant A cannot replay or observe tenant B's key.

Use `withSuperuserClient` for fixtures and always delete outbox, idempotency,
deliveries, alerts, users, then tenants in FK-safe order.

- [ ] **Step 3: Run the integration test to verify RED**

Run: `npm run test:integration -- test/integration/intake-alerts.test.js`

Expected: FAIL because the real alert router is absent.

- [ ] **Step 4: Implement atomic acceptance**

Use one `withTenant` callback. Generate the outbox ID in Node:

```js
async function acceptAlert({ db, metrics, auth, input }) {
  const result = await db.withTenant(auth.tenantId, async (client) => {
    const existing = await findByKey(client, auth.tenantId, input.idempotencyKey);
    if (existing) return replayOrConflict(existing, input);

    const inserted = await client.query(INSERT_ALERT_ON_CONFLICT_SQL, [
      auth.tenantId, auth.userId, input.title, input.body, input.priority,
      input.channels, input.target, input.idempotencyKey,
    ]);
    if (inserted.rows.length === 0) {
      return replayOrConflict(
        await findByKey(client, auth.tenantId, input.idempotencyKey), input
      );
    }

    const alertId = inserted.rows[0].id;
    const eventId = randomUUID();
    await client.query(
      'INSERT INTO idempotency_keys (key, tenant_id, alert_id) VALUES ($1, $2, $3)',
      [input.idempotencyKey, auth.tenantId, alertId]
    );
    await client.query(
      `INSERT INTO alert_outbox (id, tenant_id, alert_id, payload)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [eventId, auth.tenantId, alertId,
        JSON.stringify({ eventId, alertId, tenantId: auth.tenantId })]
    );
    return { alertId, idempotencyKey: input.idempotencyKey, replayed: false, created: true };
  });
  if (result.created) metrics.intakeAcceptedTotal.inc({ tenant_id: auth.tenantId });
  return { alertId: result.alertId, idempotencyKey: result.idempotencyKey, replayed: result.replayed };
}
```

`INSERT_ALERT_ON_CONFLICT_SQL` ends with
`ON CONFLICT (tenant_id, idempotency_key) DO NOTHING RETURNING id`.
`findByKey` joins key to alert with explicit tenant predicates.
`replayOrConflict` compares exact title/body/priority, canonical channels, and
structural JSON target. It returns replay state or throws
`409 idempotency_key_reused`.

The POST handler reads `req.get('Idempotency-Key')`, validates body/header,
calls `acceptAlert`, attaches `alert_id` to its child logger, and returns 202.

- [ ] **Step 5: Verify and commit**

Run:

```bash
npm run test:integration -- test/integration/intake-alerts.test.js
npm test
npm run test:integration
npm run lint
```

Expected: all commands exit 0.

```bash
git add src/intake/alerts.js src/intake/app.js src/intake/app.test.js test/integration/support/intake.js test/integration/intake-alerts.test.js
git commit -m "feat: accept alerts with durable idempotency"
```

---

### Task 6: Tenant-scoped alert, delivery, and group reads

**Files:**
- Modify: `src/intake/alerts.js`
- Create: `src/intake/groups.js`
- Create: `test/integration/intake-reads.test.js`
- Modify: `src/intake/app.js`

**Interfaces:**
- Consumes: `db.withTenant`, `parseUuidParam`, `AppError`, and `asyncHandler`.
- Produces: four GET routes plus `listAlerts`, `getAlertDetail`, `listDeliveries`, and `listGroups`.

- [ ] **Step 1: Write failing read integration tests**

Seed two tenants, users, groups including an empty group, memberships, alerts,
recipients, and deliveries. Assert:

- Alert list returns only the tenant, ordered `acceptedAt DESC, id DESC`, with exact fields.
- Detail has approved fields and numeric grouped counts ordered `pending`,
  `delivered`, `failed`, `rate_limited`, `timed_out`.
- An alert without deliveries has `deliveryCounts: []`.
- Deliveries include recipient names/numeric attempts, ordered name/channel/ID.
- Empty groups appear with numeric `memberCount: 0`, ordered name/ID.
- Invalid UUIDs return 400.
- Missing and cross-tenant IDs return identical 404 bodies for both alert routes.

- [ ] **Step 2: Run the test to verify RED**

Run: `npm run test:integration -- test/integration/intake-reads.test.js`

Expected: FAIL with absent-route 404s.

- [ ] **Step 3: Implement reads**

Use explicit aliases and deterministic SQL:

```sql
ORDER BY accepted_at DESC, id DESC
ORDER BY r.name ASC, d.channel ASC, d.id ASC
ORDER BY g.name ASC, g.id ASC
```

Normalize counts with `Number(row.count)` and status ordering:

```js
const STATUS_ORDER = ['pending', 'delivered', 'failed', 'rate_limited', 'timed_out'];
const rank = new Map(STATUS_ORDER.map((status, index) => [status, index]));
return rows
  .map(({ status, count }) => ({ status, count: Number(count) }))
  .sort((a, b) => rank.get(a.status) - rank.get(b.status));
```

For detail/deliveries, check the alert first and throw
`new AppError(404, 'not_found', 'Alert not found')` when invisible. Keep the
existence and related-row queries in one tenant transaction.

- [ ] **Step 4: Verify and commit**

Run:

```bash
npm run test:integration -- test/integration/intake-reads.test.js
npm test
npm run test:integration
npm run lint
```

Expected: all commands exit 0.

```bash
git add src/intake/alerts.js src/intake/groups.js src/intake/app.js test/integration/intake-reads.test.js
git commit -m "feat: add tenant-scoped intake reads"
```

### Task 7: Outbox claim/publish/record loop

**Files:**
- Modify: `src/shared/queue.js`
- Modify: `src/shared/queue.test.js`
- Create: `src/intake/outbox.js`
- Create: `src/intake/outbox.test.js`
- Create: `test/integration/intake-outbox-publisher.test.js`

**Interfaces:**
- Consumes: `db.pool`, `db.withTenant`, `sendMessage`, logger, and injectable sleep.
- Produces: optional-abort `sendMessage`, `retryDelaySeconds`, `createOutboxStore`, and `createOutboxPublisher`. Publisher returns `{ start(), stop(), abort(), done }`.

- [ ] **Step 1: Write the failing queue abort test**

Extend `src/shared/queue.test.js`:

```js
test('sendMessage forwards an optional abort signal', async () => {
  const signal = new AbortController().signal;
  const calls = [];
  const client = {
    send(command, options) { calls.push({ command, options }); return Promise.resolve({}); },
  };
  await sendMessage(client, 'http://queue/alert-fanout', { eventId: 'e-1' }, { abortSignal: signal });
  assert.equal(calls[0].options.abortSignal, signal);
});
```

- [ ] **Step 2: Write failing publisher unit tests**

In `src/intake/outbox.test.js`, assert:

- `retryDelaySeconds(1..8)` is `1,2,4,8,16,32,60,60`.
- One claim sends its exact payload and records success.
- Send failure records failure and the loop continues.
- `stop()` prevents new claims and waits for an active send.
- `abort()` aborts the active signal and records neither success nor failure.
- No-work polling invokes injected sleep with 500 ms.
- Stop interrupts idle sleep so no timer keeps Node alive.
- Tenant iteration is round-robin and claims at most one row per tenant per pass.

Use deterministic store/send fakes; do not use real timers or SQS.

- [ ] **Step 3: Write failing store integration tests**

In `test/integration/intake-outbox-publisher.test.js`, seed outbox rows and assert:

1. `listTenantIds()` reads tenant-root IDs.
2. `claimNext()` assigns a UUID token and a 60-second lease.
3. A simultaneous second claim does not receive the leased event.
4. An expired claim is reclaimable with a different token.
5. Matching-token success sets `published_at` and clears the claim.
6. Matching-token failure increments attempts, truncates error text to 1,000
   code points, sets exact capped backoff, and clears the claim.
7. A stale token cannot update the row.
8. Tenant A cannot claim or record results on tenant B's row.

- [ ] **Step 4: Run focused tests to verify RED**

Run:

```bash
node --test src/shared/queue.test.js src/intake/outbox.test.js
npm run test:integration -- test/integration/intake-outbox-publisher.test.js
```

Expected: FAIL because abort forwarding and outbox code are absent.

- [ ] **Step 5: Extend `sendMessage` compatibly**

```js
async function sendMessage(client, queueUrl, body, { abortSignal } = {}) {
  const command = new SendMessageCommand({
    QueueUrl: queueUrl,
    MessageBody: JSON.stringify(body),
  });
  return client.send(command, abortSignal ? { abortSignal } : undefined);
}
```

Existing three-argument calls remain valid.

- [ ] **Step 6: Implement short-transaction store methods**

`claimNext` runs this in one `withTenant` callback:

```sql
WITH candidate AS (
  SELECT id
  FROM alert_outbox
  WHERE tenant_id = $1
    AND published_at IS NULL
    AND available_at <= now()
    AND (claim_token IS NULL OR claimed_until <= now())
  ORDER BY available_at, created_at, id
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
UPDATE alert_outbox AS o
SET claim_token = $2, claimed_until = now() + interval '60 seconds'
FROM candidate
WHERE o.id = candidate.id AND o.tenant_id = $1
RETURNING o.id, o.tenant_id, o.alert_id, o.payload, o.attempt_count,
          o.claim_token, o.claimed_until;
```

`recordSuccess` and `recordFailure` use separate `withTenant` calls and guard
with `id`, `tenant_id`, matching `claim_token`, and `published_at IS NULL`.
Return a boolean indicating token match. Truncate with
`Array.from(errorText).slice(0, 1000).join('')`.

`listTenantIds()` alone uses `db.pool.query('SELECT id FROM tenants ORDER BY id')`,
the documented operational escape hatch.

- [ ] **Step 7: Implement the publisher**

The publisher owns an `AbortController` only during `send`. `stop()` sets the
stop flag, interrupts idle sleep, and resolves after the active send/result
record finishes. `abort()` aborts the send and marks that claim so the loop
records neither success nor failure; its existing DB lease expires naturally.

Production supplies:

```js
send: (claim, { abortSignal }) =>
  sendMessage(queueClient, alertFanoutQueueUrl, claim.payload, { abortSignal })
```

- [ ] **Step 8: Verify and commit**

Run:

```bash
node --test src/shared/queue.test.js src/intake/outbox.test.js
npm run test:integration -- test/integration/intake-outbox-publisher.test.js
npm test
npm run test:integration
npm run lint
```

Expected: all commands exit 0.

```bash
git add src/shared/queue.js src/shared/queue.test.js src/intake/outbox.js src/intake/outbox.test.js test/integration/intake-outbox-publisher.test.js
git commit -m "feat: publish alert outbox events"
```

---

### Task 8: Production entrypoint and graceful shutdown

**Files:**
- Create: `src/intake/lifecycle.js`
- Create: `src/intake/lifecycle.test.js`
- Create: `src/intake/index.js`

**Interfaces:**
- Consumes: shared factories, `createApp`, `createReadiness`, `createOutboxStore`, and `createOutboxPublisher`.
- Produces: `createShutdownCoordinator` and runnable `npm run intake`.

- [ ] **Step 1: Write failing lifecycle tests**

Using fakes and controllable timers, assert:

1. First `shutdown()` marks unready, stops publisher claims, closes the server,
   waits for HTTP/publisher completion, closes pool, destroys SQS, and never
   calls forced exit.
2. Concurrent first-signal calls share one promise and do not repeat cleanup.
3. At 25 seconds, it aborts the publisher, calls available
   `closeIdleConnections()`/`closeAllConnections()`, starts best-effort cleanup,
   and calls injected `forceExit(1)`.
4. Timeout abort relies on the publisher contract not to record the claim.
5. `force()` immediately invokes `forceExit(1)` for a second signal.
6. Cleanup rejection is logged and forces nonzero exit.

- [ ] **Step 2: Run lifecycle tests to verify RED**

Run: `node --test src/intake/lifecycle.test.js`

Expected: FAIL because `lifecycle.js` does not exist.

- [ ] **Step 3: Implement the shutdown coordinator**

Memoize `shutdown()`. Normal flow:

```js
readiness.beginShutdown();
const publisherDone = publisher.stop();
const serverDone = closeServer(server);
await Promise.race([Promise.all([publisherDone, serverDone]), deadline]);
await pool.end();
queueClient.destroy();
```

The deadline branch calls `publisher.abort()`, closes idle/all sockets when APIs
exist, initiates best-effort cleanup, and calls `forceExit(1)`. It never marks
the aborted outbox row. Do not call `process.exit(0)` on normal completion.

- [ ] **Step 4: Implement `index.js` composition**

```js
const config = loadConfig();
const logger = createLogger('intake', { level: config.logLevel });
const metrics = createMetrics();
const pool = createPool(config.appDatabaseUrl);
const db = createDb(pool);
const queueClient = createQueueClient({ region: config.aws.region, endpoint: config.aws.sqsEndpoint });
const readiness = createReadiness();
const app = createApp({ db, metrics, logger, jwtSecret: config.jwtSecret, readiness });
const store = createOutboxStore({ db });
const publisher = createOutboxPublisher({
  store,
  logger,
  send: (claim, { abortSignal }) =>
    sendMessage(queueClient, config.queues.alertFanoutUrl, claim.payload, { abortSignal }),
});
const server = app.listen(config.port, () => logger.info({ port: config.port }, 'intake listening'));
publisher.start();
```

Create the coordinator with `graceMs: 25_000` and `forceExit: process.exit`.
Register one handler for both signals; the first calls `shutdown()`, the second
calls `force()`. Startup errors are logged, created resources are cleaned up,
and `process.exitCode = 1` is set rather than masking the failure.

- [ ] **Step 5: Verify and smoke-test**

Run:

```bash
node --test src/intake/lifecycle.test.js src/intake/app.test.js src/intake/outbox.test.js
node --check src/intake/index.js
npm test
npm run lint
```

Then start `npm run intake` with `.env`, request `/healthz`, and send one
SIGTERM using a bounded shell session. Expected: 200 health response and normal
shutdown logs without forced exit. PostgreSQL must be available; if ElasticMQ
is unavailable, publisher retries may log but HTTP startup/shutdown still work.

- [ ] **Step 6: Commit**

```bash
git add src/intake/lifecycle.js src/intake/lifecycle.test.js src/intake/index.js
git commit -m "feat: run and gracefully stop intake service"
```

---

### Task 9: Whole-slice acceptance and repository-state documentation

**Files:**
- Modify: `test/integration/intake-outbox-publisher.test.js`
- Modify: `../CLAUDE.md`
- Modify: `../README.md`
- Modify: intake files only if verification exposes an intake-scope defect.

**Interfaces:**
- Consumes: complete intake slice.
- Produces: end-to-end acceptance proof and accurate current-state documentation.

- [ ] **Step 1: Add the complete async-boundary acceptance test**

Extend `test/integration/intake-outbox-publisher.test.js` with one test that:

1. POSTs through the real app and real `app_user` DB.
2. Receives 202 before publication.
3. Runs one publisher iteration with fake SQS send.
4. Asserts exactly `{ eventId, alertId, tenantId }` was sent once.
5. Asserts `published_at` is set and the claim cleared.
6. Replays the POST and runs another iteration.
7. Asserts no second row or SQS send exists.

- [ ] **Step 2: Run the acceptance test**

Run: `npm run test:integration -- test/integration/intake-outbox-publisher.test.js`

Expected: PASS. If it fails, correct only the demonstrated intake defect and
rerun this command before continuing.

- [ ] **Step 3: Update documentation**

Update `../CLAUDE.md` to say intake is implemented/runnable, list endpoints,
describe the durable publisher, and retain that fanout/dispatch/stubs/web/seed/
Docker remain absent.

Update `../README.md` with the real commands:

```text
npm test
npm run test:integration
npm run lint
npm run migrate up
npm run intake
```

State that intake currently expects PostgreSQL, its configured SQS-compatible
endpoint, and a caller-supplied JWT. Do not claim Compose or token generation.

- [ ] **Step 4: Run fresh whole-slice verification**

Run:

```bash
npm test
npm run test:integration
npm run lint
git diff --check
```

Expected: every command exits 0 and `git diff --check` prints nothing.

- [ ] **Step 5: Review the complete intake diff**

Run:

```bash
git diff 82389d5..HEAD --stat
git diff 82389d5..HEAD -- docs/APP_SPEC.md ../CLAUDE.md ../README.md migrations src test
```

Verify explicitly:

- Production intake uses only `appDatabaseUrl`.
- Tenant-owned queries use `withTenant`.
- POST commits alert/key/outbox atomically and never waits for SQS.
- Replays never create another outbox row.
- Publisher SQS I/O occurs outside DB transactions.
- Aborted sends are not recorded and claims expire naturally.
- Cross-tenant IDs return 404.
- Shutdown has first-signal graceful and second-signal forced behavior.
- No excluded subsystem or formal PR machinery appears.

- [ ] **Step 6: Commit final documentation and acceptance coverage**

```bash
git add ../CLAUDE.md ../README.md test/integration/intake-outbox-publisher.test.js
git commit -m "docs: record functional intake service"
```

If verification required production changes, commit each focused correction
separately with a `fix:` message before this documentation commit.

---

## Completion Criteria

- Every APP_SPEC section 5 endpoint has its approved response and error shape.
- Application/database tenant-isolation tests pass through `app_user`.
- Alert, idempotency, and outbox writes are atomic.
- Publication is durable and at least once with stable event IDs.
- Graceful-shutdown tests and the bounded smoke test pass.
- `npm test`, `npm run test:integration`, `npm run lint`, and
  `git diff --check` pass at the stopping point.
- Documentation distinguishes implemented intake functionality from deferred
  services and local-development tooling.
