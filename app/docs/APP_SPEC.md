# Critical Notification Platform — Application Spec

This is the workload the rest of the tech challenge deploys, scales, and breaks on
purpose. It is the thing running inside the Kubernetes cluster, behind the load
balancer, talking to the managed database — everything the SysAdmin, Cloud
Engineer, DevOps Engineer, and SRE are building infrastructure around.

**Robustness bar: demo-grade, not production-grade.** This is a proof of concept
for a platform engineering challenge, not a system going in front of real 911
dispatch centers. Keep things simple wherever "simple" and "correct" don't
conflict. Where they do conflict — tenant isolation, the delivery-outcome
bookkeeping, graceful shutdown — pick correct, because those are the things the
rest of the challenge's evaluation actually exercises (burst testing, chaos
exercises, the cross-tenant isolation test).

---

## 1. What it does, in one paragraph

An authenticated operator submits an alert (title, body, priority, channels,
and a target — either a saved group or a geographic polygon). The system
accepts it immediately, resolves the target into a concrete list of recipients
in the background, and pushes a notification to each recipient over every
requested channel (SMS, email), recording a per-recipient delivery outcome the
operator can watch fill in live.

---

## 2. Stack

| Concern | Choice | Why |
|---|---|---|
| Language/runtime | Node.js 20, JavaScript (CommonJS) | Fan-out and dispatch work is I/O-bound (waiting on provider HTTP calls) — a good fit for an event loop. Keeps the whole team on one language for the app layer. |
| Backend framework | Express | Minimal, well understood, nothing about this workload needs more. |
| Database | PostgreSQL 16 + PostGIS | Row-level security gives database-enforced tenant isolation. PostGIS gives native polygon-to-recipient resolution for geographic targeting. Both are hard requirements once "both targeting methods" and "isolation must be proven" are in scope. |
| Queue | Amazon SQS in real environments; ElasticMQ (SQS-compatible) for local dev | Same client code (`@aws-sdk/client-sqs`) runs against both — only the endpoint changes. Durable queue between intake and delivery is a hard requirement of the challenge. |
| Frontend | React (Vite), plain fetch, React Router | Small, fast dev loop, no need for a component library or state management library at this scope. |
| Validation | Zod | Schema validation with good error messages, minimal ceremony. |
| Auth | JWT with a `tenant_id` claim | Every tenant-scoped query derives its tenant from a verified claim, never from a client-supplied value. |
| Logging | pino, structured JSON | Required by the observability section of the challenge — logs need `tenant_id`, `alert_id`, `channel` on every line. |
| Metrics | prom-client | Required by the observability section — the intake-to-delivery histogram is the core SLI the whole dashboard and SLO alerting is built on. |

No voice channel. SMS and email only.

### Metrics map to the four golden signals

The SRE's dashboards are organized around the four golden signals (latency,
traffic, errors, saturation), so the metrics this app exposes on `/metrics`
are named and labeled to slot into that layout without translation:

| Golden signal | Metric | Exposed by |
|---|---|---|
| Latency | `alert_intake_to_delivery_seconds` (histogram) | dispatch — this is the core SLI |
| Traffic | `alert_intake_accepted_total` | intake |
| Errors | `dispatch_delivery_outcome_total{outcome=...}`, `alert_intake_rejected_total` | intake, dispatch |
| Saturation | `queue_backlog_depth{queue=...}` | fanout, dispatch |

Database replication lag and compute saturation are infrastructure-layer
metrics (Aurora `AuroraReplicaLag`, node/pod resource usage) — not exposed by
this app, but the app's own saturation metric (queue backlog) is the piece
that's this codebase's responsibility to get right.

---

## 3. Repo layout

```
/
├── package.json                 # single package, four backend entrypoints
├── Dockerfile                   # one image, command selects which service runs
├── docker-compose.yml           # postgres+postgis, elasticmq, all four services, web
├── .env.example
├── migrations/                  # node-pg-migrate, one file per change, up+down
├── scripts/
│   ├── seed.js                  # loads synthetic tenants/recipients/groups
│   └── generate-dev-token.js    # mints a JWT for a seeded tenant, for curl/testing
├── src/
│   ├── shared/                  # config, db (RLS-aware pool), queue, logger, metrics
│   ├── intake/                  # Express API: POST/GET alerts, groups
│   ├── fanout/                  # SQS consumer: resolves recipients, enqueues dispatch jobs
│   ├── dispatch/                # SQS consumer: calls providers, records outcomes
│   └── stubs/                   # Express: fake SMS/email providers with realistic misbehavior
└── web/                         # Vite React app: compose, alert list, alert detail, login
```

