# Final DX, Demo Authentication, and Geographic Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add demo login, repair and prove geographic targeting, and make the existing Compose architecture immediately usable from a clean checkout.

**Architecture:** Keep all current runtime boundaries. Add login to intake using tenant-root lookup followed by RLS-scoped user lookup, share JWT/password helpers, gate the existing frontend with session auth, and test the frontend polygon contract through the durable backend path.

**Tech Stack:** Node.js 22/CommonJS, Express, PostgreSQL/PostGIS, JWT, built-in crypto scrypt, React/Vite, MapLibre, Terra Draw, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-08-30-final-dx-auth-geographic-polish-design.md`

## Global Constraints

- Do not add services, frameworks, ORMs, or external identity providers.
- All tenant-owned application data access uses `createDb(pool).withTenant()`.
- Identity derives only from verified credentials/JWT claims.
- Demo secrets remain configurable and explicitly non-production.
- Follow RED → GREEN for behavior changes and do not commit or push.

---

### Task 1: Shared demo credential and JWT contracts

**Files:** Create `src/shared/demo-auth.js`, `src/shared/demo-auth.test.js`; modify `scripts/generate-dev-token.js`, its test, `scripts/seed.js`, its test, `src/shared/config.js`, its test, and `.env.example`.

**Interfaces:** `hashDemoPassword(password, salt) -> "scrypt$<salt>$<hex>"`; `verifyDemoPassword(password, encoded) -> boolean`; `issueJwt({ tenantId, userId, secret, sign }) -> token`; config exposes `demoUserPassword`.

- [ ] Write failing tests for deterministic hashes, valid/invalid verification, malformed hashes, exact JWT claims, configurable seed password, and config mapping.
- [ ] Run focused tests and confirm expected failures.
- [ ] Implement minimal helpers and switch seed/token tooling to them.
- [ ] Run focused tests and backend unit tests.

### Task 2: RLS-safe login endpoint

**Files:** Create `src/intake/login.js`, `src/intake/login.test.js`; modify `src/intake/app.js`, `src/intake/app.test.js`.

**Interfaces:** `createLoginRouter({ db, jwtSecret })`; `POST /api/auth/login` accepts strict tenant slug/email/password and returns `{ token }`; invalid credentials always return `401 invalid_credentials`.

- [ ] Write failing router/application tests for success, invalid credentials, strict validation, correct claims, public login, and unchanged protected-route rejection.
- [ ] Run focused tests and confirm missing route behavior.
- [ ] Implement tenant-root lookup via `db.pool`, user lookup via `db.withTenant`, timing-safe password verification, and shared JWT issuance.
- [ ] Run focused and complete backend unit tests.

### Task 3: Frontend session authentication

**Files:** Modify `web/src/api.js`, `web/src/api.test.js`, `web/src/App.jsx`, `web/src/components/Header.jsx`, `web/src/styles.css`; create `web/src/views/LoginView.jsx`, `web/src/views/LoginView.test.jsx`, `web/src/App.test.jsx`; remove token-panel use and its obsolete tests/component.

**Interfaces:** API adds `login(credentials)` without bearer auth; protected `401` invokes `onUnauthorized`; App stores `demo-token` in session storage, shows login when absent, and logout clears state.

- [ ] Write failing tests for login requests, bearer attachment, 401 clearing, login rendering/submission, session restoration, and logout.
- [ ] Run focused frontend tests and confirm failures.
- [ ] Implement the minimal login/session/authenticated-shell flow.
- [ ] Run frontend tests and lint.

### Task 4: Deterministic geographic demo and editor UX

**Files:** Modify `scripts/seed.js`, `scripts/seed.test.js`, `web/src/components/PolygonEditor.jsx`, its test, `web/src/views/ComposeView.jsx`, its test, and `web/src/styles.css`.

**Interfaces:** Export one `DEMO_POLYGON` contract from a small frontend data module if needed by tests; Terra Draw calls `setMode('polygon')`; seeded coordinate roles identify inside/outside/boundary/other-tenant cases.

- [ ] Write failing seed assertions and mocked editor tests proving polygon-mode activation, loading/error text, instructions, and exact preset output.
- [ ] Run focused tests and confirm current preset/mode failures.
- [ ] Align preset/viewport and deterministic points; implement accessible map status/instructions and explicit mode selection.
- [ ] Run focused backend/frontend tests and build.

### Task 5: Full geographic integration coverage

**Files:** Modify `test/integration/fanout-store.test.js`, `test/integration/fanout-acceptance.test.js`; create `test/integration/geographic-pipeline.test.js`.

**Interfaces:** The pipeline test submits the frontend preset-equivalent polygon through intake, observes the durable outbox payload, processes it through fanout, and asserts exact tenant-owned delivery recipients and dispatch jobs.

- [ ] Write failing integration coverage for explicit inside, outside, boundary, other-tenant, invalid geometry, and intake-to-fanout delivery creation.
- [ ] Run with a clean `.env` copied from `.env.example` and confirm failures expose current demo mismatch/missing pipeline coverage.
- [ ] Make only fixture/production corrections required by the tests.
- [ ] Run targeted and full integration suites.

### Task 6: Compose and clean-checkout ergonomics

**Files:** Modify `docker-compose.yml`, `compose-config.test.js`, `.env.example`, and smoke tests/scripts as required.

**Interfaces:** intake/fanout/dispatch health checks their existing `/readyz`; web depends on healthy intake; long-running services use `restart: unless-stopped`; jobs retain no restart loop; live smoke logs in and submits a polygon.

- [ ] Write failing static/smoke tests for health dependencies, restart boundaries, login, and polygon request.
- [ ] Run tests and confirm current Compose behavior fails expectations.
- [ ] Implement Compose and smoke changes without changing service boundaries.
- [ ] Validate `docker compose config` and build images.

### Task 7: README and source-of-truth documentation

**Files:** Modify repository `README.md`, `docs/APP_SPEC.md`, `DECISIONS.md`, `docs/DEPLOYMENT_HANDOFF.md`, and `CLAUDE.md` where current manual-token statements are stale.

- [ ] Restructure README happy path and document architecture, prerequisites, health checks, credentials, repository map, service dependencies, and exact geographic workflow/boundary behavior.
- [ ] Update authoritative/current-state docs narrowly for approved demo login and geographic verification.
- [ ] Check every documented command/port/credential against code and Compose.

### Task 8: Complete validation and live proof

- [ ] Create a temporary clean environment from `.env.example`, avoiding the developer `.env`.
- [ ] Run backend unit and integration suites plus lint.
- [ ] Run frontend tests, lint, and production build.
- [ ] Run Compose config validation and image builds.
- [ ] Start the full stack and execute login → polygon submit → outbox → fanout → dispatch → terminal delivery assertions, including exact non-zero tenant-scoped recipients.
- [ ] Shut the stack down, run `git diff --check`, inspect status, and report evidence without committing.
