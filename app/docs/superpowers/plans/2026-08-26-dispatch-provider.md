# Dispatch and Provider Stubs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Complete the backend async path by consuming fanout dispatch jobs, invoking deterministic SMS/email stubs, and recording retryable or terminal delivery outcomes.

**Architecture:** Dispatch uses short tenant-scoped transactions to lock and increment a delivery attempt, performs provider HTTP outside the transaction, then records the bounded outcome in another short transaction. Existing delivery statuses remain the latest attempt outcome; retryability is derived from `attempt_count < MAX_DELIVERY_ATTEMPTS`, with `delivered`, exhausted failures, and explicitly permanent provider errors terminal. Two simple provider servers share injectable personality logic and deterministic test controls.

**Tech Stack:** Node.js CommonJS, Express, PostgreSQL/PostGIS via `pg`, SQS via `@aws-sdk/client-sqs`, native `fetch`, Zod, Pino, `prom-client`, and Node test runner.

**Spec:** `app/docs/superpowers/specs/2026-08-26-dispatch-provider-design.md`

## Global Constraints

- Follow `app/docs/APP_SPEC.md` and `app/DECISIONS.md`; do not redesign intake or fanout.
- All tenant-owned queries use `createDb(pool).withTenant(tenantId, ...)` plus explicit tenant predicates.
- Provider calls happen outside database transactions and are abortable.
- Retryable failure statuses remain eligible below `MAX_DELIVERY_ATTEMPTS`; never skip merely because status is not `pending`.
- `delivered` is monotonic and never regresses.
- Use bounded metric labels and structured logs without raw message bodies or secrets.
- Keep the implementation demo-grade; no provider SDKs, schema migration, Docker/Compose, frontend, or governance work.
- Run commands from `app/`; finish each task with focused tests, lint as relevant, and a conventional commit.

---

### Task 1: Dispatch job and provider outcome contracts

**Files:**
- Create: `app/src/dispatch/schemas.js`
- Create: `app/src/dispatch/schemas.test.js`
- Create: `app/src/dispatch/providers.js`
- Create: `app/src/dispatch/providers.test.js`

**Interfaces:**
- `parseDispatchJob(body)` returns `{ deliveryId, alertId, tenantId, recipientId, channel }` or throws a bounded permanent error.
- `classifyProviderResponse(response)` returns `{ outcome, retryable, permanent }` for status 2xx/429/408/504/other 4xx/5xx.
- `createProviderClient({ urls, fetchImpl, timeoutMs })` exposes `send(job, { abortSignal })` and returns `{ outcome, retryable, permanent, response }`.

- [ ] Write failing tests for exact UUID/channel validation, bounded errors, HTTP classification, network failures, timeout classification, and abort propagation.
- [ ] Run `node --test src/dispatch/schemas.test.js src/dispatch/providers.test.js` and verify failure because the modules are absent.
- [ ] Implement the schemas and provider client with native `fetch`, an internal timeout controller, bounded JSON/text response extraction, and no raw body logging.
- [ ] Rerun the focused tests and then `npm test`.
- [ ] Commit: `feat: add dispatch contracts and provider client`.

### Task 2: Tenant-scoped delivery attempt store

**Files:**
- Create: `app/src/dispatch/store.js`
- Create: `app/src/dispatch/store.test.js`
- Create: `app/test/integration/dispatch-store.test.js`

**Interfaces:**
- `createDispatchStore({ db, maxAttempts })` returns:
  - `beginAttempt(job)` → `{ kind: 'skip'|'attempt'|'permanent', attemptCount, delivery }`.
  - `recordOutcome(job, attempt, result)` → `{ terminal, status }`.
- `beginAttempt` locks the matching row with `FOR UPDATE`, checks identity, skips delivered/exhausted rows, increments attempts for retryable rows, and returns a permanent miss for malformed/missing/cross-tenant delivery.
- `recordOutcome` updates status/provider response/updated timestamps conditionally, preserves delivered, and marks an exhausted failure terminal.

- [ ] Write unit tests for delivered skip, exhausted failure skip, retry after failed/rate-limited/timed-out below cap, identity mismatch, permanent result, and monotonic delivered updates.
- [ ] Run the focused unit test and verify the expected missing-module failure.
- [ ] Implement both short `withTenant` transactions with explicit tenant predicates and bounded provider response persistence.
- [ ] Add integration fixtures proving RLS isolation, race-safe cap checks, retryability of prior failure statuses, and no duplicate delivery rows.
- [ ] Run focused unit/integration tests and lint.
- [ ] Commit: `feat: add tenant-scoped dispatch bookkeeping`.

### Task 3: Dispatch processor and outcome metrics

**Files:**
- Create: `app/src/dispatch/processor.js`
- Create: `app/src/dispatch/processor.test.js`
- Modify: `app/src/shared/metrics.js`
- Modify: `app/src/shared/metrics.test.js`

**Interfaces:**
- `createDispatchProcessor({ store, providers, ack, metrics, logger, now })` returns `process(message, { abortSignal })`.
- Malformed/permanent/exhausted messages are acknowledged; retryable provider outcomes below cap are left unacknowledged; delivered is acknowledged.
- `alert_intake_to_delivery_seconds{channel}` observes only the first terminal outcome using the delivery’s `created_at`.

