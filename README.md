# Critical Notification Platform

A demo-grade, multi-tenant alerting system for a platform-engineering bootcamp challenge. Operators submit group or geographic alerts; durable workers expand recipients, call simulated SMS/email providers, and record every delivery.

## Architecture

```text
React/Vite web
  -> intake API + transactional outbox
      -> PostgreSQL/PostGIS (tenant RLS)
      -> alert-fanout queue
          -> fanout worker
              -> recipient-dispatch queue
                  -> dispatch worker
                      -> SMS/email provider stubs
```

The backend is one Node package and image with separate intake, fanout, dispatch, and stub commands. Each role is an independent process/Compose service connected through PostgreSQL, SQS-compatible queues, and HTTP. This is intentional shared-artifact design, not a single runtime service.

**Two layers share this one intake API, but stay architecturally separate:**

- The **admin control plane** (`/api/platform/*` and the `tenant_admin`-gated `/api/v1/{recipients,users}` plus group mutations) does synchronous CRUD directly against Postgres inside `db.withTenant()`/`withPlatformProvisioningTransaction()` transactions. It never touches the outbox, queues, or workers. Recipient address geocoding (`src/intake/geocoder.js`) lives here too — it's a synchronous part of the recipient write path, not something the alerting pipeline ever calls.
- The **alert data plane** (`POST /api/v1/alerts` onward) is the asynchronous, durable-outbox → fanout → dispatch pipeline described below. It only *reads* what the control plane wrote (active recipients, groups, tenants) — it never writes recipient/group/tenant/user data itself.

Keeping them separate means an admin CRUD bug can't corrupt in-flight delivery bookkeeping, and the delivery pipeline's throughput isn't gated by admin request latency.

## Prerequisites

- Git
- Docker Engine with Docker Compose v2
- Ports 3000, 4000, 4001, 5173, 5432, and 9324 available
- Browser Internet access for OpenFreeMap tiles (no account or API key)

Node.js 22+ is needed only for tests or services outside containers.

## Quick Start

```bash
git clone https://github.com/Final-Project-greenbean/Modern-Full-Stack-Challenge.git
cd Modern-Full-Stack-Challenge
cp app/.env.example app/.env
cd app
docker compose up --build
```

Open <http://localhost:5173> after the services become healthy.

Demo-only login:

| Role | Tenant | Email | Password |
|---|---|---|---|
| Platform admin | (all tenants) | `platform-admin@critical-demo.test` | `demo-only-change-me` |
| Tenant admin | Demo County Emergency Management | `admin@demo-county.test` | `demo-only-change-me` |
| Operator | Demo County Emergency Management | `operator@demo-county.test` | `demo-only-change-me` |
| Tenant admin | Demo School District | `admin@demo-school.test` | `demo-only-change-me` |
| Operator | Demo School District | `operator@demo-school.test` | `demo-only-change-me` |

Tenant users sign in with only email and password. Their tenant is resolved automatically from the globally unique email address.

Override the seeded password with `DEMO_USER_PASSWORD` in `app/.env` before first startup or a reseed. These credentials and the local JWT secret(s) are intentionally non-production.

Stop with `docker compose down`. Reset all demo database data with `docker compose down -v` and start again.

## Roles

Three roles, enforced server-side on every request, not just hidden in the UI:

- **`platform_admin`** — lives outside tenant RLS in a dedicated `platform_admins` table (not a tenant, not a special tenant). Signs in at a separate platform login screen with a distinct JWT secret (`PLATFORM_JWT_SECRET`, isolated from tenant tokens by claim shape and signing key). Can list/create/disable tenants and provisions each new tenant's first `tenant_admin` in one atomic transaction. Has no visibility into any tenant's recipients, groups, alerts, or deliveries.
- **`tenant_admin`** — a `users` row under forced tenant RLS, like `operator`. Manages that tenant's recipients (create/edit/deactivate/CSV import/export), groups (create/rename/delete/membership), and additional tenant users (list/create). Can also do everything an operator can.
- **`operator`** — composes and sends alerts (`Compose`, `Alerts`) against the tenant's existing recipients/groups. Cannot see or reach the admin screens (`Recipients`, `Groups` mutation controls, `Team`), including by typing the URL directly — the route itself doesn't exist for that role.

