# Database Migrations + Row-Level Security Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Write the node-pg-migrate migrations for the full schema in `docs/APP_SPEC.md` section 4 (`tenants`, `users`, `recipients`, `groups`, `group_members`, `alerts`, `deliveries`, `idempotency_keys`), the row-level-security policies, and the dedicated low-privilege `app_user` role — then prove both of spec section 4's RLS acceptance tests pass against a real, running Postgres.

**Architecture:** Each table gets its own migration file (`migrations/`, node-pg-migrate, CommonJS `exports.up`/`exports.down`), created via `node-pg-migrate create <name>` so timestamps are real and collision-free. RLS-protected tables enable + force RLS and create their `tenant_isolation_<table>` policy in the *same* migration that creates the table, using node-pg-migrate's first-class `alterTable({ levelSecurity })` and `createPolicy()` helpers (verified against the installed `node-pg-migrate@7.9.1`'s actual TypeScript types, not assumed from memory) — `down` is just `dropTable`, since dropping a table drops its policies with it. A new `test/integration/` tree holds tests that require a live Postgres, kept structurally separate from the existing `src/**/*.test.js` unit suite (which must keep running with zero external services) via a `package.json` script split. Everything in this plan is verified against the real local Postgres+PostGIS container already running (`notify-postgres`, database `notify`), not mocked.