- [ ] Write tests for provider success, retryable failure below cap, rate limiting, timeout, permanent failure, max-attempt terminal acknowledgement, malformed input, duplicate delivered message, and metrics labels/latency.
- [ ] Run focused tests to observe missing processor/metric behavior.
- [ ] Implement sequential store/provider/store flow with child logging and conditional acknowledgement.
- [ ] Verify focused tests, full unit tests, and lint.
- [ ] Commit: `feat: process dispatch jobs and outcomes`.

### Task 4: Dispatch worker and operations lifecycle

**Files:**
- Create: `app/src/dispatch/worker.js`
- Create: `app/src/dispatch/worker.test.js`
- Create: `app/src/dispatch/ops.js`
- Create: `app/src/dispatch/ops.test.js`
- Create: `app/src/dispatch/lifecycle.js`
- Create: `app/src/dispatch/lifecycle.test.js`

**Interfaces:**
- `createDispatchWorker({ receive, process, getQueueCounts, metrics, logger, sleep })` long-polls recipient-dispatch with max 10, wait 10 seconds, visibility 60 seconds, and processes sequentially.
- Queue gauges use only `queue="recipient-dispatch"`.
- Ops exposes `/healthz`, `/readyz`, `/metrics`; lifecycle supports graceful stop, 25-second deadline abort, socket cleanup, and second-signal force.

- [ ] Write failing worker/ops/lifecycle tests for bounded receive, continue-on-error, queue metrics, readiness, graceful drain, abort, deadline, and forced shutdown.
- [ ] Run focused tests and confirm missing implementations fail.
- [ ] Implement using the tested fanout lifecycle pattern without modifying fanout.
- [ ] Run focused tests, full unit tests, and lint.
- [ ] Commit: `feat: add dispatch worker operations and shutdown`.

### Task 5: Dispatch service entrypoint

**Files:**
- Create: `app/src/dispatch/index.js`
- Create: `app/src/dispatch/index.test.js`

**Interfaces:**
- `startDispatch(overrides = {})` composes config, app database pool, queue client, metrics, provider client, store, processor, worker, ops app, and lifecycle coordinator; tests inject factories.
- Queue adapters bind `RECIPIENT_DISPATCH_QUEUE_URL`; sends bind configured provider URLs; queue acknowledgement uses the input receipt handle.
- `require.main === module` starts the service with SIGTERM/SIGINT handlers and startup error handling.

- [ ] Write failing composition tests for configured queue/provider bindings, worker start, signal wiring, and server error handling.
- [ ] Run focused tests to verify missing entrypoint behavior.
- [ ] Implement composition and bounded adapters using existing shared helpers.
- [ ] Run focused tests, full unit tests, and lint.
- [ ] Commit: `feat: compose dispatch service entrypoint`.

### Task 6: Provider personality and stub servers

**Files:**
- Create: `app/src/stubs/personality.js`
- Create: `app/src/stubs/personality.test.js`
- Create: `app/src/stubs/app.js`
- Create: `app/src/stubs/app.test.js`
- Create: `app/src/stubs/index.js`
- Create: `app/src/stubs/index.test.js`

**Interfaces:**
- `createProviderPersonality(options)` exposes `handle(request, { abortSignal })`, with injected `random`, `now`, and `sleep` plus latency/failure/rate/degradation options.
- `createStubApp({ channel, personality, readiness })` exposes `POST /sms/send` or `/email/send` and `/healthz`.
- `startStubs(overrides = {})` starts SMS and email servers on the configured provider URLs/ports and returns servers plus a shutdown function.

- [ ] Write deterministic tests for successful latency, baseline failure, token-bucket 429/Retry-After, correlated degradation, email hang, malformed requests, and health routes.
- [ ] Run focused tests to verify missing stub modules fail.
- [ ] Implement the smallest injectable personality and two-server composition using APP_SPEC starting ranges; support deterministic overrides for acceptance tests.
- [ ] Run focused tests, full unit tests, and lint.
- [ ] Commit: `feat: add deterministic provider stubs`.

### Task 7: End-to-end dispatch acceptance and documentation

**Files:**
- Create: `app/test/integration/dispatch-acceptance.test.js`
- Modify: `README.md`
- Modify: `CLAUDE.md`
- Modify: `app/.env.example` only if dispatch timeout/stub controls require a documented new variable.

**Interfaces:**
- Acceptance fixture creates an alert and fanout delivery rows using existing helpers, sends a dispatch job through the processor to a deterministic HTTP stub, and verifies a terminal delivery row and metrics.

- [ ] Write the acceptance test first for accepted alert → fanout materialization → dispatch job → provider HTTP stub → delivered outcome, plus retry exhaustion and duplicate-message behavior.
- [ ] Run the focused integration test to observe its initial failure.
- [ ] Implement only the fixture wiring needed; do not add Docker/Compose or unrelated seed infrastructure.
- [ ] Update docs to state dispatch/stubs are functional, explain retry/max-attempt semantics, and retain deferred scope.
- [ ] Run the focused acceptance test, full unit suite, full integration suite, lint, and `git diff --check`.
- [ ] Commit: `docs: record functional dispatch and provider path`.

### Task 8: Final verification and clean handoff

**Files:**
- No planned source changes.

- [ ] Run `npm test` from `app/` and record the passing count.
- [ ] Run `npm run test:integration` from `app/` and record the passing count.
- [ ] Run `npm run lint` from `app/`.
- [ ] Run `git diff --check` from the repository root.
- [ ] Inspect `git status --short` and `git log --oneline`; leave the worktree clean and do not push.
