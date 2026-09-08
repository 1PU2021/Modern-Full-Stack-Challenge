# Dispatch Service and Provider Stubs Design

## Goal

Complete the asynchronous backend path after fanout: consume one dispatch job
per delivery, call a channel provider stub, and record a tenant-scoped
terminal or retryable delivery outcome.

This design follows `app/docs/APP_SPEC.md` and the accepted decisions in
`app/DECISIONS.md`. Existing intake and fanout contracts remain unchanged.

## Scope

Included:

- a dispatch queue consumer and service entrypoint;
- tenant-scoped delivery loading and outcome bookkeeping;
- abortable HTTP clients for SMS and email provider stubs;
- deterministic, configurable SMS and email Express stubs;
- retry, max-attempt, duplicate-message, metrics, operations, logging, and
  graceful-shutdown behavior;
- automated dispatch/provider and end-to-end acceptance tests.

Deferred:

- frontend, Docker/Compose, seed tooling, Terraform, Helm, CI/CD, and
  production observability;
- real provider SDKs or external credentials;
- schema changes to add a processing status or lease column.

## Contracts and retryability

Fanout emits a JSON dispatch job with the exact fields:

```json
{
  "deliveryId": "uuid",
  "alertId": "uuid",
  "tenantId": "uuid",
  "recipientId": "uuid",
  "channel": "sms"
}
```

Dispatch validates all fields and uses `deliveryId` as the logical identity.
The first database transaction runs through `withTenant(tenantId, ...)`,
locks the delivery row, verifies the alert/recipient/channel identity, and
decides whether another attempt is allowed. It increments `attempt_count`
before any provider call and commits. The provider call is outside the
transaction. A second short tenant transaction records the result.

The existing status enum is deliberately reused:

- `delivered` is terminal and never regresses;
- `failed`, `rate_limited`, and `timed_out` describe the most recent attempt;
- those three statuses remain retryable while `attempt_count` is below
  `MAX_DELIVERY_ATTEMPTS`;
- when the cap is reached, the most recent failure status is terminal and the
  queue message is acknowledged;
- an explicitly permanent provider error may become terminal immediately;
- `pending` is also retryable.

The first transaction performs the cap check while holding `FOR UPDATE`, so a
redelivered message cannot increment an exhausted row. Duplicate messages
that race before either has recorded an outcome can still both invoke the
external provider. This is the unavoidable at-least-once crash/concurrency
window: the attempt increment is durable before the network call, the call is
outside the transaction, and exactly-once external invocation is not claimed.
The unique delivery row and conditional terminal update prevent duplicate
logical rows and prevent `delivered` from regressing.

For retryable outcomes below the cap, dispatch does not delete the SQS
message; visibility timeout makes it eligible again. At the cap, or for a
permanent provider result, dispatch records the terminal status and deletes
the message. A malformed job or missing/mismatched delivery is permanent and
is acknowledged without exposing raw message content.

## Provider outcome classification

The provider client sends a JSON request to the channel URL with the alert,
recipient, and delivery identifiers. It uses an `AbortController` timeout
(short enough to protect the worker; tests inject a smaller value).

| Provider result | Dispatch outcome | Queue action below cap |
|---|---|---|
| HTTP 2xx | `delivered` | acknowledge |
| HTTP 429 | `rate_limited` | leave message for redelivery |
| HTTP 408/504 or client timeout | `timed_out` | leave message for redelivery |
| HTTP 5xx/network error | `failed` | leave message for redelivery |
| HTTP 4xx other than 408/429 | permanent failure | record terminal `failed`, acknowledge |

Provider response bodies are bounded before logging or persistence. Metric
labels use only the bounded channel and outcome values above.

## Dispatch components

### Store

`src/dispatch/store.js` exposes a small persistence boundary:

- `beginAttempt(job, maxAttempts)` returns `skip`, `attempt`, or `permanent`
  after the locked transaction;
- `recordOutcome(job, attempt, outcome)` records the status and bounded
  provider response in a short tenant transaction, conditionally updating
  only a non-delivered row;
- terminal alert completion is updated when no non-terminal deliveries remain.

All tenant-owned queries use `withTenant` and explicit tenant predicates.

### Provider client and processor

`src/dispatch/providers.js` maps channels to URLs and performs abortable HTTP
calls. `src/dispatch/processor.js` parses a message, begins an attempt, calls
the provider outside the transaction, records the outcome, updates metrics,
and acknowledges only when processing is terminal. It emits structured child
logs containing bounded identifiers and attempt/channel fields, never raw
message bodies or authorization data.

### Worker and service

`src/dispatch/worker.js` follows the existing fanout worker pattern: receive
up to 10 messages with a 10-second long poll and 60-second visibility
timeout, process sequentially, refresh `recipient-dispatch` queue gauges,
and stop/abort predictably. `src/dispatch/ops.js`, `lifecycle.js`, and
`index.js` provide `/healthz`, `/readyz`, `/metrics`, signal handling, a
25-second graceful deadline, and second-signal forced exit.

## Provider stubs

`src/stubs/` contains a shared personality and two simple Express servers
started by one entrypoint:

- SMS: `POST /sms/send` on the configured SMS URL (default port 4000);
- Email: `POST /email/send` on the configured email URL (default port 4001).

Each personality has the APP_SPEC starting ranges: latency, baseline failure
rate, degraded latency/failure rate, and token-bucket capacity/refill. A
correlated degradation window is shared by calls to that personality. Email
can deliberately hang for its configured small probability. Constructor
options inject `random`, `now`, and `sleep`, and tests use deterministic
sequences rather than relying on random timing. Responses are simple JSON:
2xx success, 429 with `Retry-After`, or bounded 5xx failure. The stubs have
health routes and close cleanly on shutdown.

## Metrics and operations

The dispatch service updates the existing shared metrics:

- `dispatch_delivery_outcome_total{channel,outcome}` for each recorded
  provider outcome;
- `alert_intake_to_delivery_seconds{channel}` when a delivery first reaches a
  terminal state, using `deliveries.created_at` as the start time;
- `queue_backlog_depth{queue="recipient-dispatch"}` and
  `queue_inflight_messages{queue="recipient-dispatch"}` from SQS attributes.

Operational endpoints are public and do not reveal database errors. Readiness
checks database reachability and returns 503 after shutdown begins.

## Testing boundaries

- Unit tests cover validation, store transaction decisions, provider outcome
  classification/timeouts, stub personalities, processor acknowledgement,
  worker cancellation, metrics, and lifecycle behavior.
- Integration tests use the existing migrated PostgreSQL fixture to prove
  tenant isolation, retry/max-attempt bookkeeping, terminal monotonicity, and
  duplicate dispatch messages.
- Acceptance coverage wires a real alert/fanout-created delivery through the
  dispatch processor and a deterministic HTTP provider stub to a terminal
  outcome. No real SQS or external provider credentials are required for the
  deterministic acceptance test.