One `package.json`, one Docker image, four container commands (`npm run intake`,
`fanout`, `dispatch`, `stubs`). This keeps one artifact SHA traceable to
whatever's running in any of the four roles — useful later for the "what's
running in production and who approved it" requirement in the CI/CD section.

### Git workflow

This repo is public and going in a portfolio, so the workflow should hold up
to a stranger reading the commit history, not just satisfy the challenge's
branch-protection requirement:

- `main` is protected: no direct pushes, PR required, at least one approving
  review, status checks (lint/test/build from the CI pipeline) must pass
  before merge. This is configured in the GitHub repo settings directly —
  whoever has admin on `1PU2021/Modern-Full-Stack-Challenge` needs to turn
  it on; it isn't something that lives in code.
- Short-lived feature branches, one per piece of work:
  `feat/polygon-targeting`, `fix/dispatch-retry-backoff`, `chore/seed-data`.
- Commit messages follow
  [Conventional Commits](https://www.conventionalcommits.org/)
  (`feat:`, `fix:`, `chore:`, `docs:`) — reads cleanly in a portfolio context
  and gives the CI pipeline a hook for automated changelog generation later
  if you want it.
- **Sign commits.** Since "verified commits" matters for the portfolio
  story, set up GPG or SSH commit signing locally
  (`git config commit.gpgsign true`) and add the key to your GitHub account
  before the first commit — retrofitting signed history onto existing
  commits means rewriting them, which is best avoided on a shared repo.
- PRs stay small enough to actually review — one logical change, not a
  50-file drop. A reviewer (even a future-you, or an interviewer skimming
  the history) should be able to tell what changed and why from the PR
  description alone.

---

## 4. Data model

### Tenants
The root of the isolation model. Every other tenant-scoped table has a
`tenant_id` foreign key and a row-level security policy keyed on it.

```
tenants
  id            uuid pk
  slug          text unique not null
  name          text not null
  tenant_type   text not null check in
                  ('state_agency','county_em','school_district',
                   'hospital_system','dispatch_center')
  active        boolean not null default true
  created_at    timestamptz not null default now()
```

### Users
Operators who log in and submit alerts. Email is globally unique,
case-insensitively, so tenant login can resolve identity without asking for a
tenant slug.

```
users
  id             uuid pk
  tenant_id      uuid fk -> tenants, not null
  email          text not null
  password_hash  text not null
  role           text not null default 'operator' check in ('operator','tenant_admin')
  created_at     timestamptz not null default now()
  unique index on lower(email)
```

### Recipients
The people who get notified. `location` is a PostGIS `geography(Point,4326)`
column — required for polygon targeting, optional otherwise (a recipient with
no location can still receive group-targeted alerts, just never a polygon
one).

```
recipients
  id          uuid pk
  tenant_id   uuid fk -> tenants, not null
  name        text not null
  phone       text
  email       text
  address_line1   text
  address_line2   text
  city            text
  state           text
  postal_code     text
  country         text
  location        geography(Point,4326)
  deactivated_at  timestamptz
  created_at      timestamptz not null default now()
```
GIST index on `location` — required for polygon containment queries to be
fast rather than a sequential scan.

The postal address columns are the tenant-admin-facing primary input;
`location` is the derived geography column polygon targeting actually
queries. A tenant admin normally enters an address, which the intake API
geocodes (see `src/intake/geocoder.js`) into `location` atomically with the
address write. Raw `location` (via explicit longitude/latitude) remains an
available advanced/manual override — e.g. when no geocoder is configured, or
an address can't be resolved — so `location` is never gated behind a working
geocoder alone.

### Groups + group_members
Saved recipient lists an operator can target directly.

```
groups
  id          uuid pk
  tenant_id   uuid fk -> tenants, not null
  name        text not null
  created_at  timestamptz not null default now()

group_members
  group_id      uuid fk -> groups, not null
  recipient_id  uuid fk -> recipients, not null
  tenant_id     uuid fk -> tenants, not null
  primary key (group_id, recipient_id)
```

### Alerts
The thing an operator submits. `target` is `jsonb` on purpose — either
`{"type":"group","groupId":"..."}` or `{"type":"polygon","geojson":{...}}`.
Keeping targeting as one flexible column means a new targeting mode later is
a fanout-worker change, not an API version bump.

```
alerts
  id               uuid pk
  tenant_id        uuid fk -> tenants, not null
  created_by       uuid fk -> users, not null
  title            text not null
  body             text not null
  priority         text not null default 'normal'
                     check in ('low','normal','high','critical')
  channels         text[] not null            -- subset of {sms,email}
  target           jsonb not null
  status           text not null default 'accepted'
                     check in ('accepted','expanding','dispatching',
                               'completed','failed')
  idempotency_key  text
  accepted_at      timestamptz not null default now()
  completed_at     timestamptz
  unique (tenant_id, idempotency_key)
```

### Deliveries
One row per recipient per channel per alert — the per-recipient outcome the
challenge explicitly requires the dispatch worker to record.

```
deliveries
  id                 uuid pk
  tenant_id          uuid fk -> tenants, not null
  alert_id           uuid fk -> alerts, not null
  recipient_id       uuid fk -> recipients, not null
  channel            text not null check in ('sms','email')
  status             text not null default 'pending'
                       check in ('pending','delivered','failed',
                                 'rate_limited','timed_out')
  attempt_count      integer not null default 0
  provider_response  jsonb
  created_at         timestamptz not null default now()
  updated_at         timestamptz not null default now()
  delivered_at       timestamptz
  unique (alert_id, recipient_id, channel)
```

### idempotency_keys
Supports safe retries of `POST /alerts` from the client without double-
submitting an alert.

```
idempotency_keys
  key         text not null
  tenant_id   uuid fk -> tenants, not null
  alert_id    uuid fk -> alerts, not null
  created_at  timestamptz not null default now()
  primary key (tenant_id, key)
```

### alert_outbox
Durably records one fanout event per accepted alert so a database-success/SQS-
failure boundary cannot permanently strand the alert. Publication is at least
once: a stable `eventId` lets the fanout worker handle a duplicate safely if a
publisher crashes after SQS accepts a message but before success is recorded.

```
alert_outbox
  id             uuid pk
  tenant_id      uuid fk -> tenants, not null
  alert_id       uuid fk -> alerts, unique, not null
  payload        jsonb not null
  attempt_count  integer not null default 0
  available_at   timestamptz not null default now()
  published_at   timestamptz
  last_error     text
  claim_token    uuid
  claimed_until  timestamptz
  created_at     timestamptz not null default now()
```

Partial index on `(tenant_id, available_at)` where `published_at IS NULL`.

### Row-level security (required, not optional)

Every tenant-scoped table (`users`, `groups`, `recipients`, `group_members`,
`alerts`, `deliveries`, `idempotency_keys`, `alert_outbox`) gets:

```sql
ALTER TABLE <table> ENABLE ROW LEVEL SECURITY;
ALTER TABLE <table> FORCE ROW LEVEL SECURITY;  -- applies even to the table owner
CREATE POLICY tenant_isolation_<table> ON <table>
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
```

The running services connect as a dedicated low-privilege `app_user` role
(not the migration-owner role) so `FORCE ROW LEVEL SECURITY` actually applies
to them. Every request handler wraps its queries in a transaction that runs
`SET LOCAL app.current_tenant = $1` before touching any tenant-scoped table.
`current_setting(..., true)` returns `NULL` when unset, and `tenant_id = NULL`
is never true — so an unscoped connection sees zero rows, not everything.
Isolation fails closed, not open.

**Two acceptance tests to build — isolation is proven at two independent
layers, and both need to pass on their own:**

1. **App layer:** authenticate as a user in tenant A, request
   `GET /api/v1/alerts/:id` using a known alert id that belongs to tenant B.
   Assert `404`, not `403` — tenant B's data shouldn't even register as
   "exists, but you can't see it."
2. **Database layer:** as `app_user` (not the migration-owner role), scope a
   session to tenant B and query `WHERE tenant_id = <tenant A's id>` directly.
   It must return zero rows.

The second test is the one that matters more. It bypasses the app layer
entirely — if application code has a bug and forgets a `WHERE tenant_id = $1`
clause, or the JWT scoping logic has a hole, RLS has to hold anyway. A test
that only exercises the API can pass because the API happens to be written
correctly today; the database-level test proves isolation is structural, not
a matter of nobody having introduced a bug yet.

---

## 5. API contract

Base path `/api/v1`. All routes except health/metrics require
`Authorization: Bearer <jwt>` with `tenant_id` and `sub` (user id) claims.

The demo UI obtains that token through `POST /api/auth/login` with an email and
password. A narrowly scoped, execute-restricted `SECURITY DEFINER` function
resolves the globally unique email to the minimum user and tenant fields needed
for authentication before the tenant is known. All post-login tenant work still
uses `withTenant()` and forced RLS. Login rejects inactive tenants and issues the
same HS256 claim contract. This is demo authentication only; signup, password
reset, refresh tokens, and external IAM remain out of scope.

```
POST   /api/v1/alerts
  body: { title, body, priority?, channels: ["sms"|"email"][], target }
  target: { type: "group", groupId } | { type: "polygon", geojson: <GeoJSON Polygon> }
  header (optional): Idempotency-Key
  -> 202 { alertId, idempotencyKey, replayed }

GET    /api/v1/alerts
  -> [{ id, title, priority, status, channels, acceptedAt, completedAt }]

GET    /api/v1/alerts/:id
  -> { alert, deliveryCounts: [{ status, count }] }

GET    /api/v1/alerts/:id/deliveries
  -> [{ id, channel, status, attemptCount, updatedAt, deliveredAt, recipientName }]

GET    /api/v1/groups
  -> [{ id, name, memberCount }]

GET    /healthz     -- liveness only, no DB check
GET    /readyz       -- DB reachability check
GET    /metrics       -- Prometheus exposition format
```

Validation happens with Zod at the API boundary and returns `400` with a
structured error on failure. The intake transaction writes the alert,
idempotency record, and one durable outbox event. A publisher asynchronously
forwards the outbox event to SQS. Recipient expansion never happens inline in
the request handler — that's the whole reason `POST /alerts` stays fast under
burst.

---

## 6. Targeting resolution (fanout worker)

Given an alert's `target`, resolve to a list of recipient ids:

**Group target:**
```sql
SELECT recipient_id FROM group_members
WHERE group_id = $1 AND tenant_id = $2;
```

**Polygon target:**
```sql
SELECT id FROM recipients
WHERE tenant_id = $1
  AND location IS NOT NULL
  AND ST_Contains(
    ST_SetSRID(ST_GeomFromGeoJSON($2), 4326),
    location::geometry
  );
```

For every resolved recipient, create a `pending` delivery row for every
requested channel (so the UI has something to poll immediately), then enqueue
one dispatch job per recipient per channel:
`{ alertId, tenantId, recipientId, channel }`.

---

## 7. Provider stubs

Two channels: SMS and email. Each is an Express route
(`POST /sms/send`, `POST /email/send`) with its own "personality" — the
stub quality is explicitly what the challenge grades the rest of the burst
and chaos testing against, so don't make these return instant success.

Each provider needs:
- **Baseline latency range** (random within a min/max per call)
- **Baseline failure rate** (random chance of a `502`-style failure)
- **Rate limiting** — a token bucket; an empty bucket returns `429` with a
  `Retry-After` header
- **A correlated degradation window** — occasionally, a call rolls into a
  `degradeUntil` timestamp 30–90 seconds in the future. Every call during that
  window uses a worse latency range and a higher failure rate, then the
  provider recovers. This is what produces a realistic retry storm instead of
  independent per-request noise — and a retry storm is worth having on hand
  for the post-incident report exercise later in the challenge.

Suggested starting personalities:

| Channel | Normal latency | Normal fail rate | Degraded latency | Degraded fail rate | Rate limit |
|---|---|---|---|---|---|
| SMS | 100–300ms | 2% | 800ms–2s | 35% | 50 capacity / 30 per sec refill |
| Email | 300–900ms | 1% | 2–5s | 15% | 200 capacity / 100 per sec refill |

Email should also have a small chance (~1%) of hanging for 25–32 seconds
instead of responding at all — this is what proves the dispatch worker's
client-side request timeout actually fires instead of quietly tying up a
queue consumer.

The dispatch worker calls the relevant stub, and on a transient outcome
(`failed`, `rate_limited`, `timed_out`) increments the delivery's
`attempt_count` and leaves the SQS message undeleted so it's redelivered
after the visibility timeout — that's retry/backoff for free from the queue,
capped at a fixed max attempt count (5 is reasonable) before it's marked
permanently `failed` and left alone.

---

## 8. Frontend (web/)

Four screens, no more:

1. **Login / tenant switcher** — seeded demo credentials obtain a JWT with a
   `tenant_id` claim without exposing raw token entry; hardcoded dev users per
   tenant are fine, this isn't the part being evaluated.
2. **Compose** — title, body, priority, channel checkboxes (SMS/email),
   target picker: dropdown of saved groups, or draw-a-polygon-on-a-map mode
   using **MapLibre GL JS** (open-source, no API key/account required) with
   **OpenFreeMap** as the vector tile source (also free, no key) and
   **Terra Draw** for the polygon drawing tool — Terra Draw is built to work
   across map providers including MapLibre and outputs standard GeoJSON,
   which drops straight into the `target.geojson` field in the alert
   payload. This combination was chosen specifically to keep "clone and
   run" true with zero credentials for every collaborator on the repo,
   while still looking presentation-ready — this project is going in a
   public portfolio repo, so map polish is worth the small extra setup
   over Leaflet.
3. **Alert list** — tenant's alerts, status, submitted time, link into detail.
4. **Alert detail** — per-recipient delivery table, per-channel success/fail
   counts, polling every 2 seconds while the alert is `dispatching`. This is
   the demo moment — the table filling in row by row while dispatch churns
   through the queue is the thing worth spending polish on.

No Redux, no component library beyond maybe Tailwind for layout. Keep it
plain fetch against the API contract in section 5.

---

## 9. Seed data

This is a demo, so the seed data needs to look like a real dataset, not five
rows of `test1`/`test2`. Seed at least two tenants (different `tenant_type`
values, e.g. a county EM office and a school district), each with:

- 1 tenant admin user and 1 operator user
- 2–3 groups with meaningfully different membership
- 150–300 recipients per tenant, each with a real-looking name, phone, email,
  and a `location` point scattered across a real metro area's bounding box
  (enough spread that a modest polygon only catches a subset — if every
  recipient clusters in one block, the polygon query has nothing interesting
  to prove)

The point of this volume: burst-load testing later in the challenge needs a
target audience big enough that fan-out and dispatch actually have work to
do, and the polygon-targeting demo needs a recipient distribution where
"inside this shape" vs. "outside this shape" is a visibly different set.

---

## 10. Local dev

`docker-compose.yml` should bring up: Postgres+PostGIS, ElasticMQ (with the
`alert-fanout` and `recipient-dispatch` queues pre-defined, plus a DLQ with a
redrive policy after 5 failed attempts), the four backend services, the
provider stubs, and the web app — one command, no manual steps. Migrations
run as a one-shot service before anything else starts; seeding runs after
migrations.

`README.md` at minimum needs: prerequisites, `docker compose up`, demo login
credentials, and exact steps for group and polygon targeting.

---

## 11. What this spec deliberately leaves out

Out of scope for this app (owned by other roles in the challenge, or
genuinely not needed for a demo):

- Real auth/signup flow, password reset, MFA — hardcoded seeded dev users
  are enough.
- Voice channel.
- Any cloud SDK calls beyond SQS (no direct S3, no direct Secrets Manager
  calls from app code — secrets arrive via environment variables injected by
  the platform layer).
- Multi-region, cross-region failover logic in the app itself — that's an
  infrastructure/DR concern, not an application one.
- A polished design system for the frontend — functional and legible beats
  pretty for this challenge.

---

## 12. Definition of done

- `docker compose up` brings up a working system from zero.
- A curl or UI-submitted alert with a group target produces delivery rows
  that reach a terminal state within a few seconds under normal (non-
  degraded) provider conditions.
- A curl or UI-submitted alert with a polygon target resolves to a
  recipient subset visibly smaller than the tenant's full recipient list.
- The RLS cross-tenant test in section 4 passes.
- `/healthz`, `/readyz`, and `/metrics` respond correctly on all four
  services.
- Killing a dispatch worker mid-burst (SIGTERM) doesn't lose an in-flight
  message — it finishes or cleanly hands it back to the queue.
