# AGENTS.md

## Project source of truth

Read these before changing implementation:

1. `app/docs/APP_SPEC.md` — authoritative application specification.
2. `app/DECISIONS.md` — accepted design decisions, known limitations, and deliberate scope boundaries.
3. Existing plans under `app/docs/superpowers/plans/` — implementation history and prior Superpowers design work.
4. `CLAUDE.md` — additional project context from earlier Claude Code sessions.

If implementation, plans, or comments conflict with `app/docs/APP_SPEC.md`, treat `app/docs/APP_SPEC.md` as authoritative unless a newer decision in `app/DECISIONS.md` explicitly amends it.

## Development workflow

This project uses the Superpowers workflow.

Use the appropriate Superpowers skills for:
- brainstorming before new implementation slices,
- writing implementation plans,
- test-driven development where practical,
- systematic debugging,
- implementation review,
- and verification before declaring work complete.

Do not invent a separate workflow when an applicable Superpowers skill already exists.

Existing plans are execution/reference documents. Checkbox state is not authoritative proof of completion; confirm actual state from the repository, tests, and commit history.

## Current Git workflow

The instructor wants functionality first and repository-process complexity later.

For now:
- Do not require branch protection.
- Do not require a formal pull-request workflow.
- Do not introduce approval gates or other production-grade Git governance unless explicitly requested.
- Keep commits small, coherent, and easy to review.
- Run tests and lint before a logical stopping point.
- Preserve a clean, understandable commit history.

Production-grade repository controls may be added later if the instructor asks for them.

## Application architecture

This is a demo-grade Critical Notification Platform used as the workload for a broader platform-engineering challenge.

Core flow:

`intake -> durable queue -> fanout -> dispatch -> provider stubs`

The application is intentionally simple except where correctness materially affects the challenge.

The following must remain correct:
- tenant isolation,
- delivery-outcome bookkeeping,
- graceful shutdown,
- durable alert acceptance and publication.

## Technology constraints

- Node.js 20+
- JavaScript
- CommonJS
- Express
- PostgreSQL 16 + PostGIS
- Amazon SQS in deployed environments
- ElasticMQ for local development
- Zod validation
- JWT authentication
- Pino structured logging
- Prometheus metrics via `prom-client`
- One backend package
- One backend image with multiple service entrypoints

Do not introduce additional frameworks, ORMs, DI containers, generic repository layers, or architectural abstractions unless there is a concrete need approved during design.

Prefer the simplest implementation that satisfies `app/docs/APP_SPEC.md`.

## Database and tenant isolation

Tenant isolation is structural and database-enforced.

All tenant-scoped application queries must use:

`createDb(pool).withTenant(tenantId, ...)`

Application queries should also include explicit tenant predicates where appropriate, but PostgreSQL RLS is the independent fail-closed boundary.

Do not bypass `withTenant()` for tenant-owned application data.

Direct pool access is reserved for documented non-tenant operational cases such as:
- readiness checks,
- enumerating the tenant-root table where explicitly required by the architecture.

RLS-protected tenant-owned tables are defined by `app/docs/APP_SPEC.md`.

Known schema limitations are documented in `app/DECISIONS.md`; do not silently “fix” them by expanding scope.

## Configuration

Use `app/src/shared/config.js` as the configuration boundary.

Do not read application configuration directly from `process.env` elsewhere unless an existing documented exception applies.

Never commit real credentials, secrets, tokens, or database URLs.

## Logging

Use structured Pino logging.

Prefer stable fields such as:
- `service`
- `request_id`
- `tenant_id`
- `alert_id`
- `event_id`
- `channel`
- `attempt_count`

Only include fields when they are semantically applicable.

Never log:
- JWTs,
- authorization headers,
- secrets,
- full request bodies containing alert content,
- raw database URLs,
- sensitive provider responses.

## Metrics

Preserve the metric names defined in `app/docs/APP_SPEC.md` unless the spec is intentionally amended.

Use bounded metric labels.

Never use raw exception messages, arbitrary IDs, or other unbounded values as metric labels unless explicitly approved.

## API identity rules

Tenant and user identity come from verified JWT claims.

Never accept `tenant_id`, creator identity, or equivalent authorization context from client request bodies or query parameters.

Cross-tenant resources should appear nonexistent to the caller where the spec requires isolation, typically returning `404` rather than revealing that the resource exists.

## Reliability

The system uses at-least-once messaging semantics.

Do not assume exactly-once delivery from SQS.

Components consuming durable events must tolerate duplicates where required by their design.

For the intake service, accepted alerts must not be permanently stranded by a database-success/SQS-failure boundary. Follow the transactional-outbox design approved in the intake design work.

Avoid holding database transactions open across network calls when a short claim/lease transaction can be used instead.

## Graceful shutdown

Service lifecycle behavior is part of correctness for this challenge.

On shutdown:
- stop advertising readiness,
- stop accepting new work,
- stop claiming new background work,
- allow in-flight work to complete within the configured grace period,
- release resources cleanly,
- leave interrupted durable work retryable.

Shutdown logic should remain testable without requiring real process signals.

## Scope discipline

Do not expand an implementation slice simply because adjacent functionality is obvious.

Examples:
- intake work should not silently absorb fanout or dispatch,
- backend work should not silently absorb frontend work,
- application work should not silently absorb infrastructure or CI/CD concerns.

When a design issue materially changes the schema, architecture, or scope, surface it for approval rather than deciding silently.

## Verification

Before declaring a task or implementation slice complete, run the relevant checks.

At minimum, where applicable:

```bash
npm --prefix app test
npm --prefix app run test:integration
npm --prefix app run lint
git diff --check
```

Also run any additional targeted tests introduced by the implementation.

Do not report success based only on code inspection when executable verification is available.
