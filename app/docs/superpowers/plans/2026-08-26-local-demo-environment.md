# Local Demo Environment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the complete backend pipeline reproducibly runnable with Docker Compose, deterministic seed data, and a development JWT helper.

**Architecture:** A checked-in Compose file orchestrates PostGIS, ElasticMQ, one-shot migrations, one-shot seed, the three workers, and provider stubs with health/completion gates. The app image uses Node 22 to match the package engine and runs existing service scripts; admin credentials are isolated to migration/seed jobs while application services use `app_user`.

**Tech Stack:** Docker Compose, PostGIS PostgreSQL 16, ElasticMQ, Node.js 22 slim, existing CommonJS app, `pg`, `jsonwebtoken`, and Node test runner.

**Spec:** `app/docs/superpowers/specs/2026-08-26-local-demo-environment-design.md`

## Global Constraints

- Preserve existing service behavior, RLS, queue semantics, and migration chain.
- Never commit real credentials; Compose defaults are clearly development-only.
- Run application commands from `app/` and repository checks from the repo root as appropriate.
- Keep seed rerunnable and deterministic; use admin DB only for seed/migrations.
- Do not implement frontend, Terraform, Helm, CI/CD, provider integrations, or unrelated upgrades.
- Every code/tooling task follows RED → GREEN → focused verification → coherent commit.

---

### Task 1: Seed data model and rerunnable script

**Files:**
- Create: `app/scripts/seed.js`
- Create: `app/scripts/seed.test.js`
- Modify: `app/package.json`

**Interfaces:**
- Export `buildSeedPlan()` returning deterministic tenants, users, groups, recipients, and memberships.
- Export `seedDatabase({ client, plan })` that runs one transaction using `DATABASE_URL`, resets only fixed demo tenants, and inserts all rows with PostGIS points.
- `npm run seed` connects using `DATABASE_URL`, runs the plan, and prints non-secret summary lines.

- [x] Write tests asserting two fixed tenants, 150 recipients each, stable UUIDs, group membership, locations, and safe rerun SQL/plan behavior.
- [ ] Run `node --test scripts/seed.test.js` and confirm the missing-script failure.
- [x] Implement deterministic plan generation, transaction reset/upsert, and CLI error handling without reading `APP_DATABASE_URL`.
- [ ] Run focused tests, `npm run lint`, and (with the configured DB) `npm run seed` twice; verify stable counts.
- [ ] Commit: `feat: add deterministic demo seed tooling`.

### Task 2: Development JWT generator

**Files:**
- Create: `app/scripts/generate-dev-token.js`
- Create: `app/scripts/generate-dev-token.test.js`
- Modify: `app/package.json`

**Interfaces:**
- `parseArgs(argv)` returns `{ tenantSlug, userEmail }` with documented defaults and rejects unknown/missing values.
- `createToken({ tenantId, userId, secret, sign })` emits HS256 claims `{ tenant_id, sub }` with no extra authorization claims.
- CLI looks up the selected seeded user via `DATABASE_URL` and prints only the token.

- [x] Write failing tests for defaults, explicit arguments, invalid flags, and exact HS256 claim generation with an injected signer.
- [ ] Run the focused test and verify the expected missing-module failure.
- [x] Implement lookup, signing, and development-only usage text; never log `JWT_SECRET` or the token to structured logs.
- [ ] Run focused tests and lint.
- [ ] Commit: `feat: add development JWT generator`.

### Task 3: Container image and ElasticMQ configuration

**Files:**
- Create: `app/Dockerfile`
- Create: `app/elasticmq.conf`
- Create: `app/compose.test.js`

**Interfaces:**
- Dockerfile installs lockfile dependencies and has a neutral default command; Compose selects service scripts.
- ElasticMQ configuration declares `alert-fanout` and `recipient-dispatch` with stable local URLs.
- `compose.test.js` validates required queue names and service/image assumptions from parsed text without requiring Docker.

- [x] Write failing static tests for the Docker base/runtime, lockfile install, queue declarations, and app command availability.
- [ ] Run the focused test and verify failure before files exist.
- [x] Implement the straightforward Node 22 slim image and ElasticMQ config.
- [ ] Run focused tests and `docker compose -f docker-compose.yml config` when Docker is available.
- [ ] Commit: `build: add application image and local queue config`.

### Task 4: Compose orchestration and environment

**Files:**
- Create: `app/docker-compose.yml`
- Modify: `app/.env.example`
- Create: `app/compose-config.test.js`

**Interfaces:**
- Services: `postgres`, `elasticmq`, `migrate`, `seed`, `stubs`, `intake`, `fanout`, `dispatch`.
- Postgres health uses `pg_isready`; ElasticMQ health checks its HTTP endpoint; migrate/seed use completion conditions.
- Application services receive internal DB/SQS/provider URLs and the same development JWT secret; only migrate/seed receive admin `DATABASE_URL`.
- Compose exposes ports 3000, 4000, 4001, 5432, and 9324 for local use.

- [x] Write static tests checking all services, health checks, dependency conditions, queue URLs, RLS-preserving credential split, and no frontend service.
- [ ] Run tests to verify failure before Compose exists.
- [x] Implement Compose with named Postgres volume, no hidden schema startup, and deterministic environment defaults.
- [ ] Run static tests and `docker compose config`.
- [ ] Commit: `build: orchestrate reproducible local backend stack`.

### Task 5: Local-stack smoke verification

**Files:**
- Create: `app/scripts/smoke-local-stack.js`
- Create: `app/scripts/smoke-local-stack.test.js`
- Modify: `app/package.json`

**Interfaces:**
- `waitForHttp(url, options)` polls health/readiness with bounded timeout.
- `runSmoke({ compose, fetchImpl, tokenCommand })` performs start/readiness/token/alert/poll/teardown orchestration; all commands are injectable for tests.
- `npm run smoke:local` is opt-in and documents Docker prerequisites.

- [x] Write unit tests for bounded polling, terminal delivery detection, timeout, and guaranteed `docker compose down` cleanup.
- [ ] Run focused tests and verify the expected missing-module failure.
- [x] Implement the smoke runner without embedding secrets or modifying application services.
- [ ] Run focused tests; if Docker is available, execute the real smoke command and preserve logs on failure before teardown.
- [ ] Commit: `test: add local stack smoke verification`.

### Task 6: Documentation and final verification

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`
- Modify: `app/.env.example` if needed by final command examples

- [x] Update prerequisites, `docker compose up --build`, migration/seed/token commands, group/polygon curls, state inspection, shutdown, and volume reset instructions.
- [x] State clearly that credentials and JWT tooling are development-only and frontend remains deferred.
- [ ] Run `npm test`, `npm run test:integration`, `npm run lint`, `git diff --check`, and Compose config validation.
- [ ] Run the real smoke test when Docker is available, then shut down cleanly.
- [ ] Commit: `docs: document reproducible local demo environment`.

### Task 7: Clean handoff

- [x] Inspect `git status --short` and recent commits.
- [x] Confirm no generated tokens, env files, volumes, or credentials were added.
- [x] Leave the worktree clean and do not push.