**Tech Stack:** `node-pg-migrate@7.9.1` (already a dependency), `pg` (already a dependency), `supertest` (new devDependency, for the app-layer acceptance test's HTTP assertions), `express` + `jsonwebtoken` (already dependencies, used here for the first time via a minimal test-only auth harness — not the real intake service).

## Global Constraints

- Node.js 20, JavaScript, CommonJS (`require`/`module.exports`), not ESM — per spec section 2.
- Schema, column types, defaults, and constraints must match `docs/APP_SPEC.md` section 4 **exactly** — every table definition below is transcribed verbatim from that section. Do not add columns, indexes, or constraints beyond what's written there.
- RLS applies to exactly six tables per spec section 4's explicit list: `users`, `groups`, `recipients`, `group_members`, `alerts`, `deliveries`. **`idempotency_keys` is deliberately excluded** — it has a `tenant_id` column but the spec's RLS subsection does not name it. Follow the spec's literal text, not what "should" be tenant-scoped by analogy.
- Every RLS policy is exactly: `ENABLE ROW LEVEL SECURITY`, `FORCE ROW LEVEL SECURITY`, then `CREATE POLICY tenant_isolation_<table> ON <table> USING (tenant_id = current_setting('app.current_tenant', true)::uuid) WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid)` — copied verbatim from spec section 4.
- The running services connect as `app_user`, never as the migration-owner role (the role in this project's local `.env` `DATABASE_URL`, currently `postgres`). `app_user` must have `LOGIN` but must **not** have `SUPERUSER` or `BYPASSRLS` — either would silently defeat every RLS policy in this plan.
- `.env`'s `DATABASE_URL` already points at a local database named `notify`; `.env.example` documents `notifications`. This is intentional (verified at the start of this plan, not something to "fix") — it means a contributor who blindly copies `.env.example` to `.env` gets their own database, not one that collides with whatever the person who wrote `.env` is using.
- The existing unit suite (`src/**/*.test.js`, run by `npm test`) must keep requiring zero external services — nothing in this plan may make `npm test` need a live database. Anything that needs Postgres goes under `test/integration/` and runs only via the new `npm run test:integration` script.
- `test:integration` runs with `node --env-file=.env` — every integration test calls `loadConfig()`, which reads `process.env` directly and nothing else populates it (verified: `node --env-file=.env -e "console.log(process.env.DATABASE_URL)"` prints the real value from this repo's `.env`). It also runs with `--test-concurrency=1` (serial, one file at a time) — several tests in this plan mutate shared state in the one live `notify` database (seeding/deleting tenant rows, and one test that migrates the whole schema down and back up), and Node's test runner runs separate test files as concurrent subprocesses by default. Serial execution is what makes that safe.
- Spec section 4's two acceptance tests are both in scope for this plan, not deferred: the app-layer 404 test (Task 10) needs *some* authenticated HTTP surface to test against. That surface is a small test-only Express harness (`test/integration/support/auth-harness.js`) built specifically to prove this one property — it is **not** the real intake service (routes, full validation, `POST /alerts`, etc. are all still out of scope and land in a future plan).

---

## File Structure

```
migrations/
├── <ts>_create-tenants-table.js
├── <ts>_create-users-table.js
├── <ts>_create-recipients-table.js
├── <ts>_create-groups-table.js
├── <ts>_create-group-members-table.js
├── <ts>_create-alerts-table.js
├── <ts>_create-deliveries-table.js
├── <ts>_create-idempotency-keys-table.js
└── <ts>_create-app-user-role.js
test/
└── integration/
    ├── support/
    │   ├── db.js              # ensureMigrated(), withSuperuserClient(), withAppUserClient()
    │   ├── schema.js           # reusable information_schema/pg_catalog assertion helpers
    │   └── auth-harness.js     # test-only Express app + JWT signing (Task 10 only)
    ├── tenants.test.js
    ├── users.test.js
    ├── recipients.test.js
    ├── groups.test.js
    ├── alerts.test.js
    ├── deliveries.test.js
    ├── app-user-role.test.js
    ├── migration-round-trip.test.js
    ├── rls-database-layer.test.js   # spec section 4 acceptance test #2
    └── rls-app-layer.test.js        # spec section 4 acceptance test #1
package.json                         # script split (Task 1), +supertest devDependency
```

(`<ts>` is whatever real millisecond timestamp `node-pg-migrate create` generates when each task runs it — don't hardcode a filename, use whatever the CLI prints.)

---

### Task 1: Test wiring + `tenants` migration

**Files:**
- Modify: `package.json` (script split, `+supertest` devDependency)
- Create: `test/integration/support/db.js`
- Create: `test/integration/support/schema.js`
- Create: `migrations/<ts>_create-tenants-table.js` (via `node-pg-migrate create create-tenants-table`)
- Create: `test/integration/tenants.test.js`

**Interfaces:**
- Produces: `ensureMigrated()` — runs `node-pg-migrate`'s programmatic `runner()` with `direction: 'up'` against `loadConfig().databaseUrl`, idempotent (safe to call from every integration test file's own setup, in any order). `withSuperuserClient(fn)` — opens a `pg.Client` using `loadConfig().databaseUrl` (the migration-owner role from `.env`), runs `fn(client)`, always closes it. `withAppUserClient(fn)` — same, but against a connection string with `app_user`/`app_user` swapped in for the username/password (host/port/database unchanged). `appUserConnectionString(databaseUrl)` — the pure string-transform helper behind that swap, exported separately so later tasks can build their own `pg.Client` directly when they need transaction control `withAppUserClient` doesn't expose (Tasks 9-10 need `BEGIN`/`SET LOCAL`-equivalent/`COMMIT` inside one held connection).
- Produces (schema.js): `getColumn(client, table, column)`, `hasForeignKey(client, table, column, referencedTable)`, `hasUniqueConstraint(client, table, columns[])`, `hasPrimaryKey(client, table, columns[])`, `checkConstraintContainsAll(client, table, substrings[])`, `hasIndex(client, table, column, method?)`, `rlsStatus(client, table)` → `{relrowsecurity, relforcerowsecurity}`, `hasPolicy(client, table, policyName)` → policy row or `null`. Every later table task imports and reuses these — don't reimplement column/constraint lookups per task.

- [ ] **Step 1: Split the test scripts and add `supertest`**

Edit `package.json`'s `scripts` block:

```json
    "test": "node --test 'src/**/*.test.js'",
    "test:integration": "node --env-file=.env --test --test-concurrency=1 'test/integration/**/*.test.js'",
```

(Replaces the old bare `"test": "node --test"` — that form recursively discovers every `*.test.js` under the whole repo, which would silently pull the new `test/integration/` files into plain `npm test` and break its zero-external-services contract the moment they exist. `test:integration` needs `--env-file=.env` — unlike the unit suite, every integration test calls `loadConfig()`, which reads `process.env` directly, and nothing else loads `.env` into it; this is the same `--env-file` convention `.env.example`'s header comment already documents, just applied to a script for the first time.)

Add to `devDependencies`:

```json
    "supertest": "^7.0.0",
```

Run: `npm install`
Expected: completes cleanly, `package-lock.json` updated.

- [ ] **Step 2: Write the failing test for `db.js` and `schema.js` together, via the tenants migration**

Create `test/integration/support/db.js`:

```js
'use strict';

const { Client } = require('pg');
const { runner } = require('node-pg-migrate');
const path = require('node:path');
const { loadConfig } = require('../../../src/shared/config');

async function ensureMigrated() {
  const config = loadConfig();
  const client = new Client({ connectionString: config.databaseUrl });
  await client.connect();
  try {
    await runner({
      dbClient: client,
      dir: path.join(__dirname, '..', '..', '..', 'migrations'),
      direction: 'up',
      migrationsTable: 'pgmigrations',
      logger: { info: () => {}, warn: console.warn, error: console.error },
    });
  } finally {
    await client.end();
  }
}

async function migrateTo(count) {
  const config = loadConfig();
  const client = new Client({ connectionString: config.databaseUrl });
  await client.connect();
  try {
    await runner({
      dbClient: client,
      dir: path.join(__dirname, '..', '..', '..', 'migrations'),
      direction: count < 0 ? 'down' : 'up',
      count: Math.abs(count),
      migrationsTable: 'pgmigrations',
      logger: { info: () => {}, warn: console.warn, error: console.error },
    });
  } finally {
    await client.end();
  }
}

async function withSuperuserClient(fn) {
  const config = loadConfig();
  const client = new Client({ connectionString: config.databaseUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

function appUserConnectionString(databaseUrl) {
  const url = new URL(databaseUrl);
  url.username = 'app_user';
  url.password = 'app_user';
  return url.toString();
}

async function withAppUserClient(fn) {
  const config = loadConfig();
  const client = new Client({ connectionString: appUserConnectionString(config.databaseUrl) });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

module.exports = {
  ensureMigrated,
  migrateTo,
  withSuperuserClient,
  withAppUserClient,
  appUserConnectionString,
};
```

Create `test/integration/support/schema.js`:

```js
'use strict';

async function getColumn(client, table, column) {
  const { rows } = await client.query(
    `SELECT column_name, data_type, udt_name, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [table, column]
  );
  return rows[0] || null;
}

async function hasForeignKey(client, table, column, referencedTable) {
  const { rows } = await client.query(
    `SELECT tc.constraint_name
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
     JOIN information_schema.constraint_column_usage ccu
       ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
     WHERE tc.constraint_type = 'FOREIGN KEY'
       AND tc.table_schema = 'public'
       AND tc.table_name = $1
       AND kcu.column_name = $2
       AND ccu.table_name = $3`,
    [table, column, referencedTable]
  );
  return rows.length > 0;
}

async function hasUniqueConstraint(client, table, columns) {
  const { rows } = await client.query(
    `SELECT tc.constraint_name, array_agg(kcu.column_name ORDER BY kcu.ordinal_position) AS cols
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
     WHERE tc.constraint_type = 'UNIQUE'
       AND tc.table_schema = 'public'
       AND tc.table_name = $1
     GROUP BY tc.constraint_name`,
    [table]
  );
  const target = [...columns].sort().join(',');
  return rows.some((row) => [...row.cols].sort().join(',') === target);
}

async function hasPrimaryKey(client, table, columns) {
  const { rows } = await client.query(
    `SELECT array_agg(kcu.column_name ORDER BY kcu.ordinal_position) AS cols
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
     WHERE tc.constraint_type = 'PRIMARY KEY'
       AND tc.table_schema = 'public'
       AND tc.table_name = $1
     GROUP BY tc.constraint_name`,
    [table]
  );
  if (rows.length === 0) return false;
  const target = [...columns].sort().join(',');
  return [...rows[0].cols].sort().join(',') === target;
}

async function checkConstraintContainsAll(client, table, substrings) {
  const { rows } = await client.query(
    `SELECT pg_get_constraintdef(oid) AS def
     FROM pg_constraint
     WHERE conrelid = $1::regclass AND contype = 'c'`,
    [table]
  );
  const combined = rows.map((row) => row.def).join(' | ');
  return substrings.every((s) => combined.includes(s));
}

async function hasIndex(client, table, column, method) {
  const { rows } = await client.query(
    `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1`,
    [table]
  );
  return rows.some(
    (row) =>
      row.indexdef.includes(column) &&
      (!method || row.indexdef.toLowerCase().includes(`using ${method}`))
  );
}

async function rlsStatus(client, table) {
  const { rows } = await client.query(
    `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = $1::regclass`,
    [table]
  );
  return rows[0] || { relrowsecurity: false, relforcerowsecurity: false };
}

async function hasPolicy(client, table, policyName) {
  const { rows } = await client.query(
    `SELECT policyname, qual, with_check
     FROM pg_policies
     WHERE schemaname = 'public' AND tablename = $1 AND policyname = $2`,
    [table, policyName]
  );
  return rows[0] || null;
}

module.exports = {
  getColumn,
  hasForeignKey,
  hasUniqueConstraint,
  hasPrimaryKey,
  checkConstraintContainsAll,
  hasIndex,
  rlsStatus,
  hasPolicy,
};
```

Create `test/integration/tenants.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ensureMigrated, withSuperuserClient } = require('./support/db');
const schema = require('./support/schema');

test('tenants table matches spec section 4', async () => {
  await ensureMigrated();
  await withSuperuserClient(async (client) => {
    const id = await schema.getColumn(client, 'tenants', 'id');
    assert.equal(id.udt_name, 'uuid');
    assert.equal(id.is_nullable, 'NO');
    assert.match(id.column_default, /gen_random_uuid/);
    assert.ok(await schema.hasPrimaryKey(client, 'tenants', ['id']));

    const slug = await schema.getColumn(client, 'tenants', 'slug');
    assert.equal(slug.udt_name, 'text');
    assert.equal(slug.is_nullable, 'NO');
    assert.ok(await schema.hasUniqueConstraint(client, 'tenants', ['slug']));

    const name = await schema.getColumn(client, 'tenants', 'name');
    assert.equal(name.udt_name, 'text');
    assert.equal(name.is_nullable, 'NO');

    const tenantType = await schema.getColumn(client, 'tenants', 'tenant_type');
    assert.equal(tenantType.udt_name, 'text');
    assert.equal(tenantType.is_nullable, 'NO');
    assert.ok(
      await schema.checkConstraintContainsAll(client, 'tenants', [
        "'state_agency'",
        "'county_em'",
        "'school_district'",
        "'hospital_system'",
        "'dispatch_center'",
      ])
    );

    const createdAt = await schema.getColumn(client, 'tenants', 'created_at');
    assert.equal(createdAt.udt_name, 'timestamptz');
    assert.equal(createdAt.is_nullable, 'NO');
    assert.match(createdAt.column_default, /now\(\)/);

    // tenants is the isolation root -- it must NOT itself carry RLS.
    const rls = await schema.rlsStatus(client, 'tenants');
    assert.equal(rls.relrowsecurity, false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:integration`
Expected: FAIL — `relation "tenants" does not exist` (no migration exists yet).

- [ ] **Step 3: Generate and fill in the tenants migration**

Run: `npx node-pg-migrate create create-tenants-table --migration-file-language js`

This prints the created file's path (e.g. `migrations/1735000000000_create-tenants-table.js`) — use that exact filename for the rest of this step; replace its generated `exports.up`/`exports.down` stubs with:

```js
'use strict';

exports.up = (pgm) => {
  pgm.createTable('tenants', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    slug: { type: 'text', notNull: true, unique: true },
    name: { type: 'text', notNull: true },
    tenant_type: {
      type: 'text',
      notNull: true,
      check:
        "tenant_type in ('state_agency','county_em','school_district','hospital_system','dispatch_center')",
    },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
};

exports.down = (pgm) => {
  pgm.dropTable('tenants');
};
```

- [ ] **Step 4: Run migrations and the test to verify it passes**

Run: `npm run test:integration -- test/integration/tenants.test.js` (or just `npm run test:integration`, only this one file exists so far)
Expected: PASS, 1/1.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json test/integration migrations
git commit -m "test: wire up integration test harness and tenants migration"
```

---

### Task 2: `users` migration + RLS

**Files:**
- Create: `migrations/<ts>_create-users-table.js` (via `node-pg-migrate create create-users-table`)
- Create: `test/integration/users.test.js`

**Interfaces:**
- Consumes: `ensureMigrated`, `withSuperuserClient` (`./support/db`), all of `./support/schema`, from Task 1.

- [ ] **Step 1: Write the failing test**

Create `test/integration/users.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ensureMigrated, withSuperuserClient } = require('./support/db');
const schema = require('./support/schema');

test('users table matches spec section 4, including RLS', async () => {
  await ensureMigrated();
  await withSuperuserClient(async (client) => {
    const id = await schema.getColumn(client, 'users', 'id');
    assert.equal(id.udt_name, 'uuid');
    assert.ok(await schema.hasPrimaryKey(client, 'users', ['id']));

    const tenantId = await schema.getColumn(client, 'users', 'tenant_id');
    assert.equal(tenantId.udt_name, 'uuid');
    assert.equal(tenantId.is_nullable, 'NO');
    assert.ok(await schema.hasForeignKey(client, 'users', 'tenant_id', 'tenants'));

    const email = await schema.getColumn(client, 'users', 'email');
    assert.equal(email.udt_name, 'text');
    assert.equal(email.is_nullable, 'NO');

    const passwordHash = await schema.getColumn(client, 'users', 'password_hash');
    assert.equal(passwordHash.udt_name, 'text');
    assert.equal(passwordHash.is_nullable, 'NO');

    const role = await schema.getColumn(client, 'users', 'role');
    assert.equal(role.is_nullable, 'NO');
    assert.equal(role.column_default, "'operator'::text");
    assert.ok(await schema.checkConstraintContainsAll(client, 'users', ["'operator'", "'admin'"]));

    assert.ok(await schema.hasUniqueConstraint(client, 'users', ['tenant_id', 'email']));

    const rls = await schema.rlsStatus(client, 'users');
    assert.equal(rls.relrowsecurity, true);
    assert.equal(rls.relforcerowsecurity, true);

    const policy = await schema.hasPolicy(client, 'users', 'tenant_isolation_users');
    assert.ok(policy);
    assert.match(policy.qual, /current_setting\('app\.current_tenant', true\)::uuid/);
    assert.match(policy.with_check, /current_setting\('app\.current_tenant', true\)::uuid/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:integration`
Expected: FAIL — `relation "users" does not exist`.

- [ ] **Step 3: Generate and fill in the users migration**

Run: `npx node-pg-migrate create create-users-table --migration-file-language js`

```js
'use strict';

exports.up = (pgm) => {
  pgm.createTable('users', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants' },
    email: { type: 'text', notNull: true },
    password_hash: { type: 'text', notNull: true },
    role: { type: 'text', notNull: true, default: 'operator', check: "role in ('operator','admin')" },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  }, {
    constraints: { unique: [['tenant_id', 'email']] },
  });

  pgm.alterTable('users', { levelSecurity: 'ENABLE' });
  pgm.alterTable('users', { levelSecurity: 'FORCE' });
  pgm.createPolicy('users', 'tenant_isolation_users', {
    using: "tenant_id = current_setting('app.current_tenant', true)::uuid",
    check: "tenant_id = current_setting('app.current_tenant', true)::uuid",
  });
};

exports.down = (pgm) => {
  pgm.dropTable('users');
};
```

- [ ] **Step 4: Run migrations and the test to verify it passes**

Run: `npm run test:integration`
Expected: PASS, 2/2 (tenants + users).

- [ ] **Step 5: Commit**

```bash
git add test/integration/users.test.js migrations
git commit -m "feat: add users table migration with RLS"
```

---

### Task 3: `recipients` migration + PostGIS + RLS

**Files:**
- Create: `migrations/<ts>_create-recipients-table.js`
- Create: `test/integration/recipients.test.js`

**Interfaces:**
- Consumes: same as Task 2.

- [ ] **Step 1: Write the failing test**

Create `test/integration/recipients.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ensureMigrated, withSuperuserClient } = require('./support/db');
const schema = require('./support/schema');

test('recipients table matches spec section 4, including the PostGIS location column, GIST index, and RLS', async () => {
  await ensureMigrated();
  await withSuperuserClient(async (client) => {
    const id = await schema.getColumn(client, 'recipients', 'id');
    assert.equal(id.udt_name, 'uuid');

    const tenantId = await schema.getColumn(client, 'recipients', 'tenant_id');
    assert.equal(tenantId.is_nullable, 'NO');
    assert.ok(await schema.hasForeignKey(client, 'recipients', 'tenant_id', 'tenants'));

    const name = await schema.getColumn(client, 'recipients', 'name');
    assert.equal(name.is_nullable, 'NO');

    const phone = await schema.getColumn(client, 'recipients', 'phone');
    assert.equal(phone.is_nullable, 'YES');

    const email = await schema.getColumn(client, 'recipients', 'email');
    assert.equal(email.is_nullable, 'YES');

    const location = await schema.getColumn(client, 'recipients', 'location');
    assert.equal(location.udt_name, 'geography');
    assert.equal(location.is_nullable, 'YES');

    assert.ok(await schema.hasIndex(client, 'recipients', 'location', 'gist'));

    const rls = await schema.rlsStatus(client, 'recipients');
    assert.equal(rls.relrowsecurity, true);
    assert.equal(rls.relforcerowsecurity, true);
    assert.ok(await schema.hasPolicy(client, 'recipients', 'tenant_isolation_recipients'));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:integration`
Expected: FAIL — `relation "recipients" does not exist`.

- [ ] **Step 3: Generate and fill in the recipients migration**

Run: `npx node-pg-migrate create create-recipients-table --migration-file-language js`

```js
'use strict';

exports.up = (pgm) => {
  pgm.createExtension('postgis', { ifNotExists: true });

  pgm.createTable('recipients', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants' },
    name: { type: 'text', notNull: true },
    phone: { type: 'text' },
    email: { type: 'text' },
    location: { type: 'geography(Point,4326)' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createIndex('recipients', 'location', { method: 'gist' });

  pgm.alterTable('recipients', { levelSecurity: 'ENABLE' });
  pgm.alterTable('recipients', { levelSecurity: 'FORCE' });
  pgm.createPolicy('recipients', 'tenant_isolation_recipients', {
    using: "tenant_id = current_setting('app.current_tenant', true)::uuid",
    check: "tenant_id = current_setting('app.current_tenant', true)::uuid",
  });
};

exports.down = (pgm) => {
  pgm.dropTable('recipients');
  pgm.dropExtension('postgis', { ifExists: true });
};
```

- [ ] **Step 4: Run migrations and the test to verify it passes**

Run: `npm run test:integration`
Expected: PASS, 3/3.

- [ ] **Step 5: Commit**

```bash
git add test/integration/recipients.test.js migrations
git commit -m "feat: add recipients table migration with PostGIS and RLS"
```

---

### Task 4: `groups` + `group_members` migrations + RLS

**Files:**
- Create: `migrations/<ts>_create-groups-table.js`
- Create: `migrations/<ts>_create-group-members-table.js`
- Create: `test/integration/groups.test.js`

**Interfaces:**
- Consumes: same as Task 2. `group_members` depends on both `groups` and `recipients` (Task 3) existing.

- [ ] **Step 1: Write the failing test**

Create `test/integration/groups.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ensureMigrated, withSuperuserClient } = require('./support/db');
const schema = require('./support/schema');

test('groups table matches spec section 4, including RLS', async () => {
  await ensureMigrated();
  await withSuperuserClient(async (client) => {
    const tenantId = await schema.getColumn(client, 'groups', 'tenant_id');
    assert.equal(tenantId.is_nullable, 'NO');
    assert.ok(await schema.hasForeignKey(client, 'groups', 'tenant_id', 'tenants'));

    const name = await schema.getColumn(client, 'groups', 'name');
    assert.equal(name.is_nullable, 'NO');

    const rls = await schema.rlsStatus(client, 'groups');
    assert.equal(rls.relrowsecurity, true);
    assert.equal(rls.relforcerowsecurity, true);
    assert.ok(await schema.hasPolicy(client, 'groups', 'tenant_isolation_groups'));
  });
});

test('group_members table matches spec section 4: composite PK, three FKs, RLS', async () => {
  await ensureMigrated();
  await withSuperuserClient(async (client) => {
    assert.ok(await schema.hasForeignKey(client, 'group_members', 'group_id', 'groups'));
    assert.ok(await schema.hasForeignKey(client, 'group_members', 'recipient_id', 'recipients'));
    assert.ok(await schema.hasForeignKey(client, 'group_members', 'tenant_id', 'tenants'));
    assert.ok(await schema.hasPrimaryKey(client, 'group_members', ['group_id', 'recipient_id']));

    const rls = await schema.rlsStatus(client, 'group_members');
    assert.equal(rls.relrowsecurity, true);
    assert.equal(rls.relforcerowsecurity, true);
    assert.ok(await schema.hasPolicy(client, 'group_members', 'tenant_isolation_group_members'));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:integration`
Expected: FAIL — `relation "groups" does not exist`.

- [ ] **Step 3: Generate and fill in both migrations**

Run: `npx node-pg-migrate create create-groups-table --migration-file-language js`

```js
'use strict';

exports.up = (pgm) => {
  pgm.createTable('groups', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants' },
    name: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.alterTable('groups', { levelSecurity: 'ENABLE' });
  pgm.alterTable('groups', { levelSecurity: 'FORCE' });
  pgm.createPolicy('groups', 'tenant_isolation_groups', {
    using: "tenant_id = current_setting('app.current_tenant', true)::uuid",
    check: "tenant_id = current_setting('app.current_tenant', true)::uuid",
  });
};

exports.down = (pgm) => {
  pgm.dropTable('groups');
};
```

Run: `npx node-pg-migrate create create-group-members-table --migration-file-language js`

```js
'use strict';

exports.up = (pgm) => {
  pgm.createTable('group_members', {
    group_id: { type: 'uuid', notNull: true, references: 'groups' },
    recipient_id: { type: 'uuid', notNull: true, references: 'recipients' },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants' },
  }, {
    constraints: { primaryKey: ['group_id', 'recipient_id'] },
  });

  pgm.alterTable('group_members', { levelSecurity: 'ENABLE' });
  pgm.alterTable('group_members', { levelSecurity: 'FORCE' });
  pgm.createPolicy('group_members', 'tenant_isolation_group_members', {
    using: "tenant_id = current_setting('app.current_tenant', true)::uuid",
    check: "tenant_id = current_setting('app.current_tenant', true)::uuid",
  });
};

exports.down = (pgm) => {
  pgm.dropTable('group_members');
};
```

- [ ] **Step 4: Run migrations and the test to verify it passes**

Run: `npm run test:integration`
Expected: PASS, 5/5 (2 new tests, plus the 3 from Tasks 1-3).

- [ ] **Step 5: Commit**

```bash
git add test/integration/groups.test.js migrations
git commit -m "feat: add groups and group_members table migrations with RLS"
```

---

### Task 5: `alerts` migration + RLS

**Files:**
- Create: `migrations/<ts>_create-alerts-table.js`
- Create: `test/integration/alerts.test.js`

**Interfaces:**
- Consumes: same as Task 2. `alerts.created_by` references `users` (Task 2).

- [ ] **Step 1: Write the failing test**

Create `test/integration/alerts.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ensureMigrated, withSuperuserClient } = require('./support/db');
const schema = require('./support/schema');

test('alerts table matches spec section 4, including RLS', async () => {
  await ensureMigrated();
  await withSuperuserClient(async (client) => {
    assert.ok(await schema.hasForeignKey(client, 'alerts', 'tenant_id', 'tenants'));
    assert.ok(await schema.hasForeignKey(client, 'alerts', 'created_by', 'users'));

    const title = await schema.getColumn(client, 'alerts', 'title');
    assert.equal(title.is_nullable, 'NO');

    const body = await schema.getColumn(client, 'alerts', 'body');
    assert.equal(body.is_nullable, 'NO');

    const priority = await schema.getColumn(client, 'alerts', 'priority');
    assert.equal(priority.is_nullable, 'NO');
    assert.equal(priority.column_default, "'normal'::text");
    assert.ok(
      await schema.checkConstraintContainsAll(client, 'alerts', [
        "'low'",
        "'normal'",
        "'high'",
        "'critical'",
      ])
    );

    const channels = await schema.getColumn(client, 'alerts', 'channels');
    assert.equal(channels.udt_name, '_text');
    assert.equal(channels.is_nullable, 'NO');

    const target = await schema.getColumn(client, 'alerts', 'target');
    assert.equal(target.udt_name, 'jsonb');
    assert.equal(target.is_nullable, 'NO');

    const status = await schema.getColumn(client, 'alerts', 'status');
    assert.equal(status.is_nullable, 'NO');
    assert.equal(status.column_default, "'accepted'::text");
    assert.ok(
      await schema.checkConstraintContainsAll(client, 'alerts', [
        "'accepted'",
        "'expanding'",
        "'dispatching'",
        "'completed'",
        "'failed'",
      ])
    );

    const idempotencyKey = await schema.getColumn(client, 'alerts', 'idempotency_key');
    assert.equal(idempotencyKey.is_nullable, 'YES');

    const acceptedAt = await schema.getColumn(client, 'alerts', 'accepted_at');
    assert.equal(acceptedAt.is_nullable, 'NO');

    const completedAt = await schema.getColumn(client, 'alerts', 'completed_at');
    assert.equal(completedAt.is_nullable, 'YES');

    assert.ok(await schema.hasUniqueConstraint(client, 'alerts', ['tenant_id', 'idempotency_key']));

    const rls = await schema.rlsStatus(client, 'alerts');
    assert.equal(rls.relrowsecurity, true);
    assert.equal(rls.relforcerowsecurity, true);
    assert.ok(await schema.hasPolicy(client, 'alerts', 'tenant_isolation_alerts'));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:integration`
Expected: FAIL — `relation "alerts" does not exist`.

- [ ] **Step 3: Generate and fill in the alerts migration**

Run: `npx node-pg-migrate create create-alerts-table --migration-file-language js`

```js
'use strict';

exports.up = (pgm) => {
  pgm.createTable('alerts', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants' },
    created_by: { type: 'uuid', notNull: true, references: 'users' },
    title: { type: 'text', notNull: true },
    body: { type: 'text', notNull: true },
    priority: {
      type: 'text',
      notNull: true,
      default: 'normal',
      check: "priority in ('low','normal','high','critical')",
    },
    channels: { type: 'text[]', notNull: true },
    target: { type: 'jsonb', notNull: true },
    status: {
      type: 'text',
      notNull: true,
      default: 'accepted',
      check: "status in ('accepted','expanding','dispatching','completed','failed')",
    },
    idempotency_key: { type: 'text' },
    accepted_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    completed_at: { type: 'timestamptz' },
  }, {
    constraints: { unique: [['tenant_id', 'idempotency_key']] },
  });

  pgm.alterTable('alerts', { levelSecurity: 'ENABLE' });
  pgm.alterTable('alerts', { levelSecurity: 'FORCE' });
  pgm.createPolicy('alerts', 'tenant_isolation_alerts', {
    using: "tenant_id = current_setting('app.current_tenant', true)::uuid",
    check: "tenant_id = current_setting('app.current_tenant', true)::uuid",
  });
};

exports.down = (pgm) => {
  pgm.dropTable('alerts');
};
```

- [ ] **Step 4: Run migrations and the test to verify it passes**

Run: `npm run test:integration`
Expected: PASS, 6/6.

- [ ] **Step 5: Commit**

```bash
git add test/integration/alerts.test.js migrations
git commit -m "feat: add alerts table migration with RLS"
```

---

### Task 6: `deliveries` + `idempotency_keys` migrations

**Files:**
- Create: `migrations/<ts>_create-deliveries-table.js`
- Create: `migrations/<ts>_create-idempotency-keys-table.js`
- Create: `test/integration/deliveries.test.js`

**Interfaces:**
- Consumes: same as Task 2. `deliveries` references `alerts` (Task 5) and `recipients` (Task 3). `idempotency_keys` references `tenants` and `alerts` (Task 5) — and per Global Constraints, gets **no RLS**.

- [ ] **Step 1: Write the failing test**

Create `test/integration/deliveries.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ensureMigrated, withSuperuserClient } = require('./support/db');
const schema = require('./support/schema');

test('deliveries table matches spec section 4, including RLS', async () => {
  await ensureMigrated();
  await withSuperuserClient(async (client) => {
    assert.ok(await schema.hasForeignKey(client, 'deliveries', 'tenant_id', 'tenants'));
    assert.ok(await schema.hasForeignKey(client, 'deliveries', 'alert_id', 'alerts'));
    assert.ok(await schema.hasForeignKey(client, 'deliveries', 'recipient_id', 'recipients'));

    const channel = await schema.getColumn(client, 'deliveries', 'channel');
    assert.equal(channel.is_nullable, 'NO');
    assert.ok(await schema.checkConstraintContainsAll(client, 'deliveries', ["'sms'", "'email'"]));

    const status = await schema.getColumn(client, 'deliveries', 'status');
    assert.equal(status.is_nullable, 'NO');
    assert.equal(status.column_default, "'pending'::text");
    assert.ok(
      await schema.checkConstraintContainsAll(client, 'deliveries', [
        "'pending'",
        "'delivered'",
        "'failed'",
        "'rate_limited'",
        "'timed_out'",
      ])
    );

    const attemptCount = await schema.getColumn(client, 'deliveries', 'attempt_count');
    assert.equal(attemptCount.udt_name, 'int4');
    assert.equal(attemptCount.is_nullable, 'NO');
    assert.equal(attemptCount.column_default, '0');

    const providerResponse = await schema.getColumn(client, 'deliveries', 'provider_response');
    assert.equal(providerResponse.udt_name, 'jsonb');
    assert.equal(providerResponse.is_nullable, 'YES');

    const updatedAt = await schema.getColumn(client, 'deliveries', 'updated_at');
    assert.equal(updatedAt.is_nullable, 'NO');

    const deliveredAt = await schema.getColumn(client, 'deliveries', 'delivered_at');
    assert.equal(deliveredAt.is_nullable, 'YES');

    assert.ok(
      await schema.hasUniqueConstraint(client, 'deliveries', ['alert_id', 'recipient_id', 'channel'])
    );

    const rls = await schema.rlsStatus(client, 'deliveries');
    assert.equal(rls.relrowsecurity, true);
    assert.equal(rls.relforcerowsecurity, true);
    assert.ok(await schema.hasPolicy(client, 'deliveries', 'tenant_isolation_deliveries'));
  });
});

test('idempotency_keys table matches spec section 4 and deliberately has NO row-level security', async () => {
  await ensureMigrated();
  await withSuperuserClient(async (client) => {
    assert.ok(await schema.hasForeignKey(client, 'idempotency_keys', 'tenant_id', 'tenants'));
    assert.ok(await schema.hasForeignKey(client, 'idempotency_keys', 'alert_id', 'alerts'));
    assert.ok(await schema.hasPrimaryKey(client, 'idempotency_keys', ['tenant_id', 'key']));

    // Spec section 4's RLS subsection names six tables; idempotency_keys is
    // not one of them. Confirm that's really what's deployed, not an
    // oversight this migration introduced.
    const rls = await schema.rlsStatus(client, 'idempotency_keys');
    assert.equal(rls.relrowsecurity, false);
    assert.equal(rls.relforcerowsecurity, false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:integration`
Expected: FAIL — `relation "deliveries" does not exist`.

- [ ] **Step 3: Generate and fill in both migrations**

Run: `npx node-pg-migrate create create-deliveries-table --migration-file-language js`

```js
'use strict';

exports.up = (pgm) => {
  pgm.createTable('deliveries', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants' },
    alert_id: { type: 'uuid', notNull: true, references: 'alerts' },
    recipient_id: { type: 'uuid', notNull: true, references: 'recipients' },
    channel: { type: 'text', notNull: true, check: "channel in ('sms','email')" },
    status: {
      type: 'text',
      notNull: true,
      default: 'pending',
      check: "status in ('pending','delivered','failed','rate_limited','timed_out')",
    },
    attempt_count: { type: 'integer', notNull: true, default: 0 },
    provider_response: { type: 'jsonb' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    delivered_at: { type: 'timestamptz' },
  }, {
    constraints: { unique: [['alert_id', 'recipient_id', 'channel']] },
  });

  pgm.alterTable('deliveries', { levelSecurity: 'ENABLE' });
  pgm.alterTable('deliveries', { levelSecurity: 'FORCE' });
  pgm.createPolicy('deliveries', 'tenant_isolation_deliveries', {
    using: "tenant_id = current_setting('app.current_tenant', true)::uuid",
    check: "tenant_id = current_setting('app.current_tenant', true)::uuid",
  });
};

exports.down = (pgm) => {
  pgm.dropTable('deliveries');
};
```

Run: `npx node-pg-migrate create create-idempotency-keys-table --migration-file-language js`

```js
'use strict';

exports.up = (pgm) => {
  pgm.createTable('idempotency_keys', {
    key: { type: 'text', notNull: true },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants' },
    alert_id: { type: 'uuid', notNull: true, references: 'alerts' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  }, {
    constraints: { primaryKey: ['tenant_id', 'key'] },
  });
  // Deliberately no RLS -- spec section 4's RLS table list names six tables
  // and idempotency_keys is not one of them.
};

exports.down = (pgm) => {
  pgm.dropTable('idempotency_keys');
};
```

- [ ] **Step 4: Run migrations and the test to verify it passes**

Run: `npm run test:integration`
Expected: PASS, 8/8.

- [ ] **Step 5: Commit**

```bash
git add test/integration/deliveries.test.js migrations
git commit -m "feat: add deliveries and idempotency_keys table migrations"
```

---

### Task 7: `app_user` role + grants

**Files:**
- Create: `migrations/<ts>_create-app-user-role.js`
- Create: `test/integration/app-user-role.test.js`

**Interfaces:**
- Consumes: `withAppUserClient`, `appUserConnectionString` from `./support/db` (Task 1). Depends on all seven prior tables existing (Tasks 1-6) — it grants privileges on all of them.
- Produces: the `app_user` role itself, which Tasks 9-10 connect as.

- [ ] **Step 1: Write the failing test**

Create `test/integration/app-user-role.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ensureMigrated, withSuperuserClient, withAppUserClient } = require('./support/db');

test('app_user role exists, can log in, and is not superuser/bypassrls', async () => {
  await ensureMigrated();
  await withSuperuserClient(async (client) => {
    const { rows } = await client.query(
      `SELECT rolcanlogin, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'app_user'`
    );
    assert.equal(rows.length, 1, 'app_user role should exist');
    assert.equal(rows[0].rolcanlogin, true);
    assert.equal(rows[0].rolsuper, false, 'app_user must not be superuser or RLS is meaningless');
    assert.equal(rows[0].rolbypassrls, false, 'app_user must not bypass RLS');
  });
});

test('app_user can actually connect and is not the owner of the tenant-scoped tables', async () => {
  await withAppUserClient(async (client) => {
    const { rows } = await client.query('SELECT current_user');
    assert.equal(rows[0].current_user, 'app_user');
  });

  await withSuperuserClient(async (client) => {
    const { rows } = await client.query(
      `SELECT tableowner FROM pg_tables WHERE schemaname = 'public' AND tablename = 'users'`
    );
    assert.notEqual(rows[0].tableowner, 'app_user');
  });
});

test('app_user has CRUD grants on every tenant-scoped table', async () => {
  const tables = [
    'users',
    'groups',
    'recipients',
    'group_members',
    'alerts',
    'deliveries',
    'idempotency_keys',
  ];
  await withSuperuserClient(async (client) => {
    for (const table of tables) {
      const { rows } = await client.query(
        `SELECT privilege_type FROM information_schema.role_table_grants
         WHERE grantee = 'app_user' AND table_schema = 'public' AND table_name = $1`,
        [table]
      );
      const privileges = rows.map((row) => row.privilege_type);
      for (const required of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
        assert.ok(
          privileges.includes(required),
          `app_user should have ${required} on ${table}, got: ${privileges.join(', ')}`
        );
      }
    }
  });
});

test('an app_user session with no tenant scoped sees zero rows on an RLS-protected table, even though rows exist', async () => {
  const tenantId = '11111111-1111-1111-1111-111111111111';
  await withSuperuserClient(async (client) => {
    await client.query(
      `INSERT INTO tenants (id, slug, name, tenant_type)
       VALUES ($1, 'rls-smoke-test', 'RLS Smoke Test', 'county_em')
       ON CONFLICT (id) DO NOTHING`,
      [tenantId]
    );
    await client.query(
      `INSERT INTO users (tenant_id, email, password_hash) VALUES ($1, 'smoke@example.com', 'x')`,
      [tenantId]
    );
  });

  try {
    await withAppUserClient(async (client) => {
      // No SET app.current_tenant at all -- current_setting(..., true) is
      // NULL, and tenant_id = NULL is never true, so this must see nothing.
      const { rows } = await client.query('SELECT * FROM users');
      assert.equal(rows.length, 0);
    });
  } finally {
    await withSuperuserClient(async (client) => {
      await client.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
    });
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:integration`
Expected: FAIL — `role "app_user" does not exist` (connection refused for `withAppUserClient`; `pg_roles` query returns 0 rows for the first test).

- [ ] **Step 3: Generate and fill in the role migration**

Run: `npx node-pg-migrate create create-app-user-role --migration-file-language js`

```js
'use strict';

const TENANT_SCOPED_TABLES = [
  'users',
  'groups',
  'recipients',
  'group_members',
  'alerts',
  'deliveries',
  'idempotency_keys',
];

exports.up = (pgm) => {
  pgm.createRole('app_user', { login: true, password: 'app_user' });

  pgm.grantOnSchemas({ schemas: 'public', roles: 'app_user', privileges: 'USAGE' });

  pgm.grantOnTables({
    tables: 'tenants',
    roles: 'app_user',
    privileges: ['SELECT'],
  });

  pgm.grantOnTables({
    tables: TENANT_SCOPED_TABLES,
    roles: 'app_user',
    privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  });
};

exports.down = (pgm) => {
  pgm.revokeOnTables({
    tables: TENANT_SCOPED_TABLES,
    roles: 'app_user',
    privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  });
  pgm.revokeOnTables({ tables: 'tenants', roles: 'app_user', privileges: ['SELECT'] });
  pgm.revokeOnSchemas({ schemas: 'public', roles: 'app_user', privileges: 'USAGE' });
  pgm.dropRole('app_user');
};
```

- [ ] **Step 4: Run migrations and the test to verify it passes**

Run: `npm run test:integration`
Expected: PASS, 12/12 (4 new tests, plus 8 from Tasks 1-6).

- [ ] **Step 5: Commit**

```bash
git add test/integration/app-user-role.test.js migrations
git commit -m "feat: add app_user role with least-privilege grants"
```

---

### Task 8: Full migration down/up round-trip test

**Files:**
- Create: `test/integration/migration-round-trip.test.js`

**Interfaces:**
- Consumes: `migrateTo`, `ensureMigrated` from `./support/db` (Task 1).

This is the one genuinely destructive test in this plan — it migrates the entire schema down to zero and back up, in the live `notify` database, to prove every migration's `down` runs in correct dependency order (node-pg-migrate runs `down` migrations in reverse chronological order automatically, so children drop before parents — this test is what actually proves that holds across all 9 migrations, not just each one's own `down` in isolation). It's why `test:integration` runs with `--test-concurrency=1`: nothing else may be reading these tables while this test has them torn down. It self-heals at the end regardless of how it exits (`t.after` migrates back up), so a later re-run of `npm run test:integration` is never left broken by this test having run.

- [ ] **Step 1: Write the failing test**

Create `test/integration/migration-round-trip.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ensureMigrated, migrateTo, withSuperuserClient } = require('./support/db');

test('the full migration chain can be reverted to zero and reapplied cleanly', async (t) => {
  await ensureMigrated();

  t.after(async () => {
    await ensureMigrated();
  });

  await migrateTo(-9); // revert all 9 migrations, oldest last
  await withSuperuserClient(async (client) => {
    const { rows } = await client.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name != 'pgmigrations'`
    );
    assert.deepEqual(rows, [], 'expected every application table to be gone after a full revert');

    const { rows: roleRows } = await client.query(
      `SELECT 1 FROM pg_roles WHERE rolname = 'app_user'`
    );
    assert.equal(roleRows.length, 0, 'app_user should not exist after a full revert');
  });

  await migrateTo(9);
  await withSuperuserClient(async (client) => {
    const { rows } = await client.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name != 'pgmigrations'
       ORDER BY table_name`
    );
    assert.deepEqual(
      rows.map((r) => r.table_name),
      [
        'alerts',
        'deliveries',
        'group_members',
        'groups',
        'idempotency_keys',
        'recipients',
        'tenants',
        'users',
      ]
    );
  });
});
```

(Task 1-7 create exactly 9 migration files — tenants, users, recipients, groups, group_members, alerts, deliveries, idempotency_keys, app_user role. Before writing this step, confirm with `ls migrations | wc -l` that it's still 9; if it isn't, use the real count in both `migrateTo` calls and in this task's own description above.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:integration -- test/integration/migration-round-trip.test.js`
Expected: FAIL at first — likely a wrong `count` value if it doesn't match the real number of migration files, or (if the count is right) this test should actually pass on the first real try since Tasks 1-7 already proved every individual migration's `down` works. If it passes immediately, that's fine — the "RED" here is more about confirming the count and the exact expected table list than about a missing feature. If it's wrong, fix the count/table list, not the migrations.

- [ ] **Step 3: N/A**

No production code to write for this task — it exercises the migrations from Tasks 1-7 as-is. If Step 2 fails because a `down` migration is actually broken (not just a wrong count in the test), fix that migration's `down` function, re-run `npm run test:integration`, and note the fix in the commit message.

- [ ] **Step 4: Run the full integration suite one more time to confirm nothing else was disturbed**

Run: `npm run test:integration`
Expected: PASS, 13/13.

- [ ] **Step 5: Commit**

```bash
git add test/integration/migration-round-trip.test.js
git commit -m "test: add full migration down/up round-trip coverage"
```

---

### Task 9: Database-layer RLS acceptance test (spec section 4, test #2)

**Files:**
- Create: `test/integration/rls-database-layer.test.js`

**Interfaces:**
- Consumes: `ensureMigrated`, `withSuperuserClient`, `appUserConnectionString` from `./support/db`. Uses `pg.Client` directly (not `withAppUserClient`) because this test needs to hold one connection across `BEGIN` / `set_config` / the query / `COMMIT` — the same pattern `src/shared/db.js`'s `withTenant` uses in application code, but built by hand here since this test is deliberately *not* going through `db.js` (the whole point is to prove RLS holds independent of the application layer).

This is spec section 4's acceptance test #2, verbatim: *"as `app_user` (not the migration-owner role), scope a session to tenant B and query `WHERE tenant_id = <tenant A's id>` directly. It must return zero rows."* The spec calls this "the test that matters more" — it bypasses the app layer entirely.

- [ ] **Step 1: Write the test**

Create `test/integration/rls-database-layer.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');
const { loadConfig } = require('../../src/shared/config');
const { ensureMigrated, withSuperuserClient, appUserConnectionString } = require('./support/db');

// Spec section 4, acceptance test #2 (database layer) -- the one the spec
// says "matters more," because it bypasses the app layer entirely. If this
// passes, RLS holds even for a query that forgets a WHERE tenant_id clause.

test('as app_user, scoping the session to tenant B and querying WHERE tenant_id = tenant A returns zero rows', async () => {
  await ensureMigrated();

  const tenantAId = randomUUID();
  const tenantBId = randomUUID();

  await withSuperuserClient(async (client) => {
    await client.query(
      `INSERT INTO tenants (id, slug, name, tenant_type) VALUES ($1, $2, 'Tenant A', 'county_em')`,
      [tenantAId, `tenant-a-${tenantAId}`]
    );
    await client.query(
      `INSERT INTO tenants (id, slug, name, tenant_type) VALUES ($1, $2, 'Tenant B', 'school_district')`,
      [tenantBId, `tenant-b-${tenantBId}`]
    );
    // A real row that genuinely belongs to tenant A -- if RLS is broken,
    // this is what a buggy "forgot WHERE tenant_id" query would leak.
    await client.query(
      `INSERT INTO users (tenant_id, email, password_hash) VALUES ($1, 'operator@tenant-a.example', 'x')`,
      [tenantAId]
    );
  });

  try {
    const config = loadConfig();
    const appUserClient = new Client({ connectionString: appUserConnectionString(config.databaseUrl) });
    await appUserClient.connect();
    try {
      await appUserClient.query('BEGIN');
      // Scope this session to tenant B.
      await appUserClient.query('SELECT set_config($1, $2, true)', [
        'app.current_tenant',
        tenantBId,
      ]);
      // Query directly for tenant A's rows -- exactly what a bug that
      // forgot a WHERE tenant_id clause, or supplied the wrong one, would do.
      const result = await appUserClient.query('SELECT * FROM users WHERE tenant_id = $1', [
        tenantAId,
      ]);
      assert.equal(result.rows.length, 0, 'RLS must return zero rows for another tenant, even asked for explicitly');
      await appUserClient.query('COMMIT');
    } finally {
      await appUserClient.end();
    }
  } finally {
    await withSuperuserClient(async (client) => {
      // users.tenant_id has no ON DELETE CASCADE (a deliberate schema
      // choice, not an oversight) -- delete the dependent row before its
      // parent tenant, or this delete fails on the FK constraint.
      await client.query('DELETE FROM users WHERE tenant_id IN ($1, $2)', [tenantAId, tenantBId]);
      await client.query('DELETE FROM tenants WHERE id IN ($1, $2)', [tenantAId, tenantBId]);
    });
  }
});
```

- [ ] **Step 2: Run it**

Run: `npm run test:integration -- test/integration/rls-database-layer.test.js`
Expected: PASS immediately (Tasks 2 and 7 already built the RLS policy and the role this test exercises — this task's job is to encode the exact spec-cited scenario as its own named, citable acceptance test, not to build new production code). If it fails, the bug is in `users`' RLS policy (Task 2) or `app_user`'s grants (Task 7) — fix there, not here.

- [ ] **Step 3: Run the full integration suite**

Run: `npm run test:integration`
Expected: PASS, 14/14.

- [ ] **Step 4: Commit**

```bash
git add test/integration/rls-database-layer.test.js
git commit -m "test: add spec section 4 database-layer RLS acceptance test"
```

---

### Task 10: App-layer 404 acceptance test (spec section 4, test #1)

**Files:**
- Create: `test/integration/support/auth-harness.js`
- Create: `test/integration/rls-app-layer.test.js`

**Interfaces:**
- Consumes: `loadConfig` (`src/shared/config`), `createPool`/`createDb` (`src/shared/db`), `ensureMigrated`/`withSuperuserClient` (`./support/db`).
- Produces: `createAuthHarness({ jwtSecret, db })` → an Express app with one authenticated route (`GET /api/v1/alerts/:id`), for `supertest` to drive. `signToken({ jwtSecret, tenantId, userId })` → a JWT with `tenant_id`/`sub` claims, matching spec section 5's stated JWT shape.

This harness is **test-only scaffolding**, not the intake service. It exists solely to prove spec section 4's acceptance test #1: *"authenticate as a user in tenant A, request `GET /api/v1/alerts/:id` using a known alert id that belongs to tenant B. Assert `404`, not `403`."* The real intake service (full route set, Zod validation, `POST /alerts`, idempotency, groups, `/healthz`/`/readyz`/`/metrics`) is a separate, later plan — this file must not grow beyond what this one acceptance test needs.

- [ ] **Step 1: Write the harness**

Create `test/integration/support/auth-harness.js`:

```js
'use strict';

const express = require('express');
const jwt = require('jsonwebtoken');

function createAuthHarness({ jwtSecret, db }) {
  const app = express();

  app.use((req, res, next) => {
    const header = req.headers.authorization || '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) {
      return res.status(401).json({ error: 'missing bearer token' });
    }
    try {
      req.auth = jwt.verify(token, jwtSecret);
    } catch (err) {
      return res.status(401).json({ error: 'invalid token' });
    }
    return next();
  });

  app.get('/api/v1/alerts/:id', async (req, res) => {
    const tenantId = req.auth.tenant_id;
    const result = await db.withTenant(tenantId, (client) =>
      client.query('SELECT id FROM alerts WHERE id = $1', [req.params.id])
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'not found' });
    }
    return res.status(200).json({ id: result.rows[0].id });
  });

  return app;
}

function signToken({ jwtSecret, tenantId, userId }) {
  return jwt.sign({ tenant_id: tenantId, sub: userId }, jwtSecret);
}

module.exports = { createAuthHarness, signToken };
```

- [ ] **Step 2: Write the failing test**

Create `test/integration/rls-app-layer.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const request = require('supertest');
const { loadConfig } = require('../../src/shared/config');
const { createPool, createDb } = require('../../src/shared/db');
const { ensureMigrated, withSuperuserClient } = require('./support/db');
const { createAuthHarness, signToken } = require('./support/auth-harness');

// Spec section 4, acceptance test #1 (app layer): authenticate as a user in
// tenant A, request GET /api/v1/alerts/:id for an alert that belongs to
// tenant B. Must be 404, not 403 -- tenant B's data shouldn't even register
// as "exists, but you can't see it."

test('GET /api/v1/alerts/:id returns 404, not 403, for an alert belonging to another tenant', async (t) => {
  await ensureMigrated();
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  const db = createDb(pool);
  t.after(() => pool.end());

  const tenantAId = randomUUID();
  const tenantBId = randomUUID();
  let tenantBAlertId;

  await withSuperuserClient(async (client) => {
    await client.query(
      `INSERT INTO tenants (id, slug, name, tenant_type) VALUES ($1, $2, 'Tenant A', 'county_em')`,
      [tenantAId, `tenant-a-${tenantAId}`]
    );
    await client.query(
      `INSERT INTO tenants (id, slug, name, tenant_type) VALUES ($1, $2, 'Tenant B', 'school_district')`,
      [tenantBId, `tenant-b-${tenantBId}`]
    );
    const { rows: userRows } = await client.query(
      `INSERT INTO users (tenant_id, email, password_hash) VALUES ($1, 'operator@tenant-b.example', 'x') RETURNING id`,
      [tenantBId]
    );
    const { rows: alertRows } = await client.query(
      `INSERT INTO alerts (tenant_id, created_by, title, body, channels, target)
       VALUES ($1, $2, 'Test alert', 'body', ARRAY['sms'], '{"type":"group","groupId":"x"}'::jsonb)
       RETURNING id`,
      [tenantBId, userRows[0].id]
    );
    tenantBAlertId = alertRows[0].id;
  });

  t.after(async () => {
    await withSuperuserClient(async (client) => {
      // Delete children before parents -- alerts.created_by -> users and
      // users.tenant_id -> tenants both lack ON DELETE CASCADE.
      await client.query('DELETE FROM alerts WHERE tenant_id IN ($1, $2)', [tenantAId, tenantBId]);
      await client.query('DELETE FROM users WHERE tenant_id IN ($1, $2)', [tenantAId, tenantBId]);
      await client.query('DELETE FROM tenants WHERE id IN ($1, $2)', [tenantAId, tenantBId]);
    });
  });

  const app = createAuthHarness({ jwtSecret: config.jwtSecret, db });
  const tenantAToken = signToken({ jwtSecret: config.jwtSecret, tenantId: tenantAId, userId: randomUUID() });

  const response = await request(app)
    .get(`/api/v1/alerts/${tenantBAlertId}`)
    .set('Authorization', `Bearer ${tenantAToken}`);

  assert.equal(response.status, 404);
  assert.notEqual(response.status, 403);
});

test('GET /api/v1/alerts/:id returns 200 when the alert belongs to the requesting tenant', async (t) => {
  await ensureMigrated();
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  const db = createDb(pool);
  t.after(() => pool.end());

  const tenantId = randomUUID();
  let alertId;

  await withSuperuserClient(async (client) => {
    await client.query(
      `INSERT INTO tenants (id, slug, name, tenant_type) VALUES ($1, $2, 'Tenant', 'county_em')`,
      [tenantId, `tenant-${tenantId}`]
    );
    const { rows: userRows } = await client.query(
      `INSERT INTO users (tenant_id, email, password_hash) VALUES ($1, 'operator@tenant.example', 'x') RETURNING id`,
      [tenantId]
    );
    const { rows: alertRows } = await client.query(
      `INSERT INTO alerts (tenant_id, created_by, title, body, channels, target)
       VALUES ($1, $2, 'Own alert', 'body', ARRAY['email'], '{"type":"group","groupId":"x"}'::jsonb)
       RETURNING id`,
      [tenantId, userRows[0].id]
    );
    alertId = alertRows[0].id;
  });

  t.after(async () => {
    await withSuperuserClient(async (client) => {
      // Delete children before parents -- alerts.created_by -> users and
      // users.tenant_id -> tenants both lack ON DELETE CASCADE.
      await client.query('DELETE FROM alerts WHERE tenant_id = $1', [tenantId]);
      await client.query('DELETE FROM users WHERE tenant_id = $1', [tenantId]);
      await client.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
    });
  });

  const app = createAuthHarness({ jwtSecret: config.jwtSecret, db });
  const token = signToken({ jwtSecret: config.jwtSecret, tenantId, userId: randomUUID() });

  const response = await request(app)
    .get(`/api/v1/alerts/${alertId}`)
    .set('Authorization', `Bearer ${token}`);

  assert.equal(response.status, 200);
  assert.equal(response.body.id, alertId);
});
```

- [ ] **Step 3: Run it**

Run: `npm run test:integration -- test/integration/rls-app-layer.test.js`
Expected: PASS. (Like Task 9, the underlying mechanism — `db.js`'s `withTenant`, Task 2's RLS policy — already exists; this task's own new code is just the harness and the two HTTP-level assertions.) If the cross-tenant request comes back `200` instead of `404`, the bug is that the harness or `withTenant` isn't actually scoping the session — fix that, not the test.

- [ ] **Step 4: Run the full integration suite one more time**

Run: `npm run test:integration`
Expected: PASS, 16/16.

- [ ] **Step 5: Lint everything and commit**

Run: `npm run lint`
Expected: exits 0 (the `eslint.config.js` from the earlier plan ignores nothing under `test/`, so it lints these new files too — fix anything it flags).

```bash
git add test/integration/support/auth-harness.js test/integration/rls-app-layer.test.js
git commit -m "test: add spec section 4 app-layer 404 RLS acceptance test"
```

---

## Out of scope for this plan (do not implement here)

- The real intake/fanout/dispatch/stubs service entrypoints (`src/intake/`, etc.) — the auth harness in Task 10 is test-only scaffolding, not a first draft of intake.
- Seed data (`scripts/seed.js`).
- `Dockerfile`, `docker-compose.yml`.
- The `web/` frontend.

These are all named in spec section 3's repo layout but were explicitly deferred by the user until after this migrations plan lands.