## Admin Workflow

1. **Platform admin** signs in via the "Platform admin sign in" link on the login screen, creates a new tenant with its initial `tenant_admin`'s email in one step (the tenant row and admin user are provisioned atomically — either both are created or neither is).
2. **Tenant admin** signs in with the email just created and the configured demo password, then:
   - Adds recipients one at a time by postal address (see **Recipient location and geocoding** below), or bulk-imports them from a CSV (see below).
   - Creates groups and assigns recipients to them.
   - Edits or deactivates recipients (deactivated recipients are excluded from all future group and polygon targeting, but are never hard-deleted).
   - Creates additional tenant users (operators or more tenant admins).
3. **Operator** signs in and composes alerts against the recipients/groups the tenant admin set up.

### Recipient location and geocoding

A recipient's location is entered as a postal address (address line 1/2, city, state, postal code, country) — that's the primary, normal input. The server geocodes it into the latitude/longitude PostGIS actually uses for polygon targeting, atomically with the address write; editing an address re-geocodes it the same way.

By default (`GEOCODER_PROVIDER=none`), no outbound geocoding calls are made and address entry returns a clear "not configured" error — an intentional default so the local stack never makes surprise network calls. Set `GEOCODER_PROVIDER=nominatim` and a real `GEOCODER_USER_AGENT` in `app/.env` (see `.env.example`) to enable free geocoding via OpenStreetMap's public Nominatim API; note some networks (including some sandboxed/cloud dev environments) get a `403` from Nominatim's own abuse-prevention policy regardless of configuration.

Either way, an **Advanced: manual coordinates** section on the recipient form always lets a tenant admin enter latitude/longitude directly — this is what makes the recipient usable immediately even with geocoding disabled or unavailable, and is also how existing lat/lon-based data keeps working.

### CSV import format

Recipients screen → **Import recipients from CSV**. Columns (any order, case-insensitive header): `name` (required), `email`, `phone`, `address_line1`, `address_line2`, `city`, `state`, `postal_code`, `country`, `group` — plus `latitude`/`longitude`, retained as a manual-override alternative to an address (present coordinates always skip geocoding for that row). A complete address (`address_line1`/`city`/`state`/`postal_code`) is required together if any of them is given; each such row is geocoded individually, so a batch import is paced by whatever rate limit the configured provider enforces. `group` is optional per row:

- blank — the recipient is imported without group membership;
- a name matching an existing group in that tenant — the recipient is imported and added to that group;
- a name that does **not** match an existing group — that row is rejected with a validation error (`Unknown group: '...'`). Groups are never auto-created from a CSV, so a typo or casing mistake can't silently spawn a junk group.

A row whose address can't be geocoded (or whose coordinates are malformed) fails only that row — it's reported in the import summary and never aborts the rest of the batch.

Example:

```csv
name,email,phone,address_line1,city,state,postal_code,group
Jamie Rivera,jamie@example.test,+15551234567,123 Main St,Rochester,IN,46975,Command Staff
Alex Kim,alex@example.test,,,,,,
```

The frontend shows a client-side preview of the parsed rows before you confirm, but the server independently re-parses and re-validates the raw CSV text — the preview is a convenience, never the source of truth.

## Verify Health

```bash
curl http://localhost:3000/healthz
curl http://localhost:3000/readyz
curl http://localhost:3000/metrics
docker compose ps
```

`postgres`, `elasticmq`, `stubs`, `intake`, `fanout`, `dispatch`, and `web` should be healthy. `migrate` and `seed` should show successful completion. Fanout and dispatch expose internal readiness/metrics endpoints on ports 3001 and 3002 inside Compose.

