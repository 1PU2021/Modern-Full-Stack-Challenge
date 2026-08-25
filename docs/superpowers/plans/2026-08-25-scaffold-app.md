# Repo Scaffold + Shared Modules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the repo skeleton and `package.json` from `docs/APP_SPEC.md` section 3, then build the five `src/shared/` modules (config, logger, metrics, queue, db) that the four service entrypoints (intake, fanout, dispatch, stubs) will depend on. Service entrypoints themselves, migrations, Docker/compose, and the web app are explicitly **out of scope** for this plan — they come after.

**Architecture:** Single Node.js 20, CommonJS, single-package repo (per spec section 3). Each `src/shared/*` module is a small, dependency-injectable wrapper around one concern (env config via Zod, structured logging via pino, metrics via prom-client, SQS access via `@aws-sdk/client-sqs`, an RLS-aware Postgres pool via `pg`) so it can be unit-tested without a running Postgres/SQS/ElasticMQ instance. Every module exports factory functions, not singletons, so tests can inject fakes and entrypoints (built later) can inject real clients built from config.

**Tech Stack:** Node.js >=20, Express (added later with intake), Zod, pino, prom-client, `@aws-sdk/client-sqs`, `pg`, `jsonwebtoken` (added now as a dependency per the spec's stack table, wired up later with intake), Node's built-in `node:test` runner (zero extra test-framework dependency), ESLint 9 flat config.

## Global Constraints

- Node.js 20, JavaScript, **CommonJS** (`require`/`module.exports`), not ESM — per spec section 2 stack table.
- One `package.json` for the whole repo (single package, four backend entrypoints) — per spec section 3.
- License: MIT, copyright `1PU2021` — matches the existing root `LICENSE` file. Use `"license": "MIT"` in `package.json`.
- `src/shared/` owns: config, db (RLS-aware pool), queue, logger, metrics — per spec section 3's repo layout. Nothing tenant-request-specific lives here.
- Tenant isolation for DB access is structural, not optional: every tenant-scoped query must run inside a transaction that has called `SET LOCAL app.current_tenant = <tenant_id>` (spec section 4). Since Postgres's `SET LOCAL` does not accept bind parameters, use the equivalent parameterized form `SELECT set_config('app.current_tenant', $1, true)` instead of string-interpolating the tenant id.
- Metrics must use exactly these names (spec section 2's golden-signals map), not renamed variants: `alert_intake_to_delivery_seconds`, `alert_intake_accepted_total`, `alert_intake_rejected_total`, `dispatch_delivery_outcome_total`, `queue_backlog_depth`.
- No secrets or credentials committed. `.env.example` documents variable names only, never real values.
- Every module in this plan must have unit tests that run with zero external services (no live Postgres/SQS required) — later integration/E2E tests against real Postgres/ElasticMQ are a separate future plan once `docker-compose.yml` exists.

---

## File Structure

```
/
├── package.json                  # Task 1
├── .gitignore                    # Task 1
├── eslint.config.js              # Task 1
├── .env.example                  # Task 2 (grows as later tasks add vars)
├── src/
│   └── shared/
│       ├── config.js             # Task 2
│       ├── config.test.js        # Task 2
│       ├── logger.js             # Task 3
│       ├── logger.test.js        # Task 3
│       ├── metrics.js            # Task 4
│       ├── metrics.test.js       # Task 4
│       ├── queue.js              # Task 5
│       ├── queue.test.js         # Task 5
│       ├── db.js                 # Task 6
│       └── db.test.js            # Task 6
```

Empty placeholder directories created in Task 1 for the section-3 layout that later plans fill in (`src/intake/`, `src/fanout/`, `src/dispatch/`, `src/stubs/`, `web/`, `migrations/`, `scripts/`) each get a `.gitkeep` so the skeleton is visible in git before those plans land.

---

### Task 1: Repo skeleton + package.json + tooling

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `eslint.config.js`
- Create: `src/shared/.gitkeep` (removed automatically once Task 2 adds real files there)
- Create: `src/intake/.gitkeep`
- Create: `src/fanout/.gitkeep`
- Create: `src/dispatch/.gitkeep`
- Create: `src/stubs/.gitkeep`
- Create: `web/.gitkeep`
- Create: `migrations/.gitkeep`
- Create: `scripts/.gitkeep`

**Interfaces:**
- Produces: `npm test` (runs `node --test`, which recursively discovers `*.test.js` files from the cwd — note that `node --test src` does *not* work in Node 20/22: a bare directory positional argument is resolved as a module path, not globbed, and errors with `MODULE_NOT_FOUND`), `npm run lint` (runs `eslint .`), and `npm run intake` / `fanout` / `dispatch` / `stubs` script names that later tasks' entrypoints must satisfy (`node src/<name>/index.js`).

- [ ] **Step 1: Create the directory skeleton**

```bash
mkdir -p src/shared src/intake src/fanout src/dispatch src/stubs web migrations scripts
touch src/intake/.gitkeep src/fanout/.gitkeep src/dispatch/.gitkeep src/stubs/.gitkeep web/.gitkeep migrations/.gitkeep scripts/.gitkeep
```

- [ ] **Step 2: Write `package.json`**

```json
{
  "name": "critical-notification-platform",
  "version": "0.1.0",
  "private": true,
  "description": "Critical Notification Platform — intake, fanout, and dispatch of multi-channel alerts, scoped per-tenant.",
  "license": "MIT",
  "engines": {
    "node": ">=20.0.0"
  },
  "scripts": {
    "intake": "node src/intake/index.js",
    "fanout": "node src/fanout/index.js",
    "dispatch": "node src/dispatch/index.js",
    "stubs": "node src/stubs/index.js",
    "migrate": "node-pg-migrate",
    "seed": "node scripts/seed.js",
    "test": "node --test",
    "lint": "eslint ."
  },
  "dependencies": {
    "@aws-sdk/client-sqs": "^3.637.0",
    "express": "^4.21.0",
    "jsonwebtoken": "^9.0.2",
    "pg": "^8.12.0",
    "pino": "^9.4.0",
    "prom-client": "^15.1.3",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "eslint": "^9.9.1",
    "node-pg-migrate": "^7.6.1"
  }
}
```

- [ ] **Step 3: Write `.gitignore`**

```
node_modules/
.env
*.log
coverage/
dist/
web/dist/
web/node_modules/
```

- [ ] **Step 4: Write `eslint.config.js`**

```js
'use strict';

module.exports = [
  {
    ignores: ['node_modules/**', 'web/**'],
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: {
        module: 'writable',
        require: 'readonly',
        process: 'readonly',
        console: 'readonly',
        __dirname: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': 'error',
      'no-undef': 'error',
    },
  },
];
```

- [ ] **Step 5: Install dependencies**

Run: `npm install`
Expected: completes with no errors, creates `package-lock.json` and `node_modules/`.

- [ ] **Step 6: Verify the test and lint scripts run clean with zero source files**

Run: `npm test`
Expected: `node --test` reports 0 tests found, exit code 0 (no test files exist yet).

Run: `npm run lint`
Expected: exits 0 (no `.js` source files under lint yet besides `eslint.config.js` itself, which must itself pass).

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json .gitignore eslint.config.js src web migrations scripts
git commit -m "chore: scaffold repo layout and package.json"
```

---

### Task 2: `src/shared/config.js`

**Files:**
- Create: `src/shared/config.js`
- Create: `src/shared/config.test.js`
- Create: `.env.example`

**Interfaces:**
- Produces: `loadConfig(env = process.env)` → returns
  ```
  {
    nodeEnv: string,
    port: number,
    logLevel: string,
    databaseUrl: string,
    aws: { region: string, sqsEndpoint: string|undefined },
    queues: { alertFanoutUrl: string, recipientDispatchUrl: string },
    jwtSecret: string,
    providers: { smsUrl: string, emailUrl: string },
    maxDeliveryAttempts: number,
  }
  ```
  Throws `Error` with a message listing every missing/invalid field when required env vars are absent. Later tasks (logger, metrics, queue, db, and eventually the four entrypoints) call `loadConfig()` once at startup and read from the returned object — never `process.env` directly outside this module.

- [ ] **Step 1: Write the failing tests**

Create `src/shared/config.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('./config');

const baseEnv = {
  DATABASE_URL: 'postgres://app_user:pw@localhost:5432/notifications',
  ALERT_FANOUT_QUEUE_URL: 'http://localhost:9324/queue/alert-fanout',
  RECIPIENT_DISPATCH_QUEUE_URL: 'http://localhost:9324/queue/recipient-dispatch',
  JWT_SECRET: 'dev-secret',
};

test('loadConfig applies defaults for optional values', () => {
  const config = loadConfig(baseEnv);
  assert.equal(config.nodeEnv, 'development');
  assert.equal(config.port, 3000);
  assert.equal(config.logLevel, 'info');
  assert.equal(config.maxDeliveryAttempts, 5);
  assert.equal(config.aws.region, 'us-east-1');
  assert.equal(config.aws.sqsEndpoint, undefined);
});

test('loadConfig maps required and overridden values through', () => {
  const config = loadConfig({ ...baseEnv, PORT: '4100', NODE_ENV: 'production' });
  assert.equal(config.databaseUrl, baseEnv.DATABASE_URL);
  assert.equal(config.queues.alertFanoutUrl, baseEnv.ALERT_FANOUT_QUEUE_URL);
  assert.equal(config.queues.recipientDispatchUrl, baseEnv.RECIPIENT_DISPATCH_QUEUE_URL);
  assert.equal(config.jwtSecret, 'dev-secret');
  assert.equal(config.port, 4100);
  assert.equal(config.nodeEnv, 'production');
});

test('loadConfig throws a readable error listing every missing required var', () => {
  assert.throws(
    () => loadConfig({}),
    (err) => {
      assert.match(err.message, /DATABASE_URL is required/);
      assert.match(err.message, /ALERT_FANOUT_QUEUE_URL is required/);
      assert.match(err.message, /RECIPIENT_DISPATCH_QUEUE_URL is required/);
      assert.match(err.message, /JWT_SECRET is required/);
      return true;
    }
  );
});

test('loadConfig rejects an invalid NODE_ENV rather than silently defaulting', () => {
  assert.throws(() => loadConfig({ ...baseEnv, NODE_ENV: 'staging' }));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module './config'`.

- [ ] **Step 3: Write `src/shared/config.js`**

```js
'use strict';

const { z } = require('zod');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  AWS_REGION: z.string().default('us-east-1'),
  SQS_ENDPOINT: z.string().optional(),
  ALERT_FANOUT_QUEUE_URL: z.string().min(1, 'ALERT_FANOUT_QUEUE_URL is required'),
  RECIPIENT_DISPATCH_QUEUE_URL: z.string().min(1, 'RECIPIENT_DISPATCH_QUEUE_URL is required'),
  JWT_SECRET: z.string().min(1, 'JWT_SECRET is required'),
  SMS_PROVIDER_URL: z.string().default('http://localhost:4000'),
  EMAIL_PROVIDER_URL: z.string().default('http://localhost:4001'),
  MAX_DELIVERY_ATTEMPTS: z.coerce.number().int().positive().default(5),
});

function loadConfig(env = process.env) {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid configuration: ${details}`);
  }

  const data = parsed.data;
  return {
    nodeEnv: data.NODE_ENV,
    port: data.PORT,
    logLevel: data.LOG_LEVEL,
    databaseUrl: data.DATABASE_URL,
    aws: {
      region: data.AWS_REGION,
      sqsEndpoint: data.SQS_ENDPOINT,
    },
    queues: {
      alertFanoutUrl: data.ALERT_FANOUT_QUEUE_URL,
      recipientDispatchUrl: data.RECIPIENT_DISPATCH_QUEUE_URL,
    },
    jwtSecret: data.JWT_SECRET,
    providers: {
      smsUrl: data.SMS_PROVIDER_URL,
      emailUrl: data.EMAIL_PROVIDER_URL,
    },
    maxDeliveryAttempts: data.MAX_DELIVERY_ATTEMPTS,
  };
}

module.exports = { loadConfig };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, all 5 tests green.

- [ ] **Step 5: Write `.env.example`**

```
NODE_ENV=development
PORT=3000
LOG_LEVEL=info

DATABASE_URL=postgres://app_user:app_user@localhost:5432/notifications

AWS_REGION=us-east-1
SQS_ENDPOINT=http://localhost:9324
ALERT_FANOUT_QUEUE_URL=http://localhost:9324/queue/alert-fanout
RECIPIENT_DISPATCH_QUEUE_URL=http://localhost:9324/queue/recipient-dispatch

JWT_SECRET=dev-secret-change-me

SMS_PROVIDER_URL=http://localhost:4000
EMAIL_PROVIDER_URL=http://localhost:4001

MAX_DELIVERY_ATTEMPTS=5
```

- [ ] **Step 6: Lint and commit**

Run: `npm run lint`
Expected: exits 0.

```bash
git add src/shared/config.js src/shared/config.test.js .env.example
git commit -m "feat: add shared config module"
```

---

### Task 3: `src/shared/logger.js`

**Files:**
- Create: `src/shared/logger.js`
- Create: `src/shared/logger.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks (deliberately independent of `config.js` — callers pass the level explicitly, since `config.js` may not be loadable in every context, e.g. a script printing a config error before a logger exists).
- Produces: `createLogger(service, { level = 'info' } = {})` → a pino logger instance whose `.bindings()` include `{ service }`. Later tasks (db, queue, and eventually every entrypoint) call `createLogger('<service-name>', { level: config.logLevel })` and use `logger.child({ tenant_id, alert_id, channel })` for request-scoped fields, per spec section 2's structured-logging requirement.

- [ ] **Step 1: Write the failing tests**

Create `src/shared/logger.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLogger } = require('./logger');

test('createLogger tags every log line with the service name', () => {
  const logger = createLogger('intake');
  assert.equal(logger.bindings().service, 'intake');
});

test('createLogger defaults to info level', () => {
  const logger = createLogger('intake');
  assert.equal(logger.level, 'info');
});

test('createLogger honors an explicit level', () => {
  const logger = createLogger('dispatch', { level: 'debug' });
  assert.equal(logger.level, 'debug');
});

test('createLogger children carry request-scoped fields alongside the service name', () => {
  const logger = createLogger('intake');
  const child = logger.child({ tenant_id: 't-1', alert_id: 'a-1', channel: 'sms' });
  assert.equal(child.bindings().tenant_id, 't-1');
  assert.equal(child.bindings().alert_id, 'a-1');
  assert.equal(child.bindings().channel, 'sms');
  assert.equal(child.bindings().service, 'intake');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module './logger'`.

- [ ] **Step 3: Write `src/shared/logger.js`**

```js
'use strict';

const pino = require('pino');

function createLogger(service, { level = 'info' } = {}) {
  return pino({
    level,
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

module.exports = { createLogger };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, all 4 tests green (9 cumulative with Task 2).

- [ ] **Step 5: Lint and commit**

Run: `npm run lint`
Expected: exits 0.

```bash
git add src/shared/logger.js src/shared/logger.test.js
git commit -m "feat: add shared logger module"
```

---

### Task 4: `src/shared/metrics.js`

**Files:**
- Create: `src/shared/metrics.js`
- Create: `src/shared/metrics.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `createMetrics()` → a fresh, isolated set of metrics (new `prom-client` `Registry` per call, so tests and — later — each service process don't collide on the default global registry):
  ```
  {
    register: prom-client Registry,
    intakeToDeliverySeconds: Histogram(labels: channel),
    intakeAcceptedTotal: Counter(labels: tenant_id),
    intakeRejectedTotal: Counter(labels: reason),
    deliveryOutcomeTotal: Counter(labels: channel, outcome),
    queueBacklogDepth: Gauge(labels: queue),
  }
  ```
  Later tasks (fanout/dispatch entrypoints) call `metrics.queueBacklogDepth.set({ queue: 'alert-fanout' }, depth)` using the depth returned by `queue.js`'s `getQueueDepth`. The intake entrypoint mounts `metrics.register.metrics()` at `GET /metrics` per spec section 5's API contract.

- [ ] **Step 1: Write the failing tests**

Create `src/shared/metrics.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMetrics } = require('./metrics');

test('createMetrics registers all four required metrics on an isolated registry', async () => {
  const metrics = createMetrics();
  const text = await metrics.register.metrics();
  assert.match(text, /alert_intake_to_delivery_seconds/);
  assert.match(text, /alert_intake_accepted_total/);
  assert.match(text, /alert_intake_rejected_total/);
  assert.match(text, /dispatch_delivery_outcome_total/);
  assert.match(text, /queue_backlog_depth/);
});

test('intakeAcceptedTotal increments per tenant', async () => {
  const metrics = createMetrics();
  metrics.intakeAcceptedTotal.inc({ tenant_id: 't-1' });
  metrics.intakeAcceptedTotal.inc({ tenant_id: 't-1' });
  const value = await metrics.register.getSingleMetricAsString('alert_intake_accepted_total');
  assert.match(value, /tenant_id="t-1"\} 2/);
});

test('intakeToDeliverySeconds observes durations by channel', async () => {
  const metrics = createMetrics();
  metrics.intakeToDeliverySeconds.observe({ channel: 'sms' }, 1.5);
  const value = await metrics.register.getSingleMetricAsString('alert_intake_to_delivery_seconds');
  assert.match(value, /channel="sms"/);
});

test('deliveryOutcomeTotal is labeled by channel and outcome', async () => {
  const metrics = createMetrics();
  metrics.deliveryOutcomeTotal.inc({ channel: 'email', outcome: 'delivered' });
  const value = await metrics.register.getSingleMetricAsString('dispatch_delivery_outcome_total');
  assert.match(value, /channel="email",outcome="delivered"\} 1/);
});

test('queueBacklogDepth is settable per queue', async () => {
  const metrics = createMetrics();
  metrics.queueBacklogDepth.set({ queue: 'alert-fanout' }, 42);
  const value = await metrics.register.getSingleMetricAsString('queue_backlog_depth');
  assert.match(value, /queue="alert-fanout"\} 42/);
});

test('two createMetrics() calls do not share state', async () => {
  const a = createMetrics();
  const b = createMetrics();
  a.intakeAcceptedTotal.inc({ tenant_id: 't-1' });
  const bValue = await b.register.getSingleMetricAsString('alert_intake_accepted_total');
  assert.doesNotMatch(bValue, /tenant_id="t-1"/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module './metrics'`.

- [ ] **Step 3: Write `src/shared/metrics.js`**

```js
'use strict';

const client = require('prom-client');

function createMetrics() {
  const register = new client.Registry();
  client.collectDefaultMetrics({ register });

  const intakeToDeliverySeconds = new client.Histogram({
    name: 'alert_intake_to_delivery_seconds',
    help: 'Time from alert intake acceptance to a delivery reaching a terminal state',
    labelNames: ['channel'],
    buckets: [0.5, 1, 2, 5, 10, 30, 60, 120, 300],
    registers: [register],
  });

  const intakeAcceptedTotal = new client.Counter({
    name: 'alert_intake_accepted_total',
    help: 'Count of alerts accepted at intake',
    labelNames: ['tenant_id'],
    registers: [register],
  });

  const intakeRejectedTotal = new client.Counter({
    name: 'alert_intake_rejected_total',
    help: 'Count of alerts rejected at intake validation',
    labelNames: ['reason'],
    registers: [register],
  });

  const deliveryOutcomeTotal = new client.Counter({
    name: 'dispatch_delivery_outcome_total',
    help: 'Count of delivery attempts by terminal outcome',
    labelNames: ['channel', 'outcome'],
    registers: [register],
  });

  const queueBacklogDepth = new client.Gauge({
    name: 'queue_backlog_depth',
    help: 'Approximate number of visible messages waiting in a queue',
    labelNames: ['queue'],
    registers: [register],
  });

  return {
    register,
    intakeToDeliverySeconds,
    intakeAcceptedTotal,
    intakeRejectedTotal,
    deliveryOutcomeTotal,
    queueBacklogDepth,
  };
}

module.exports = { createMetrics };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, all 6 tests green (15 cumulative).

- [ ] **Step 5: Lint and commit**

Run: `npm run lint`
Expected: exits 0.

```bash
git add src/shared/metrics.js src/shared/metrics.test.js
git commit -m "feat: add shared metrics module"
```

---

### Task 5: `src/shared/queue.js`

**Files:**
- Create: `src/shared/queue.js`
- Create: `src/shared/queue.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks (the SQS client itself is injected by the caller, built from `config.aws.region` / `config.aws.sqsEndpoint` at entrypoint startup — this module never calls `loadConfig()` itself).
- Produces:
  - `createQueueClient({ region, endpoint })` → an `SQSClient` (real `@aws-sdk/client-sqs` instance; same code path hits AWS SQS or ElasticMQ depending on whether `endpoint` is set, per spec section 2).
  - `sendMessage(client, queueUrl, body)` → JSON-encodes `body`, returns the SDK response.
  - `receiveMessages(client, queueUrl, { maxMessages, waitTimeSeconds, visibilityTimeout })` → returns `Message[]` (empty array, never `undefined`, when SQS has nothing).
  - `deleteMessage(client, queueUrl, receiptHandle)`.
  - `getQueueDepth(client, queueUrl)` → `Promise<number>`, the source the fanout/dispatch entrypoints later feed into `metrics.queueBacklogDepth.set({ queue }, depth)`.
  All four operation functions accept `client` as their first argument (not a closed-over singleton) so tests inject a fake with a `send(command)` method instead of hitting real AWS/ElasticMQ.

- [ ] **Step 1: Write the failing tests**

Create `src/shared/queue.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  sendMessage,
  receiveMessages,
  deleteMessage,
  getQueueDepth,
} = require('./queue');

function fakeClient(responder) {
  const calls = [];
  return {
    calls,
    send(command) {
      calls.push(command);
      return Promise.resolve(responder(command));
    },
  };
}

test('sendMessage JSON-encodes the body and targets the given queue', async () => {
  const client = fakeClient(() => ({ MessageId: 'm-1' }));
  await sendMessage(client, 'http://queue/alert-fanout', { alertId: 'a-1' });

  assert.equal(client.calls.length, 1);
  const input = client.calls[0].input;
  assert.equal(input.QueueUrl, 'http://queue/alert-fanout');
  assert.equal(input.MessageBody, JSON.stringify({ alertId: 'a-1' }));
});

test('receiveMessages returns an empty array when SQS has nothing to deliver', async () => {
  const client = fakeClient(() => ({}));
  const messages = await receiveMessages(client, 'http://queue/alert-fanout');
  assert.deepEqual(messages, []);
});

test('receiveMessages passes through polling options', async () => {
  const client = fakeClient(() => ({ Messages: [{ Body: '{}' }] }));
  const messages = await receiveMessages(client, 'http://queue/alert-fanout', {
    maxMessages: 5,
    waitTimeSeconds: 2,
    visibilityTimeout: 30,
  });

  const input = client.calls[0].input;
  assert.equal(input.MaxNumberOfMessages, 5);
  assert.equal(input.WaitTimeSeconds, 2);
  assert.equal(input.VisibilityTimeout, 30);
  assert.equal(messages.length, 1);
});

test('deleteMessage targets the queue and receipt handle', async () => {
  const client = fakeClient(() => ({}));
  await deleteMessage(client, 'http://queue/alert-fanout', 'receipt-123');

  const input = client.calls[0].input;
  assert.equal(input.QueueUrl, 'http://queue/alert-fanout');
  assert.equal(input.ReceiptHandle, 'receipt-123');
});

test('getQueueDepth parses ApproximateNumberOfMessages as a number', async () => {
  const client = fakeClient(() => ({ Attributes: { ApproximateNumberOfMessages: '17' } }));
  const depth = await getQueueDepth(client, 'http://queue/alert-fanout');
  assert.equal(depth, 17);
});

test('getQueueDepth defaults to zero when the attribute is missing', async () => {
  const client = fakeClient(() => ({ Attributes: {} }));
  const depth = await getQueueDepth(client, 'http://queue/alert-fanout');
  assert.equal(depth, 0);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module './queue'`.

- [ ] **Step 3: Write `src/shared/queue.js`**

```js
'use strict';

const {
  SQSClient,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
} = require('@aws-sdk/client-sqs');

function createQueueClient({ region, endpoint }) {
  return new SQSClient({
    region,
    ...(endpoint ? { endpoint } : {}),
  });
}

async function sendMessage(client, queueUrl, body) {
  const command = new SendMessageCommand({
    QueueUrl: queueUrl,
    MessageBody: JSON.stringify(body),
  });
  return client.send(command);
}

async function receiveMessages(
  client,
  queueUrl,
  { maxMessages = 10, waitTimeSeconds = 10, visibilityTimeout } = {}
) {
  const command = new ReceiveMessageCommand({
    QueueUrl: queueUrl,
    MaxNumberOfMessages: maxMessages,
    WaitTimeSeconds: waitTimeSeconds,
    ...(visibilityTimeout !== undefined ? { VisibilityTimeout: visibilityTimeout } : {}),
  });
  const response = await client.send(command);
  return response.Messages || [];
}

async function deleteMessage(client, queueUrl, receiptHandle) {
  const command = new DeleteMessageCommand({
    QueueUrl: queueUrl,
    ReceiptHandle: receiptHandle,
  });
  return client.send(command);
}

async function getQueueDepth(client, queueUrl) {
  const command = new GetQueueAttributesCommand({
    QueueUrl: queueUrl,
    AttributeNames: ['ApproximateNumberOfMessages'],
  });
  const response = await client.send(command);
  return Number(response.Attributes?.ApproximateNumberOfMessages ?? 0);
}

module.exports = {
  createQueueClient,
  sendMessage,
  receiveMessages,
  deleteMessage,
  getQueueDepth,
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, all 7 tests green (22 cumulative).

- [ ] **Step 5: Lint and commit**

Run: `npm run lint`
Expected: exits 0.

```bash
git add src/shared/queue.js src/shared/queue.test.js
git commit -m "feat: add shared queue module"
```

---

### Task 6: `src/shared/db.js`

**Files:**
- Create: `src/shared/db.js`
- Create: `src/shared/db.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks (the `pg.Pool` is injected by the caller, built from `config.databaseUrl` at entrypoint startup — this module never calls `loadConfig()` itself).
- Produces:
  - `createPool(databaseUrl)` → a real `pg.Pool`.
  - `createDb(pool)` → `{ pool, withTenant(tenantId, fn) }`. `withTenant` validates `tenantId` looks like a UUID, acquires a client, wraps `fn(client)` in `BEGIN` / `SELECT set_config('app.current_tenant', $1, true)` / `COMMIT`, rolls back and rethrows on error, and always releases the client. Every later tenant-scoped query (intake, fanout, dispatch handlers) runs inside a `db.withTenant(tenantId, async (client) => { ... })` block — this is the single chokepoint spec section 4's RLS requirement depends on.

- [ ] **Step 1: Write the failing tests**

Create `src/shared/db.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDb } = require('./db');

function fakeClient() {
  const queries = [];
  let clientReleased = false;
  return {
    queries,
    isReleased: () => clientReleased,
    query(text, params) {
      queries.push({ text, params });
      return Promise.resolve({ rows: [] });
    },
    release() {
      clientReleased = true;
    },
  };
}

function fakePool(client) {
  return { connect: () => Promise.resolve(client) };
}

test('withTenant scopes the session to the tenant before running the callback', async () => {
  const client = fakeClient();
  const db = createDb(fakePool(client));

  await db.withTenant('11111111-1111-1111-1111-111111111111', async (c) => {
    assert.equal(c, client);
    return 'ok';
  });

  assert.equal(client.queries[0].text, 'BEGIN');
  assert.equal(client.queries[1].text, 'SELECT set_config($1, $2, true)');
  assert.deepEqual(client.queries[1].params, [
    'app.current_tenant',
    '11111111-1111-1111-1111-111111111111',
  ]);
  assert.equal(client.queries[2].text, 'COMMIT');
  assert.equal(client.isReleased(), true);
});

test('withTenant returns the callback result', async () => {
  const client = fakeClient();
  const db = createDb(fakePool(client));

  const result = await db.withTenant('11111111-1111-1111-1111-111111111111', async () => 42);
  assert.equal(result, 42);
});

test('withTenant rolls back and releases the client when the callback throws', async () => {
  const client = fakeClient();
  const db = createDb(fakePool(client));

  await assert.rejects(
    () =>
      db.withTenant('11111111-1111-1111-1111-111111111111', async () => {
        throw new Error('boom');
      }),
    /boom/
  );

  assert.equal(client.queries.at(-1).text, 'ROLLBACK');
  assert.equal(client.isReleased(), true);
});

test('withTenant rejects a malformed tenant id before touching the database', async () => {
  const client = fakeClient();
  const db = createDb(fakePool(client));

  await assert.rejects(
    () => db.withTenant('not-a-uuid', async () => 'unreachable'),
    /not a valid tenant id/
  );
  assert.equal(client.queries.length, 0);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module './db'`.

- [ ] **Step 3: Write `src/shared/db.js`**

```js
'use strict';

const { Pool } = require('pg');

const TENANT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function createPool(databaseUrl) {
  return new Pool({ connectionString: databaseUrl });
}

function createDb(pool) {
  async function withTenant(tenantId, fn) {
    if (!TENANT_ID_PATTERN.test(tenantId)) {
      throw new Error(`withTenant: "${tenantId}" is not a valid tenant id`);
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', ['app.current_tenant', tenantId]);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  return { pool, withTenant };
}

module.exports = { createPool, createDb };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, all 4 tests green (26 cumulative).

- [ ] **Step 5: Lint and commit**

Run: `npm run lint`
Expected: exits 0.

```bash
git add src/shared/db.js src/shared/db.test.js
git commit -m "feat: add shared db module"
```

---

## Out of scope for this plan (do not implement here)

- `src/intake/`, `src/fanout/`, `src/dispatch/`, `src/stubs/` entrypoint code.
- `migrations/` content, `scripts/seed.js`, `scripts/generate-dev-token.js`.
- `Dockerfile`, `docker-compose.yml`.
- `web/` (the Vite/React frontend).

These are all named in spec section 3's repo layout but were explicitly deferred by the user until after the shared modules land.