## Repository Map

```text
README.md                  # onboarding and demo workflow
AGENTS.md / CLAUDE.md      # contributor guidance and architecture context
app/
  docker-compose.yml       # complete local stack
  Dockerfile               # shared backend image
  src/intake/              # API and durable outbox publisher
  src/fanout/              # target resolution and delivery creation
  src/dispatch/            # provider calls and outcome bookkeeping
  src/stubs/               # failure-capable provider simulators
  src/shared/              # config, RLS DB wrapper, queue, logs, metrics
  migrations/              # PostgreSQL/PostGIS schema and RLS
  scripts/                 # seed, token helper, live smoke test
  web/                     # independently built React/Vite frontend
  test/integration/        # real PostgreSQL integration coverage
  docs/                    # authoritative spec, decisions, plans, deployment contract
infra/                     # platform module skeletons; not local app runtime
```

## Testing Geographic Alerts

Feature status: **working after fixes**. The browser-to-PostGIS path and the complete login → intake → outbox → fanout → dispatch → delivery path were verified with the frontend's exact preset polygon.

1. Sign in as Demo County and open **Compose**.
2. Enter a title and message, then change **Target** to **Polygon**.
3. Click map vertices and click the first vertex (or press Enter) to finish, or click **Use demo polygon** for the deterministic proof.
4. Submit the alert and open **Alerts** to inspect delivery rows.

The preset is standard GeoJSON `[longitude, latitude]` in SRID 4326 and selects exactly 22 seeded Demo County recipients for one channel. The seed also has an excluded county recipient outside the polygon, an excluded county recipient exactly on its boundary, and a Demo School recipient geographically inside it. `ST_Contains` excludes boundary points; explicit tenant predicates plus RLS exclude the other tenant.

MapLibre GL JS renders OpenFreeMap tiles and Terra Draw creates the Polygon. No API key or map environment variable is required, but live tiles need browser Internet. If tiles are unavailable, the deterministic preset still submits a valid polygon.

Structurally malformed GeoJSON is rejected by intake with `400`. A closed but self-intersecting polygon may be accepted durably, then marked `failed` by fanout after PostGIS validity checking, with no deliveries.

Run the same login-to-dispatch proof non-interactively:

```bash
npm run smoke:local
```

## Local Commands

From `app/`:

```bash
npm test
npm run test:integration
npm run lint
npm run migrate up
npm run seed
npm run intake
npm run fanout
npm run dispatch
npm run stubs
npm run token -- --tenant=demo-county --user=admin@demo-county.test
```

From `app/web/`:

```bash
npm test
npm run lint
npm run build
npm run dev
```

The token helper remains useful for curl and automated tests; normal browser usage never requires viewing or pasting a JWT.

## Runtime Contracts and Reliability

- Intake atomically writes alerts, idempotency records, and outbox events.
- Fanout resolves groups or PostGIS polygons, creates unique deliveries, then publishes stable dispatch jobs.
- Dispatch records provider outcomes and leaves retryable messages for at-least-once redelivery up to the attempt cap.
- Every tenant-owned application query uses `withTenant()`; forced RLS is the independent fail-closed boundary.
- Intake, fanout, and dispatch stop readiness before graceful shutdown and leave interrupted durable work retryable.

See `app/docs/APP_SPEC.md` for the authoritative application contract and
`app/docs/DEPLOYMENT_HANDOFF.md` for the authoritative per-workload deployment
contract: images, commands, variables, secrets, ports, probes, database access,
queue permissions, workload identity, rollout order, and acceptance checks.

## Complete Validation

```bash
cd app
npm test
npm run test:integration
npm run lint
npm --prefix web test
npm --prefix web run lint
npm --prefix web run build
docker compose config --quiet
git diff --check
```
